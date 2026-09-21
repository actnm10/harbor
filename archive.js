import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';

// STORE preserves an exact length before reading any file. ZIP64 is used for all
// records, so crossing 4 GiB never changes the wire format halfway through a ZIP.
export const ARCHIVE_MAX_ENTRIES = 10_000;
export const ARCHIVE_MAX_NAME_BYTES = 8 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
const MAX_LENGTH = BigInt(Number.MAX_SAFE_INTEGER);
const PLANS = new WeakSet();

function failure(status, message) { return Object.assign(new Error(message), { status }); }

function archiveName(value, kind) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value || value.includes('\\')
      || /[\x00-\x1f\x7f]/u.test(value) || value.startsWith('/') || /^[a-z]:/iu.test(value)) {
    throw failure(400, 'An archive entry has an unsafe path.');
  }
  const name = kind === 'folder' && value.endsWith('/') ? value.slice(0, -1) : value;
  const segments = name.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..'
      || /[<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment)
      || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment))) {
    throw failure(400, 'An archive entry has an unsafe path.');
  }
  const result = name + (kind === 'folder' ? '/' : '');
  const bytes = Buffer.from(result, 'utf8');
  if (bytes.length > 65535 || segments.length > 128) throw failure(413, 'An archive path is too long.');
  return { name: result, bytes, segments };
}

function dosDate(value) {
  const date = value == null ? new Date('1980-01-01T00:00:00Z') : new Date(value);
  if (!Number.isFinite(date.getTime())) throw failure(400, 'An archive entry has an invalid date.');
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
  };
}

/** Collect bounded metadata, reject unsafe/colliding paths, and compute wire length. */
export async function prepareArchive(input, { signal } = {}) {
  const entries = [];
  const paths = new Map();
  let localBytes = 0n;
  let centralBytes = 0n;
  let nameBytes = 0;
  let pathBytes = 0;
  for await (const source of input) {
    signal?.throwIfAborted();
    if (entries.length === ARCHIVE_MAX_ENTRIES) throw failure(413, 'Too many entries for one archive.');
    if (!source || !['file', 'folder'].includes(source.kind)) throw failure(400, 'Invalid archive entry.');
    const { name, bytes, segments } = archiveName(source.name, source.kind);
    nameBytes += bytes.length;
    if (nameBytes > ARCHIVE_MAX_NAME_BYTES) throw failure(413, 'Archive path metadata is too large.');
    // Include implicit ancestor directories to reject case aliases and file/dir
    // collisions even when their explicit directory record appears later.
    for (let depth = 1; depth <= segments.length; depth++) {
      const spelling = segments.slice(0, depth).join('/');
      const key = spelling.normalize('NFC').toLowerCase();
      const leaf = depth === segments.length;
      const kind = leaf ? source.kind : 'folder';
      const existing = paths.get(key);
      if (existing && (existing.spelling !== spelling || existing.kind !== kind || (leaf && existing.explicit))) {
        throw failure(409, 'Selected files have conflicting archive paths.');
      }
      if (!existing) {
        pathBytes += Buffer.byteLength(spelling, 'utf8');
        if (paths.size === ARCHIVE_MAX_ENTRIES || pathBytes > ARCHIVE_MAX_NAME_BYTES) {
          throw failure(413, 'Archive path metadata is too large.');
        }
      }
      paths.set(key, { spelling, kind, explicit: leaf || existing?.explicit || false });
    }
    const size = source.kind === 'folder' ? 0 : source.size;
    if (!Number.isSafeInteger(size) || size < 0 || (source.kind === 'file' && typeof source.open !== 'function')) {
      throw failure(400, 'An archive entry has an invalid size or source.');
    }
    const entry = Object.freeze({ name, nameBytes: bytes, kind: source.kind, size,
      open: source.open, offset: Number(localBytes), ...dosDate(source.modifiedAt) });
    entries.push(entry);
    localBytes += BigInt(50 + bytes.length) + BigInt(size) + (source.kind === 'file' ? 24n : 0n);
    centralBytes += BigInt(74 + bytes.length);
    if (localBytes + centralBytes + 98n > MAX_LENGTH) throw failure(413, 'Archive exceeds the supported total size.');
  }
  signal?.throwIfAborted();
  const plan = Object.freeze({ entries: Object.freeze(entries), contentLength: Number(localBytes + centralBytes + 98n),
    centralOffset: Number(localBytes), centralSize: Number(centralBytes) });
  PLANS.add(plan);
  return plan;
}

function zip64Extra(entry, central) {
  const buffer = Buffer.alloc(central ? 28 : 20);
  buffer.writeUInt16LE(1, 0);
  buffer.writeUInt16LE(buffer.length - 4, 2);
  buffer.writeBigUInt64LE(BigInt(entry.size), 4);
  buffer.writeBigUInt64LE(BigInt(entry.size), 12);
  if (central) buffer.writeBigUInt64LE(BigInt(entry.offset), 20);
  return buffer;
}

function entryHeader(entry, central, crc = 0) {
  const header = Buffer.alloc(central ? 46 : 30);
  header.writeUInt32LE(central ? 0x02014b50 : 0x04034b50, 0);
  const shift = central ? 2 : 0;
  if (central) header.writeUInt16LE((3 << 8) | 45, 4); // UNIX creator, ZIP64.
  header.writeUInt16LE(45, 4 + shift);
  header.writeUInt16LE(0x800 | (entry.kind === 'file' ? 8 : 0), 6 + shift);
  header.writeUInt16LE(0, 8 + shift); // STORE, no compression.
  header.writeUInt16LE(entry.time, 10 + shift);
  header.writeUInt16LE(entry.date, 12 + shift);
  header.writeUInt32LE(crc, 14 + shift);
  header.writeUInt32LE(0xffffffff, 18 + shift);
  header.writeUInt32LE(0xffffffff, 22 + shift);
  header.writeUInt16LE(entry.nameBytes.length, 26 + shift);
  const extra = zip64Extra(entry, central);
  header.writeUInt16LE(extra.length, 28 + shift);
  if (central) {
    header.writeUInt32LE(entry.kind === 'folder' ? 0x41ed0010 : 0x81a40000, 38);
    header.writeUInt32LE(0xffffffff, 42);
  }
  return Buffer.concat([header, entry.nameBytes, extra]);
}

function descriptor(entry, crc) {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32LE(0x08074b50, 0);
  buffer.writeUInt32LE(crc, 4);
  buffer.writeBigUInt64LE(BigInt(entry.size), 8);
  buffer.writeBigUInt64LE(BigInt(entry.size), 16);
  return buffer;
}

function endRecords(plan) {
  const buffer = Buffer.alloc(98);
  buffer.writeUInt32LE(0x06064b50, 0);
  buffer.writeBigUInt64LE(44n, 4);
  buffer.writeUInt16LE((3 << 8) | 45, 12);
  buffer.writeUInt16LE(45, 14);
  buffer.writeBigUInt64LE(BigInt(plan.entries.length), 24);
  buffer.writeBigUInt64LE(BigInt(plan.entries.length), 32);
  buffer.writeBigUInt64LE(BigInt(plan.centralSize), 40);
  buffer.writeBigUInt64LE(BigInt(plan.centralOffset), 48);
  buffer.writeUInt32LE(0x07064b50, 56);
  buffer.writeBigUInt64LE(BigInt(plan.centralOffset + plan.centralSize), 64);
  buffer.writeUInt32LE(1, 72);
  buffer.writeUInt32LE(0x06054b50, 76);
  buffer.writeUInt16LE(0xffff, 84);
  buffer.writeUInt16LE(0xffff, 86);
  buffer.writeUInt32LE(0xffffffff, 88);
  buffer.writeUInt32LE(0xffffffff, 92);
  return buffer;
}

async function* contents(plan, signal) {
  const checksums = new Uint32Array(plan.entries.length);
  for (let index = 0; index < plan.entries.length; index++) {
    signal.throwIfAborted();
    const entry = plan.entries[index];
    if (entry.kind === 'folder') { yield entryHeader(entry, false); continue; }
    let handle;
    try {
      handle = await entry.open();
      signal.throwIfAborted();
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== entry.size) throw failure(409, 'An archive source changed or is not a regular file.');
      yield entryHeader(entry, false);
      let offset = 0;
      while (offset < entry.size) {
        signal.throwIfAborted();
        // Each yielded chunk owns its bytes until the response has consumed it.
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, entry.size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        signal.throwIfAborted();
        if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > buffer.length) {
          throw failure(409, 'An archive source was truncated while reading.');
        }
        offset += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        checksums[index] = crc32(chunk, checksums[index]);
        yield chunk;
      }
      const finalStat = await handle.stat();
      if (!finalStat.isFile() || finalStat.size !== entry.size
          || (stat.mtimeMs != null && finalStat.mtimeMs !== stat.mtimeMs)
          || (stat.ctimeMs != null && finalStat.ctimeMs !== stat.ctimeMs)) {
        throw failure(409, 'An archive source changed while reading.');
      }
      yield descriptor(entry, checksums[index]);
    } finally {
      if (handle) await handle.close();
    }
  }
  for (let index = 0; index < plan.entries.length; index++) {
    signal.throwIfAborted();
    yield entryHeader(plan.entries[index], true, checksums[index]);
  }
  yield endRecords(plan);
}

/** Stream a ZIP response, retaining at most bounded metadata and a few64KiB chunks. */
export async function streamArchive({ req, res, entries, signal }) {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('Archive download cancelled.', 'AbortError'));
  const close = () => { if (!res.writableFinished) abort(); };
  req.on('aborted', abort);
  res.on('close', close);
  const activeSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  try {
    if (req.aborted || res.destroyed) abort();
    const plan = PLANS.has(entries) ? entries : await prepareArchive(entries, { signal: activeSignal });
    activeSignal.throwIfAborted();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Harbor files.zip"');
    res.setHeader('Content-Length', String(plan.contentLength));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'none');
    if (req.method === 'HEAD') { res.end(); return plan.contentLength; }
    await pipeline(Readable.from(contents(plan, activeSignal), { objectMode: false, highWaterMark: CHUNK_SIZE }), res,
      { signal: activeSignal });
    return plan.contentLength;
  } finally {
    req.off('aborted', abort);
    res.off('close', close);
  }
}
