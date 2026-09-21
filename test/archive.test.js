import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { EventEmitter, once } from 'node:events';
import yauzl from 'yauzl';
import { prepareArchive, streamArchive, ARCHIVE_MAX_ENTRIES } from '../archive.js';

class Response extends Writable {
  constructor(onWrite) {
    super({ highWaterMark: 1 });
    this.headers = new Map(); this.chunks = []; this.onWrite = onWrite;
  }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), String(value)); }
  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    if (this.onWrite) this.onWrite(chunk, callback);
    else setImmediate(callback);
  }
  bytes() { return Buffer.concat(this.chunks); }
}

function request(method = 'GET') { return Object.assign(new EventEmitter(), { method, aborted: false }); }
function file(name, bytes, overrides = {}) {
  const data = Buffer.from(bytes);
  const calls = { opens: 0, closes: 0, reads: 0 };
  const entry = { name, kind: 'file', size: data.length, modifiedAt: '2026-09-21T12:30:10Z',
    open: async () => {
      calls.opens++;
      return {
        stat: async () => ({ isFile: () => true, size: data.length }),
        read: async (buffer, offset, length, position) => {
          calls.reads++;
          const bytesRead = Math.min(length, Math.max(0, data.length - position));
          data.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead };
        },
        close: async () => { calls.closes++; },
        ...overrides,
      };
    },
  };
  return { entry, calls };
}

// Independent bit-at-a-time implementation checks ZIP CRC fields, while the
// production writer uses Node's native zlib CRC. yauzl independently parses ZIP64.
function independentCrc(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function readZip(bytes) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes,
    { lazyEntries: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  return await new Promise((resolve, reject) => {
    const entries = [];
    zip.on('error', reject);
    zip.on('end', () => resolve(entries));
    zip.on('entry', entry => {
      zip.openReadStream(entry, async (error, stream) => {
        if (error) { zip.close(); reject(error); return; }
        try {
          const chunks = []; for await (const chunk of stream) chunks.push(chunk);
          const data = Buffer.concat(chunks);
          assert.equal(independentCrc(data), entry.crc32, 'ZIP CRC mismatch');
          entries.push({ name: entry.fileName, bytes: data, crc: entry.crc32,
            offset: entry.relativeOffsetOfLocalHeader, size: entry.uncompressedSize });
          zip.readEntry();
        } catch (failure) { zip.close(); reject(failure); }
      });
    });
    zip.readEntry();
  });
}

test('ZIP64 archive round-trips Unicode, empty files/folders and byte-exact files with exact length', async () => {
  const hello = file('資料/京都 + 100%.txt', Buffer.from('123456789'));
  const empty = file('empty.txt', Buffer.alloc(0));
  const binaryBytes = Buffer.from(Array.from({ length: 131329 }, (_, n) => n % 256));
  const binary = file('bytes.bin', binaryBytes);
  const entries = [{ name: '資料', kind: 'folder' }, hello.entry,
    { name: 'empty folder', kind: 'folder' }, empty.entry, binary.entry];
  const response = new Response();
  const length = await streamArchive({ req: request(), res: response, entries });
  const bytes = response.bytes();
  assert.equal(bytes.length, length);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const decoded = await readZip(bytes);
  assert.deepEqual(decoded.map(entry => entry.name), ['資料/', '資料/京都 + 100%.txt', 'empty folder/', 'empty.txt', 'bytes.bin']);
  assert.equal(decoded[1].crc, 0xcbf43926);
  assert.deepEqual(decoded[1].bytes, Buffer.from('123456789'));
  assert.equal(decoded[2].bytes.length, 0);
  assert.deepEqual(decoded[4].bytes, binaryBytes);
  assert.ok(binary.calls.reads > 1, 'Large files must stream across bounded chunks');
  for (const source of [hello, empty, binary]) assert.equal(source.calls.closes, 1);
  assert.equal(bytes.readUInt32LE(bytes.length - 98), 0x06064b50);
});

test('independent ZIP reader detects corrupted payloads and truncated trailers', async () => {
  const response = new Response();
  await streamArchive({ req: request(), res: response, entries: [file('readme.txt', 'known data').entry] });
  const original = response.bytes();
  const changed = Buffer.from(original);
  changed[50 + Buffer.byteLength('readme.txt')] ^= 1;
  await assert.rejects(readZip(changed), /ZIP CRC mismatch/);
  await assert.rejects(readZip(original.subarray(0, -10)));
});

test('HEAD opens no sources, and an empty archive has valid ZIP64 end records', async () => {
  const source = file('file.txt', 'data');
  const plan = await prepareArchive([source.entry]);
  const response = new Response();
  await streamArchive({ req: request('HEAD'), res: response, entries: plan });
  assert.equal(response.bytes().length, 0);
  assert.equal(response.headers.get('content-length'), String(plan.contentLength));
  assert.equal(source.calls.opens, 0);
  const empty = new Response();
  await streamArchive({ req: request(), res: empty, entries: [] });
  assert.equal(empty.bytes().length, 98);
  assert.deepEqual(await readZip(empty.bytes()), []);
});

test('unsafe paths, case/Unicode aliases and file-directory collisions are rejected before output', async () => {
  for (const name of ['/absolute', '../escape', 'a/../b', 'a//b', 'a\\b', 'C:/test', 'name:stream',
    'trailing. ', 'bad\0name', 'bad\ud800name', 'a/./b', 'a/', 'CON', 'a/NUL.txt', 'CoM1.txt',
    'LPT².log', 'CONOUT$', 'why?.txt', 'a*', 'less<than']) {
    await assert.rejects(prepareArchive([file(name, '').entry]), { status: 400 }, name);
  }
  for (const entries of [
    [file('a.txt', '').entry, file('A.txt', '').entry],
    [file('é', '').entry, file('e\u0301', '').entry],
    [file('tree', '').entry, file('tree/child', '').entry],
    [file('tree/child', '').entry, file('Tree/other', '').entry],
    [{ name: 'folder', kind: 'folder' }, { name: 'folder/', kind: 'folder' }],
  ]) await assert.rejects(prepareArchive(entries), { status: 409 });
  const response = new Response();
  await assert.rejects(streamArchive({ req: request(), res: response, entries: [file('../no', '').entry] }), { status: 400 });
  assert.equal(response.headers.size, 0);
  assert.equal(response.bytes().length, 0);
});

test('metadata and aggregate limits reject upfront without touching file sources', async () => {
  await assert.rejects(prepareArchive(Array.from({ length: ARCHIVE_MAX_ENTRIES + 1 }, (_, n) =>
    ({ name: `folder-${n}`, kind: 'folder' }))), { status: 413 });
  await assert.rejects(prepareArchive([file('字'.repeat(32768), '').entry]), { status: 413 });
  await assert.rejects(prepareArchive([file(Array(129).fill('deep').join('/'), '').entry]), { status: 413 });
  const source = file('too-large', ''); source.entry.size = Number.MAX_SAFE_INTEGER;
  await assert.rejects(prepareArchive([source.entry]), { status: 413 });
  assert.equal(source.calls.opens, 0);
  for (const size of [-1, 0.5, Infinity, NaN]) {
    await assert.rejects(prepareArchive([{ ...source.entry, size }]), { status: 400 });
  }
});

test('ZIP64 plans and local headers preserve sizes and offsets across the four-GiB boundary', async () => {
  for (const size of [0xfffffffen, 0xffffffffn, 0x100000000n]) {
    const source = file('large.bin', '');
    source.entry.size = Number(size);
    source.entry.open = async () => ({
      stat: async () => ({ isFile: () => true, size: Number(size) }),
      read: async () => { throw new Error('Header test must cancel before consuming data'); },
      close: async () => { source.calls.closes++; },
    });
    const plan = await prepareArchive([source.entry, file('after', '').entry]);
    assert.equal(plan.entries[1].offset, Number(size) + 50 + 9 + 24);
    assert.ok(plan.contentLength > Number(size));
    const controller = new AbortController();
    const response = new Response((chunk, callback) => { controller.abort(); callback(); });
    await assert.rejects(streamArchive({ req: request(), res: response, entries: plan, signal: controller.signal }));
    const header = response.chunks[0];
    assert.equal(header.readUInt32LE(18), 0xffffffff);
    assert.equal(header.readBigUInt64LE(30 + 9 + 4), size);
    assert.equal(header.readBigUInt64LE(30 + 9 + 12), size);
    assert.equal(source.calls.closes, 1);
  }
});

test('nonregular, changed-size, truncated and unreadable sources abort and close handles', async () => {
  const nonregular = file('directory', '', { stat: async () => ({ isFile: () => false, size: 0 }) });
  const changed = file('changed', 'abc', { stat: async () => ({ isFile: () => true, size: 4 }) });
  const truncated = file('truncated', 'abcdef', { read: async () => ({ bytesRead: 0 }) });
  let stats = 0;
  const growing = file('growing', 'abc', { stat: async () => ({ isFile: () => true, size: ++stats === 1 ? 3 : 4 }) });
  let modified = 0;
  const rewritten = file('rewritten', 'abc', { stat: async () => ({ isFile: () => true, size: 3, mtimeMs: ++modified }) });
  for (const source of [nonregular, changed, truncated, growing, rewritten]) {
    const response = new Response();
    await assert.rejects(streamArchive({ req: request(), res: response, entries: [source.entry] }), { status: 409 });
    assert.equal(source.calls.closes, 1);
    assert.equal(response.destroyed, true);
  }
  const missing = file('missing', ''); missing.entry.open = async () => { throw new Error('missing volume'); };
  await assert.rejects(streamArchive({ req: request(), res: new Response(), entries: [missing.entry] }), /missing volume/);
});

test('slow-consumer cancellation closes the active handle and does not read the entire file', async () => {
  const source = file('large.bin', Buffer.alloc(8 * 1024 * 1024, 0xab));
  const started = new EventEmitter();
  const response = new Response((chunk, callback) => { started.emit('write'); /* intentionally stalled */ });
  const controller = new AbortController();
  const ready = once(started, 'write');
  const result = streamArchive({ req: request(), res: response, entries: [source.entry], signal: controller.signal });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await ready;
  controller.abort();
  await rejected;
  assert.equal(source.calls.closes, 1);
  assert.ok(source.calls.reads <= 2, `unbounded prefetch: ${source.calls.reads}`);
  assert.equal(response.destroyed, true);
});
