import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const deriveKey = promisify(scrypt);
const GiB = 1024 ** 3;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function integer(value, label, min, max) {
  if (!['string', 'number'].includes(typeof value)) throw new Error(`${label} must be an integer.`);
  if (typeof value === 'string' && !/^\d+$/.test(value)) throw new Error(`${label} must be an integer.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return result;
}

export function loadConfig(overrides = {}, env = process.env) {
  const nodeEnv = overrides.nodeEnv ?? env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV must be development, test, or production.');
  const appOrigin = overrides.appOrigin ?? env.APP_ORIGIN ?? 'http://localhost:3000';
  let origin;
  try { origin = new URL(appOrigin); } catch { throw new Error('APP_ORIGIN must be an absolute HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== appOrigin) {
    throw new Error('APP_ORIGIN must be an exact origin with no path or trailing slash, e.g. https://files.example.com.');
  }
  if (nodeEnv === 'production' && origin.protocol !== 'https:') throw new Error('Production requires an HTTPS APP_ORIGIN.');
  const trustProxyValue = overrides.trustProxy ?? env.TRUST_PROXY ?? false;
  if (![true, false, 'true', 'false'].includes(trustProxyValue)) throw new Error('TRUST_PROXY must be true or false.');
  const config = {
    dataDir: path.resolve(overrides.dataDir ?? env.DATA_DIR ?? './data'),
    host: overrides.host ?? env.HOST ?? '127.0.0.1',
    port: integer(overrides.port ?? env.PORT ?? 3000, 'PORT', 0, 65535),
    appOrigin, nodeEnv,
    secureCookie: origin.protocol === 'https:',
    trustProxy: trustProxyValue === true || trustProxyValue === 'true',
    maxUploadBytes: integer(overrides.maxUploadBytes ?? env.MAX_UPLOAD_BYTES ?? 10 * GiB, 'MAX_UPLOAD_BYTES', 1, Number.MAX_SAFE_INTEGER),
    maxStorageBytes: integer(overrides.maxStorageBytes ?? env.MAX_STORAGE_BYTES ?? 100 * GiB, 'MAX_STORAGE_BYTES', 1, Number.MAX_SAFE_INTEGER),
    maxConcurrentUploads: integer(overrides.maxConcurrentUploads ?? env.MAX_CONCURRENT_UPLOADS ?? 4, 'MAX_CONCURRENT_UPLOADS', 1, 64),
    sessionHours: integer(overrides.sessionHours ?? env.SESSION_HOURS ?? 12, 'SESSION_HOURS', 1, 720),
    loginAttempts: integer(overrides.loginAttempts ?? 10, 'loginAttempts', 1, 1000),
    loginWindowMs: integer(overrides.loginWindowMs ?? 15 * 60 * 1000, 'loginWindowMs', 1, 86400000),
    loginBlockMs: integer(overrides.loginBlockMs ?? 15 * 60 * 1000, 'loginBlockMs', 1, 86400000),
    loginBurstAttempts: integer(overrides.loginBurstAttempts ?? 30, 'loginBurstAttempts', 1, 10000),
    loginBurstWindowMs: integer(overrides.loginBurstWindowMs ?? 60000, 'loginBurstWindowMs', 1, 86400000),
    logger: overrides.logger ?? console,
  };
  config.storageRoot = path.resolve(overrides.storageRoot ?? env.STORAGE_ROOT ?? path.join(config.dataDir, 'storage'));
  config.storageRootExplicit = overrides.storageRoot !== undefined || env.STORAGE_ROOT !== undefined;
  if (typeof config.host !== 'string' || !config.host.trim()) throw new Error('HOST cannot be empty.');
  return config;
}

export function openDatabase(dataDir) {
  // Check existing ancestors before creating directories, so a misconfigured
  // symlink cannot redirect initialization outside the chosen data tree.
  let ancestor = path.resolve(dataDir);
  for (;;) {
    try {
      const info = lstatSync(ancestor), actual = realpathSync(ancestor);
      const matches = process.platform === 'win32' ? actual.toLowerCase() === ancestor.toLowerCase() : actual === ancestor;
      if (!info.isDirectory() || info.isSymbolicLink() || !matches) throw new Error('DATA_DIR must not use symlink components.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const actualPath = realpathSync(dataDir);
  const samePath = process.platform === 'win32' ? actualPath.toLowerCase() === path.resolve(dataDir).toLowerCase() : actualPath === path.resolve(dataDir);
  if (!lstatSync(dataDir).isDirectory() || lstatSync(dataDir).isSymbolicLink() || !samePath) throw new Error('DATA_DIR must be a real directory without symlink components.');
  for (const name of ['harbor.sqlite', 'harbor.sqlite-wal', 'harbor.sqlite-shm']) {
    try {
      const info = lstatSync(path.join(dataDir, name));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Database files must be regular files without symlinks.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(path.join(dataDir, 'harbor.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS owner (
      id INTEGER PRIMARY KEY CHECK(id = 1), username TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'user'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      parent TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('file', 'folder')),
      mime TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0 CHECK(size >= 0),
      status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready', 'pending')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storage_locations (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, relative_path TEXT UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS nodes_sibling_name ON nodes(COALESCE(parent, ''), name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  `);
  if (!db.prepare('PRAGMA table_info(owner)').all().some(column => column.name === 'role')) {
    db.exec("ALTER TABLE owner ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin','user'))");
  }
  if (!db.prepare('PRAGMA table_info(nodes)').all().some(column => column.name === 'storage_id')) {
    db.exec("ALTER TABLE nodes ADD COLUMN storage_id TEXT NOT NULL DEFAULT 'original'");
  }
  db.prepare("INSERT OR IGNORE INTO storage_locations(id,label,relative_path,created_at) VALUES('original','Original storage',NULL,?)").run(new Date().toISOString());
  db.exec('CREATE INDEX IF NOT EXISTS nodes_storage ON nodes(storage_id)');
  return db;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 15 || password.length > 128) {
    throw new HttpError(400, 'Use a password between 15 and 128 characters.');
  }
  return password;
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 64, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$65536$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 128 || typeof encoded !== 'string') return false;
  const [algorithm, n, r, p, saltHex, hashHex, extra] = encoded.split('$');
  if (algorithm !== 'scrypt' || n !== '65536' || r !== '8' || p !== '1' || extra ||
      !/^[a-f0-9]{32}$/.test(saltHex ?? '') || !/^[a-f0-9]{128}$/.test(hashHex ?? '')) return false;
  const key = await deriveKey(password, Buffer.from(saltHex, 'hex'), 64, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return timingSafeEqual(key, Buffer.from(hashHex, 'hex'));
}

export async function initializeOwner(dataDir, username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.@-]{1,64}$/.test(username)) {
    throw new Error('Username must contain 1–64 letters, numbers, dots, underscores, @ signs, or hyphens.');
  }
  const passwordHash = await hashPassword(password);
  const db = openDatabase(path.resolve(dataDir));
  try {
    if (db.prepare('SELECT id FROM owner').get()) throw new Error('An owner already exists. Use reset-password to change the password.');
    db.prepare('INSERT INTO owner(id, username, password_hash) VALUES(1, ?, ?)').run(username, passwordHash);
  } finally { db.close(); }
}

export async function resetOwnerPassword(dataDir, password) {
  const passwordHash = await hashPassword(password);
  const db = openDatabase(path.resolve(dataDir));
  try {
    const owner = db.prepare('SELECT id, username FROM owner WHERE id = 1').get();
    if (!owner) throw new Error('No owner exists. Run init first.');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE owner SET password_hash = ? WHERE id = 1').run(passwordHash);
      db.exec('DELETE FROM sessions; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { username: owner.username };
  } finally { db.close(); }
}

export function validateName(name) {
  if (typeof name !== 'string') throw new HttpError(400, 'A name is required.');
  const normalized = name.normalize('NFC');
  if (!normalized.isWellFormed() || !normalized.trim() || normalized === '.' || normalized === '..' ||
      /[\\/\u0000-\u001f\u007f]/.test(normalized) || Buffer.byteLength(normalized, 'utf8') > 255) {
    throw new HttpError(400, 'Names must be 1–255 bytes and cannot contain path separators or control characters.');
  }
  return normalized;
}

const mimeTypes = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.flac': 'audio/flac', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/plain',
  '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html',
  '.xml': 'application/xml', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const inlineMimes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/flac']);
export function mimeForName(name) { return mimeTypes[path.extname(name).toLowerCase()] ?? 'application/octet-stream'; }
export function canPreview(mime) { return inlineMimes.has(mime); }
export function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
export function publicItem(row) {
  return { id: row.id, parent: row.parent ?? 'root', name: row.name, kind: row.kind,
    mime: row.mime, size: row.size, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new HttpError(416, 'Requested range is not satisfiable.');
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new HttpError(416, 'Requested range is not satisfiable.');
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
      throw new HttpError(416, 'Requested range is not satisfiable.');
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
