import { createRequire } from 'node:module';
import path from 'node:path';
import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';

// CommonJS includes SheetJS's codepage tables for legacy Excel workbooks.
const XLSX = createRequire(import.meta.url)('xlsx');
export const SPREADSHEET_LIMITS = Object.freeze({ sheets: 20, rows: 200, columns: 50, textBytes: 512 * 1024 });
const MAX_EXPANDED = 40 * 1024 * 1024;
const MAX_XML = 8 * 1024 * 1024;
const invalid = () => { throw new Error('This spreadsheet is damaged, encrypted, or exceeds preview limits.'); };

function cellPosition(address) {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(address);
  if (!match) invalid();
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16384 || row > 1048576) invalid();
  return { row, column };
}

function validateXml(bytes, name, state) {
  let encoding = 'utf-8';
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)) encoding = 'utf-16le';
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)) encoding = 'utf-16be';
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  const ids = new Set();
  parser.on('doctype', invalid);
  parser.on('error', invalid);
  parser.on('opentag', tag => {
    if (++depth > 64 || ++state.nodes > 250000) invalid();
    const attribute = key => Object.values(tag.attributes).find(value => value.local === key)?.value;
    if (tag.local === 'si' && ++state.strings > 100000) invalid();
    if (tag.local === 'row' && attribute('r') !== undefined && !/^[1-9][0-9]{0,6}$/.test(attribute('r'))) invalid();
    if (tag.local === 'c' && attribute('r') !== undefined) cellPosition(attribute('r'));
    if (tag.local === 'sheet' && ['__proto__', 'constructor', 'prototype'].includes(attribute('name'))) invalid();
    if (tag.local === 'Relationship') {
      const id = attribute('Id'), target = attribute('Target');
      if (!id || ids.has(id) || !target) invalid();
      ids.add(id);
      // External hyperlinks are metadata only: SheetJS.read never fetches them.
      if (attribute('TargetMode') === 'External') return;
      const decoded = decodeURIComponent(target.split('#')[0]);
      if (!decoded || /[\\\u0000:?]/.test(decoded)) invalid();
      const source = name === '_rels/.rels' ? '' : name.replace('/_rels/', '/').replace(/\.rels$/, '');
      const base = source ? path.posix.dirname(source) : '';
      const resolved = path.posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(base, decoded));
      if (resolved === '..' || resolved.startsWith('../')) invalid();
      state.targets.add(resolved);
    }
  });
  parser.on('closetag', () => { depth--; });
  parser.write(text).close();
}

// Verify actual decompressed sizes before SheetJS's synchronous ZIP reader runs.
// Every stream is checked, including ignored pictures and other binary parts.
async function checkSpreadsheetZip(bytes) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes,
    { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, result) => error ? reject(error) : resolve(result)));
  return new Promise((resolve, reject) => {
    const state = { nodes: 0, strings: 0, targets: new Set() }, names = new Set();
    let expanded = 0, actual = 0, entries = 0, finished = false;
    const fail = error => { if (finished) return; finished = true; zip.close(); reject(error); };
    zip.on('error', fail);
    zip.on('entry', entry => {
      void (async () => {
        const name = entry.fileName;
        expanded += entry.uncompressedSize;
        if (++entries > 2000 || expanded > MAX_EXPANDED || names.has(name) || name.length > 1024 ||
            name.includes('\u0000') || path.posix.normalize(name) !== name ||
            (entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod)) invalid();
        names.add(name);
        const xml = /\.(xml|rels)$/i.test(name);
        if (xml && entry.uncompressedSize > MAX_XML) invalid();
        const stream = await new Promise((accept, refuse) => zip.openReadStream(entry, (error, value) => error ? refuse(error) : accept(value)));
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
          actual += chunk.length; size += chunk.length;
          if (actual > MAX_EXPANDED || size > entry.uncompressedSize || (xml && size > MAX_XML)) invalid();
          if (xml) chunks.push(chunk);
        }
        if (size !== entry.uncompressedSize) invalid();
        if (xml) validateXml(Buffer.concat(chunks), name, state);
        zip.readEntry();
      })().catch(fail);
    });
    zip.on('end', () => {
      if (finished) return;
      try {
        if (!names.has('xl/workbook.xml') || !names.has('[Content_Types].xml')) invalid();
        for (const target of state.targets) if (!names.has(target)) invalid();
        finished = true; zip.close(); resolve();
      } catch (error) { fail(error); }
    });
    zip.readEntry();
  });
}

function checkBiff(bytes) {
  // The worker's CFB geometry/sector-chain preflight runs before this function.
  const compound = XLSX.CFB.read(bytes, { type: 'buffer' });
  const workbook = compound.FileIndex.find(entry => entry.name === 'Workbook' || entry.name === 'Book');
  if (!workbook?.content) invalid();
  const data = workbook.content;
  let records = 0;
  for (let offset = 0; offset + 4 <= data.length;) {
    const id = data.readUInt16LE(offset), length = data.readUInt16LE(offset + 2);
    offset += 4;
    if (++records > 250000 || offset + length > data.length) invalid();
    if (id === 0x002f) invalid(); // FILEPASS: encrypted BIFF workbooks.
    if (id === 0x00fc && (length < 8 || data.readUInt32LE(offset + 4) > 100000)) invalid();
    offset += length;
  }
}

export async function createSpreadsheetPreview(bytes, extension) {
  if (extension === '.xlsx') await checkSpreadsheetZip(bytes);
  else if (extension === '.xls') checkBiff(bytes);
  else invalid();
  const workbook = XLSX.read(bytes, {
    type: 'buffer', dense: false, sheetRows: SPREADSHEET_LIMITS.rows + 1,
    sheets: Array.from({ length: SPREADSHEET_LIMITS.sheets }, (_, index) => index),
    cellHTML: false, cellFormula: false, cellStyles: false, bookVBA: false,
    bookDeps: false, bookFiles: false, WTF: true,
  });
  if (!Array.isArray(workbook.SheetNames) || !workbook.SheetNames.length) invalid();
  let remaining = SPREADSHEET_LIMITS.textBytes, shortened = workbook.SheetNames.length > SPREADSHEET_LIMITS.sheets;
  const sheets = [];
  const boundedText = value => {
    const encoded = Buffer.from(value);
    const text = new TextDecoder().decode(encoded.subarray(0, remaining), { stream: true });
    remaining -= Buffer.byteLength(text);
    return { text, truncated: encoded.length > Buffer.byteLength(text) };
  };
  const visibleNames = workbook.SheetNames.slice(0, SPREADSHEET_LIMITS.sheets);
  // Reserve labels before cell content so later sheet tabs remain identifiable.
  const labels = visibleNames.map(name => boundedText(String(name).slice(0, 128)));
  for (const [index, name] of visibleNames.entries()) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) invalid();
    const sheet = workbook.Sheets[name];
    if (!sheet || typeof sheet !== 'object') invalid();
    let truncated = false, height = 0, width = 0;
    const cells = [];
    for (const address of Object.keys(sheet)) {
      if (address.startsWith('!')) continue;
      const { row, column } = cellPosition(address);
      if (row > SPREADSHEET_LIMITS.rows || column > SPREADSHEET_LIMITS.columns) { truncated = true; continue; }
      height = Math.max(height, row); width = Math.max(width, column);
      cells.push({ row, column, cell: sheet[address] });
    }
    if (sheet['!fullref'] || sheet['!ref']) {
      const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref']);
      if (range.e.r >= SPREADSHEET_LIMITS.rows || range.e.c >= SPREADSHEET_LIMITS.columns) truncated = true;
    }
    const boundedName = labels[index];
    truncated ||= boundedName.truncated || String(name).length > 128;
    const rows = Array.from({ length: height }, () => Array(width).fill(''));
    for (const { row, column, cell } of cells) {
      const value = cell?.w ?? (cell?.v === undefined || cell?.v === null ? '' : String(cell.v));
      const result = boundedText(String(value));
      rows[row - 1][column - 1] = result.text;
      truncated ||= result.truncated;
    }
    sheets.push({ name: boundedName.text, rows, startRow: 1, startColumn: 1, truncated });
    shortened ||= truncated;
  }
  return { kind: 'spreadsheet', label: 'Excel preview', sheets, truncated: shortened };
}
