import { parentPort, workerData } from 'node:worker_threads';
import WordExtractor from 'word-extractor';
import yauzl from 'yauzl';

const MAX_EXPANDED = 40 * 1024 * 1024;
const MAX_TEXT_CHARS = 512 * 1024;

// Bound every CFB allocation and traversal before the legacy parser sees it.
// Worker heap limits do not cover Buffer backing memory. The format geometry is
// defined by Microsoft MS-CFB; pointers must resolve within these actual bytes.
function checkOle(bytes) {
  const invalid = () => { throw new Error('Malformed or over-complex compound document.'); };
  const FREE = -1, END = -2, FAT = -3, DIF = -4;
  if (bytes.length < 512 || !bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) invalid();
  const version = bytes.readUInt16LE(26), shift = bytes.readUInt16LE(30);
  if ((version !== 3 && version !== 4) || shift !== (version === 3 ? 9 : 12) ||
      bytes.readUInt16LE(28) !== 0xfffe || bytes.readUInt16LE(32) !== 6 || bytes.readUInt32LE(56) !== 4096) invalid();
  const sectorSize = 2 ** shift, entriesPerSector = sectorSize / 4;
  if (bytes.length % sectorSize || bytes.length < 3 * sectorSize) invalid();
  const sectorCount = bytes.length / sectorSize - 1;
  const fatCount = bytes.readUInt32LE(44), miniFatCount = bytes.readUInt32LE(64), difCount = bytes.readUInt32LE(72);
  const directoryCount = bytes.readUInt32LE(40);
  if (!fatCount || fatCount > sectorCount || miniFatCount > sectorCount || difCount > sectorCount ||
      directoryCount > sectorCount || (version === 3 && directoryCount !== 0)) invalid();
  const isSector = id => Number.isInteger(id) && id >= 0 && id < sectorCount;
  const sector = id => {
    if (!isSector(id)) invalid();
    return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
  };
  const occupied = new Set(), fatIds = [], difIds = [];
  const claim = id => { if (!isSector(id) || occupied.has(id)) invalid(); occupied.add(id); };
  const fatSlot = id => {
    if (fatIds.length < fatCount) { claim(id); fatIds.push(id); }
    else if (id !== FREE) invalid();
  };
  for (let index = 0; index < 109; index++) fatSlot(bytes.readInt32LE(76 + index * 4));
  let dif = bytes.readInt32LE(68);
  if (!difCount && dif !== END && dif !== FREE) invalid();
  if (fatCount > 109 && !difCount) invalid();
  for (let index = 0; index < difCount; index++) {
    claim(dif); difIds.push(dif);
    const block = sector(dif);
    for (let slot = 0; slot < entriesPerSector - 1; slot++) fatSlot(block.readInt32LE(slot * 4));
    dif = block.readInt32LE(sectorSize - 4);
  }
  if (difCount && dif !== END) invalid();
  if (fatIds.length !== fatCount || fatCount * entriesPerSector < sectorCount) invalid();
  const fat = new Int32Array(sectorCount);
  for (let blockIndex = 0; blockIndex < fatIds.length; blockIndex++) {
    const block = sector(fatIds[blockIndex]);
    for (let slot = 0; slot < entriesPerSector; slot++) {
      const index = blockIndex * entriesPerSector + slot, value = block.readInt32LE(slot * 4);
      // Some writers pad unused table slots with zero or END. These cannot be reached: every
      // live pointer is checked against the physical sector count below.
      if (index >= sectorCount) { if (![FREE, END, 0].includes(value)) invalid(); continue; }
      if (!isSector(value) && ![FREE, END, FAT, DIF].includes(value)) invalid();
      fat[index] = value;
    }
  }
  for (const id of fatIds) if (fat[id] !== FAT) invalid();
  for (const id of difIds) if (fat[id] !== DIF) invalid();

  function noCycles(table) {
    const colors = new Uint8Array(table.length);
    for (let start = 0; start < table.length; start++) {
      if (colors[start]) continue;
      const pending = [];
      let cursor = start;
      while (cursor >= 0) {
        if (cursor >= table.length || colors[cursor] === 1) invalid();
        if (colors[cursor] === 2) break;
        colors[cursor] = 1; pending.push(cursor); cursor = table[cursor];
      }
      for (const id of pending) colors[id] = 2;
    }
  }
  noCycles(fat);
  function chain(start, table, claimed, expected) {
    if (start === FREE || start === END) { if (expected !== undefined && expected !== 0) invalid(); return []; }
    const ids = [];
    let cursor = start;
    while (cursor >= 0) {
      if (cursor >= table.length || claimed.has(cursor) || ids.length >= table.length) invalid();
      claimed.add(cursor); ids.push(cursor); cursor = table[cursor];
    }
    if (cursor !== END || (expected !== undefined && ids.length !== expected)) invalid();
    return ids;
  }
  const directoryIds = chain(bytes.readInt32LE(48), fat, occupied, version === 4 ? directoryCount : undefined);
  if (!directoryIds.length || directoryIds.length * sectorSize / 128 > 4096) invalid();
  const directoryBytes = Buffer.concat(directoryIds.map(id => sector(id)));
  const entries = [];
  for (let offset = 0; offset < directoryBytes.length; offset += 128) {
    const type = directoryBytes.readUInt8(offset + 66);
    if (type === 0) { entries.push(null); continue; }
    if (![1, 2, 5].includes(type)) invalid();
    const nameLength = directoryBytes.readUInt16LE(offset + 64);
    if (nameLength < 2 || nameLength > 64 || nameLength % 2 || directoryBytes.readUInt16LE(offset + nameLength - 2) !== 0) invalid();
    const name = directoryBytes.toString('utf16le', offset, offset + nameLength - 2);
    // word-extractor puts storage names in ordinary JavaScript objects.
    if (['__proto__', 'constructor', 'prototype'].includes(name)) invalid();
    const rawSize = directoryBytes.readBigUInt64LE(offset + 120);
    if (rawSize > BigInt(bytes.length) || (type === 1 && rawSize !== 0n)) invalid();
    entries.push({ type, size: Number(rawSize), start: directoryBytes.readInt32LE(offset + 116),
      left: directoryBytes.readInt32LE(offset + 68), right: directoryBytes.readInt32LE(offset + 72), child: directoryBytes.readInt32LE(offset + 76) });
  }
  if (entries[0]?.type !== 5 || entries.some((entry, index) => index && entry?.type === 5)) invalid();
  const root = entries[0];
  if (root.left !== FREE || root.right !== FREE || root.size % 64) invalid();
  for (const entry of entries) {
    if (!entry) continue;
    for (const id of [entry.left, entry.right, entry.child]) if (id !== FREE && (id < 0 || id >= entries.length || !entries[id])) invalid();
    if (entry.type === 2 && entry.child !== FREE) invalid();
  }
  const reachable = new Set(), pendingEntries = [{ id: 0, depth: 0 }];
  while (pendingEntries.length) {
    const { id, depth } = pendingEntries.pop();
    if (depth > 64 || reachable.has(id)) invalid();
    reachable.add(id);
    const entry = entries[id];
    for (const next of [entry.left, entry.right, entry.child]) if (next !== FREE) pendingEntries.push({ id: next, depth: depth + 1 });
  }

  const miniFatIds = chain(bytes.readInt32LE(60), fat, occupied, miniFatCount);
  chain(root.start, fat, occupied, Math.ceil(root.size / sectorSize));
  const miniCount = root.size / 64;
  if (miniCount > miniFatIds.length * entriesPerSector) invalid();
  const miniFat = new Int32Array(miniCount);
  for (let blockIndex = 0; blockIndex < miniFatIds.length; blockIndex++) {
    const block = sector(miniFatIds[blockIndex]);
    for (let slot = 0; slot < entriesPerSector; slot++) {
      const index = blockIndex * entriesPerSector + slot, value = block.readInt32LE(slot * 4);
      if (index >= miniCount) { if (![FREE, END, 0].includes(value)) invalid(); continue; }
      if ((value < 0 && value !== FREE && value !== END) || value >= miniCount) invalid();
      miniFat[index] = value;
    }
  }
  noCycles(miniFat);
  const miniOccupied = new Set();
  for (const id of reachable) {
    const entry = entries[id];
    if (entry.type !== 2) continue;
    if (entry.size < 4096) chain(entry.start, miniFat, miniOccupied, Math.ceil(entry.size / 64));
    else chain(entry.start, fat, occupied, Math.ceil(entry.size / sectorSize));
  }
}

function checkZip(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) { reject(error); return; }
      let expanded = 0, count = 0, hasDocument = false, finished = false;
      const fail = error => { if (finished) return; finished = true; zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('entry', entry => {
        expanded += entry.uncompressedSize;
        count++;
        if (expanded > MAX_EXPANDED || count > 2000 || (entry.generalPurposeBitFlag & 1)) {
          fail(new Error('The document exceeds preview limits or is encrypted.')); return;
        }
        if (entry.fileName === 'word/document.xml') hasDocument = true;
        zip.readEntry();
      });
      zip.on('end', () => {
        if (finished) return;
        finished = true;
        zip.close();
        if (!hasDocument) reject(new Error('This is not a readable Word document.'));
        else resolve();
      });
      zip.readEntry();
    });
  });
}

try {
  const bytes = Buffer.from(workerData.bytes);
  if (workerData.extension === '.xls' || workerData.extension === '.xlsx') {
    if (workerData.extension === '.xls') checkOle(bytes);
    const { createSpreadsheetPreview } = await import('./preview-spreadsheet.js');
    parentPort.postMessage(await createSpreadsheetPreview(bytes, workerData.extension));
  } else {
    if (workerData.extension === '.docx') await checkZip(bytes);
    else checkOle(bytes);
    const document = await new WordExtractor().extract(bytes);
    const sections = [document.getHeaders({ includeFooters: false }), document.getBody(), document.getFootnotes(), document.getEndnotes(), document.getFooters(), document.getTextboxes({ includeHeadersAndFooters: false })].filter(Boolean);
    const text = sections.join('\n\n');
    parentPort.postMessage({ text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS });
  }
} catch {
  const label = workerData.extension === '.xls' || workerData.extension === '.xlsx' ? 'Excel' : 'Word';
  parentPort.postMessage({ error: `This ${label} document could not be previewed. It may be encrypted, damaged, or exceed preview limits. Download it to open it locally.` });
}
