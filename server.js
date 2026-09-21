import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { open, rename, unlink, stat, lstat, realpath } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { HttpError, loadConfig, openDatabase, hashPassword, verifyPassword, validatePassword,
  validateName, mimeForName, canPreview, publicItem, tokenHash, parseRange } from './lib.js';
import { createStorageManager } from './storage.js';
import { createSettingsManager } from './settings.js';
import { createPresentationPreview } from './presentation-preview.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const cookieName = 'harbor_session';

function respond(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  if (status === 204) { res.writeHead(204); res.end(); return; }
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Use application/json for this request.');
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'Encoded request bodies are not supported.');
  const declared = req.headers['content-length'];
  if (declared && Number(declared) > 16384) throw new HttpError(413, 'Request body is too large.');
  const chunks = [];
  let count = 0;
  for await (const chunk of req) {
    count += chunk.length;
    if (count > 16384) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'A JSON object is required.');
  return value;
}

function jsonMutation(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Use application/json for this request.');
  }
}

export async function createApplication(overrides = {}) {
  const config = loadConfig(overrides);
  const db = openDatabase(config.dataDir);
  db.function('casefold', { deterministic: true }, value => typeof value === 'string' ? value.toLowerCase() : value);
  const activeUploads = new Map();
  const loginBuckets = new Map();
  const loginBurstBuckets = new Map();
  let credentialHash = db.prepare('SELECT password_hash FROM owner WHERE id = 1').get()?.password_hash;
  let credentialGeneration = 0;
  let authInFlight = 0, previewsInFlight = 0, presentationsInFlight = 0, reservedBytes = 0, closing = false;
  let storage, settings;
  try {
    storage = createStorageManager(db, config);
    settings = createSettingsManager(db, config, storage, () => ({ usedBytes: stats().usedBytes, reservedBytes }));
    storage.cleanIncomplete();
    db.exec("DELETE FROM nodes WHERE status = 'pending'");
  } catch (error) { db.close(); throw error; }
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());

  function stats() {
    const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind = 'file' THEN size ELSE 0 END), 0) AS usedBytes,
      SUM(CASE WHEN kind = 'file' THEN 1 ELSE 0 END) AS fileCount,
      SUM(CASE WHEN kind = 'folder' THEN 1 ELSE 0 END) AS folderCount,
      SUM(CASE WHEN kind = 'file' AND mime LIKE 'image/%' THEN 1 ELSE 0 END) AS imageCount,
      SUM(CASE WHEN kind = 'file' AND mime LIKE 'video/%' THEN 1 ELSE 0 END) AS videoCount,
      SUM(CASE WHEN kind = 'file' AND mime LIKE 'audio/%' THEN 1 ELSE 0 END) AS audioCount
      FROM nodes WHERE status = 'ready'`).get();
    return { usedBytes: row.usedBytes, maxStorageBytes: config.maxStorageBytes,
      fileCount: row.fileCount ?? 0, folderCount: row.folderCount ?? 0,
      imageCount: row.imageCount ?? 0, videoCount: row.videoCount ?? 0, audioCount: row.audioCount ?? 0 };
  }

  function parentId(value = 'root') {
    if (value === 'root' || value === null) return null;
    if (typeof value !== 'string' || !uuidPattern.test(value)) throw new HttpError(400, 'Invalid folder.');
    const row = db.prepare("SELECT id FROM nodes WHERE id = ? AND kind = 'folder' AND status = 'ready'").get(value);
    if (!row) throw new HttpError(404, 'Folder not found.');
    return value;
  }

  function getNode(id) {
    if (!uuidPattern.test(id)) throw new HttpError(404, 'File not found.');
    const row = db.prepare("SELECT * FROM nodes WHERE id = ? AND status = 'ready'").get(id);
    if (!row) throw new HttpError(404, 'File not found.');
    return row;
  }

  function originCheck(req) {
    if (req.headers.origin !== config.appOrigin) throw new HttpError(403, 'Request origin is not allowed.');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
  }

  function session(req) {
    const cookie = req.headers.cookie ?? '';
    const tokens = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
    if (tokens.length !== 1) throw new HttpError(401, 'Please sign in.');
    const token = tokens[0].slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, 'Please sign in.');
    const hash = tokenHash(token);
    const row = db.prepare('SELECT s.*, o.username, o.role FROM sessions s CROSS JOIN owner o WHERE token_hash = ? AND expires_at > ? AND o.id = 1').get(hash, Date.now());
    if (!row) throw new HttpError(401, 'Your session has expired. Please sign in.');
    return row;
  }

  function csrfCheck(req, activeSession) {
    if (!safeEqual(req.headers['x-csrf-token'], activeSession.csrf_token)) throw new HttpError(403, 'Invalid security token. Refresh the page and try again.');
  }

  function sessionResponse(activeSession) {
    return { user: { username: activeSession.username, role: activeSession.role }, csrfToken: activeSession.csrf_token,
      limits: { maxUploadBytes: config.maxUploadBytes, maxStorageBytes: config.maxStorageBytes } };
  }

  function cookie(value, age) {
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.secureCookie ? '; Secure' : ''}`;
  }

  function clientIP(req) {
    if (config.trustProxy) {
      const forwarded = req.headers['x-real-ip'];
      if (typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function authenticationOwner() {
    const owner = db.prepare('SELECT * FROM owner WHERE id = 1').get();
    if (owner?.password_hash !== credentialHash) {
      credentialHash = owner?.password_hash;
      credentialGeneration++;
      // Offline recovery invalidates failed guesses against the old password.
      // Keep the independent burst guard, including during repeated resets.
      loginBuckets.clear();
    }
    return owner;
  }

  function busyAuthentication(res) {
    res.setHeader('Retry-After', '2');
    throw new HttpError(429, 'Sign-in is busy. Try again shortly.');
  }

  function throttle(req, res) {
    const now = Date.now();
    if (loginBurstBuckets.size > 5000) {
      for (const [key, bucket] of loginBurstBuckets) {
        if (now >= bucket.start + config.loginBurstWindowMs) loginBurstBuckets.delete(key);
      }
    }
    const ip = clientIP(req);
    const keys = [[ip, config.loginBurstAttempts], ['global', config.loginBurstAttempts * 20]];
    if (loginBurstBuckets.size >= 10000 && !loginBurstBuckets.has(ip)) {
      res.setHeader('Retry-After', Math.ceil(config.loginBurstWindowMs / 1000));
      throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
    }
    const buckets = [];
    for (const [key, limit] of keys) {
      let bucket = loginBurstBuckets.get(key);
      if (!bucket || now >= bucket.start + config.loginBurstWindowMs) {
        bucket = { start: now, count: 0 }; loginBurstBuckets.set(key, bucket);
      }
      if (bucket.count >= limit) {
        res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.start + config.loginBurstWindowMs - now) / 1000)));
        throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
      }
      buckets.push(bucket);
    }
    for (const bucket of buckets) bucket.count++;
  }

  function expireFailures(bucket, now) {
    if (bucket.until ? now >= bucket.until : now >= bucket.start + config.loginWindowMs) {
      bucket.start = now; bucket.count = 0; bucket.until = 0;
    }
  }

  function enterAuthentication(req, res) {
    const now = Date.now(), ip = clientIP(req);
    if (loginBuckets.size > 5000) {
      for (const [key, bucket] of loginBuckets) {
        if (!bucket.pending && now >= bucket.until && now >= bucket.start + config.loginWindowMs) loginBuckets.delete(key);
      }
    }
    if (loginBuckets.size >= 10000 && !loginBuckets.has(ip)) {
      res.setHeader('Retry-After', Math.ceil(config.loginWindowMs / 1000));
      throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
    }
    const buckets = [];
    for (const [key, limit] of [[ip, config.loginAttempts], ['global', config.loginAttempts * 20]]) {
      let bucket = loginBuckets.get(key);
      if (!bucket) {
        bucket = { start: now, count: 0, pending: 0, until: 0 }; loginBuckets.set(key, bucket);
      }
      expireFailures(bucket, now);
      if (now < bucket.until) {
        res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.until - now) / 1000)));
        throw new HttpError(429, 'Too many failed sign-in attempts. Try again later.');
      }
      if (bucket.count + bucket.pending >= limit) busyAuthentication(res);
      buckets.push({ bucket, limit });
    }
    if (authInFlight >= 2) busyAuthentication(res);
    for (const { bucket } of buckets) bucket.pending++;
    authInFlight++;
    return { buckets, generation: credentialGeneration };
  }

  function finishAuthentication(attempt, failed) {
    authInFlight--;
    for (const { bucket } of attempt.buckets) bucket.pending--;
    authenticationOwner();
    if (!failed || attempt.generation !== credentialGeneration) return;
    const now = Date.now();
    for (const { bucket, limit } of attempt.buckets) {
      expireFailures(bucket, now);
      bucket.count++;
      if (bucket.count >= limit) bucket.until = now + config.loginBlockMs;
    }
  }

  function insertNode(row) {
    try {
      db.prepare('INSERT INTO nodes(id,parent,name,kind,mime,size,status,created_at,updated_at,storage_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(row.id, row.parent, row.name, row.kind, row.mime, row.size, row.status, row.created_at, row.updated_at, row.storage_id ?? 'original');
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) throw new HttpError(409, 'A file or folder with that name already exists here.');
      throw error;
    }
  }

  async function upload(req, res, url) {
    if (activeUploads.size >= config.maxConcurrentUploads) {
      res.setHeader('Retry-After', '5'); throw new HttpError(429, 'Too many uploads are in progress. Try again shortly.');
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'Encoded uploads are not supported.');
    const name = validateName(url.searchParams.get('name'));
    const parent = parentId(url.searchParams.get('parent') ?? 'root');
    // An administrative change applies only to uploads started afterwards.
    const storageId = config.activeStorageId;
    const blobDir = storage.locationPath(storageId);
    const maxUploadBytes = config.maxUploadBytes;
    const contentLength = req.headers['content-length'];
    const expected = contentLength === undefined ? null : Number(contentLength);
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) throw new HttpError(400, 'Invalid upload size.');
    if (expected !== null && expected > maxUploadBytes) throw new HttpError(413, 'This file exceeds the upload limit.');
    const available = config.maxStorageBytes - stats().usedBytes - reservedBytes;
    if (available < 0 || (expected !== null && expected > available)) throw new HttpError(507, 'There is not enough storage available.');
    const reservation = expected ?? Math.min(maxUploadBytes, available);
    const id = randomUUID(), now = new Date().toISOString();
    const row = { id, parent, name, kind: 'file', mime: mimeForName(name), size: 0,
      status: 'pending', storage_id: storageId, created_at: now, updated_at: now };
    insertNode(row);
    const controller = new AbortController();
    const pending = { controller, done: null };
    let finishPending;
    pending.done = new Promise(resolve => { finishPending = resolve; });
    activeUploads.set(id, pending);
    reservedBytes += reservation;
    let bytes = 0, committed = false;
    const temporary = path.join(blobDir, `${id}.part`), destination = path.join(blobDir, id);
    try {
      const guard = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxUploadBytes || (expected !== null && bytes > expected)) {
          callback(new HttpError(413, 'This file exceeds the upload limit.'));
        } else if (bytes > reservation) {
          callback(new HttpError(507, 'There is not enough storage available.'));
        } else callback(null, chunk);
      } });
      const file = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
      // Do not put the HTTP request in pipeline: on a bounded-upload error the
      // server must still be able to return its useful JSON error response.
      req.pipe(guard);
      const onAbort = () => guard.destroy(new HttpError(400, 'Upload was interrupted.'));
      const onError = error => guard.destroy(error);
      req.once('aborted', onAbort);
      req.once('error', onError);
      try { await pipeline(guard, file, { signal: controller.signal }); }
      finally { req.off('aborted', onAbort); req.off('error', onError); req.unpipe(guard); }
      if (expected !== null && bytes !== expected) throw new HttpError(400, 'Upload size did not match the request.');
      if (closing || controller.signal.aborted || !db.prepare("SELECT id FROM nodes WHERE id=? AND status='pending'").get(id)) {
        throw new HttpError(409, 'The destination folder was deleted during this upload.');
      }
      // Flush the blob before publishing metadata, so a crash cannot publish
      // a partially written upload as a successfully completed file.
      const handle = await open(temporary, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      storage.locationPath(storageId);
      await rename(temporary, destination);
      if (process.platform !== 'win32') {
        const directory = await open(blobDir, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      // A parent may have been removed while the filesystem calls were pending.
      if (closing || controller.signal.aborted || !db.prepare("SELECT id FROM nodes WHERE id=? AND status='pending'").get(id)) {
        throw new HttpError(409, 'The destination folder was deleted during this upload.');
      }
      const updatedAt = new Date().toISOString();
      db.prepare("UPDATE nodes SET size=?,status='ready',updated_at=? WHERE id=?").run(bytes, updatedAt, id);
      committed = true;
      respond(res, 201, publicItem({ ...row, size: bytes, status: 'ready', updated_at: updatedAt }));
    } catch (error) {
      req.resume();
      if (controller.signal.aborted && !req.aborted) throw new HttpError(409, 'The destination folder was deleted during this upload.');
      throw error;
    } finally {
      if (!committed) {
        db.prepare("DELETE FROM nodes WHERE id = ? AND status = 'pending'").run(id);
        try {
          storage.locationPath(storageId);
          for (const candidate of [temporary, destination]) {
            try { await unlink(candidate); } catch (error) { if (error.code !== 'ENOENT') config.logger.error('Could not remove an incomplete upload:', error); }
          }
        } catch (error) {
          config.logger.error('Incomplete upload retained until its original storage mount is restored:', error);
        }
      }
      reservedBytes -= reservation;
      activeUploads.delete(id);
      finishPending();
    }
  }

  async function streamContent(req, res, url, id) {
    const row = getNode(id);
    if (row.kind !== 'file') throw new HttpError(400, 'Folders cannot be downloaded as files.');
    let range;
    try { range = parseRange(req.headers.range, row.size); }
    catch (error) { if (error.status === 416) res.setHeader('Content-Range', `bytes */${row.size}`); throw error; }
    const inline = url.searchParams.get('download') !== '1' && canPreview(row.mime);
    const fallback = row.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const encoded = encodeURIComponent(row.name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Content-Type', inline ? row.mime : 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', range ? range.end - range.start + 1 : row.size);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${row.size}`);
    let handle;
    try { handle = await open(storage.blobPath(row), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, 'File content is unavailable.'); throw error; }
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile() || fileInfo.size !== row.size) { await handle.close(); throw new HttpError(500, 'File content is unavailable.'); }
    res.statusCode = range ? 206 : 200;
    if (req.method === 'HEAD' || row.size === 0) { await handle.close(); res.end(); return; }
    try { await pipeline(handle.createReadStream(range ?? {}), res); }
    catch (error) { if (!req.aborted && !res.destroyed) throw error; }
    finally { await handle.close().catch(() => {}); }
  }

  async function route(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (config.secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url, config.appOrigin);
    const method = req.method;
    if (url.pathname === '/healthz' && (method === 'GET' || method === 'HEAD')) { respond(res, 200, { status: 'ok' }); return; }
    if (url.pathname === '/api/login' && method === 'POST') {
      originCheck(req); throttle(req, res);
      const body = await jsonBody(req);
      const owner = authenticationOwner();
      const attempt = enterAuthentication(req, res);
      const usernameMatches = !!owner && safeEqual(body.username, owner.username);
      let valid;
      try { valid = await verifyPassword(body.password, owner?.password_hash ?? dummyHash); }
      finally { finishAuthentication(attempt, valid === false || (valid === true && !usernameMatches)); }
      if (!owner || !valid || !usernameMatches) throw new HttpError(401, 'Incorrect username or password.');
      // Password reset may happen while scrypt is running in another worker.
      if (db.prepare('SELECT password_hash FROM owner WHERE id=1').get()?.password_hash !== owner.password_hash) throw new HttpError(401, 'Please try signing in again.');
      const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      const sessionCount = db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
      if (sessionCount >= 100) db.exec('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions ORDER BY expires_at LIMIT 1)');
      db.prepare('INSERT INTO sessions(token_hash,csrf_token,expires_at) VALUES(?,?,?)').run(tokenHash(token), csrf, Date.now() + config.sessionHours * 3600000);
      res.setHeader('Set-Cookie', cookie(token, config.sessionHours * 3600));
      respond(res, 200, sessionResponse({ username: owner.username, role: db.prepare('SELECT role FROM owner WHERE id=1').get().role, csrf_token: csrf })); return;
    }
    if (url.pathname.startsWith('/api/')) {
      const activeSession = session(req);
      if (url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/')) {
        if (activeSession.role !== 'admin') throw new HttpError(403, 'Administrator access is required.');
      }
      if (!['GET', 'HEAD'].includes(method)) {
        originCheck(req); csrfCheck(req, activeSession);
        if (!(method === 'PUT' && url.pathname === '/api/upload')) jsonMutation(req);
      }
      if (url.pathname === '/api/session' && method === 'GET') { respond(res, 200, sessionResponse(activeSession)); return; }
      if (url.pathname === '/api/admin/settings' && method === 'GET') { respond(res, 200, settings.snapshot()); return; }
      if (url.pathname === '/api/admin/settings' && method === 'PATCH') {
        const body = await jsonBody(req);
        if (session(req).role !== 'admin') throw new HttpError(403, 'Administrator access is required.');
        respond(res, 200, settings.update(body)); return;
      }
      if (url.pathname === '/api/admin/storage' && method === 'POST') {
        const body = await jsonBody(req);
        if (session(req).role !== 'admin') throw new HttpError(403, 'Administrator access is required.');
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'name')) throw new HttpError(400, 'Provide only the new storage folder name.');
        respond(res, 201, settings.addStorage(body.name)); return;
      }
      if (url.pathname === '/api/logout' && method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(activeSession.token_hash);
        res.setHeader('Set-Cookie', cookie('', 0)); respond(res, 204); return;
      }
      if (url.pathname === '/api/password' && method === 'POST') {
        throttle(req, res);
        const body = await jsonBody(req); validatePassword(body.newPassword);
        const owner = authenticationOwner();
        const attempt = enterAuthentication(req, res);
        let valid, passwordHash;
        try {
          valid = await verifyPassword(body.currentPassword, owner.password_hash);
          if (valid) passwordHash = await hashPassword(body.newPassword);
        } finally { finishAuthentication(attempt, valid === false); }
        if (!valid) throw new HttpError(401, 'The current password is incorrect.');
        if (db.prepare('SELECT password_hash FROM owner WHERE id=1').get()?.password_hash !== owner.password_hash ||
            !db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?').get(activeSession.token_hash, Date.now())) {
          throw new HttpError(401, 'Your session changed. Please sign in again.');
        }
        db.exec('BEGIN IMMEDIATE');
        try { db.prepare('UPDATE owner SET password_hash=? WHERE id=1').run(passwordHash); db.exec('DELETE FROM sessions; COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
        res.setHeader('Set-Cookie', cookie('', 0)); respond(res, 204); return;
      }
      if (url.pathname === '/api/files' && method === 'GET') {
        const parent = parentId(url.searchParams.get('parent') ?? 'root');
        const q = (url.searchParams.get('q') ?? '').trim();
        const type = url.searchParams.get('type') ?? 'all';
        if (q.length > 255 || !['all', 'image', 'video', 'audio', 'documents'].includes(type)) throw new HttpError(400, 'Invalid search filter.');
        const parameters = [];
        let where = "status='ready'";
        if (!q && type === 'all') { where += ' AND parent IS ?'; parameters.push(parent); }
        if (q) { where += ' AND instr(casefold(name), casefold(?)) > 0'; parameters.push(q); }
        if (type !== 'all') {
          where += " AND kind='file'";
          if (type === 'documents') where += " AND mime NOT LIKE 'image/%' AND mime NOT LIKE 'video/%' AND mime NOT LIKE 'audio/%'";
          else { where += ' AND mime LIKE ?'; parameters.push(`${type}/%`); }
        }
        const items = db.prepare(`SELECT * FROM nodes WHERE ${where} ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, name COLLATE NOCASE`).all(...parameters).map(publicItem);
        const breadcrumbs = [];
        let cursor = parent;
        while (cursor) {
          const node = db.prepare('SELECT id,parent,name FROM nodes WHERE id=?').get(cursor);
          if (!node) break;
          breadcrumbs.unshift({ id: node.id, name: node.name }); cursor = node.parent;
        }
        breadcrumbs.unshift({ id: 'root', name: 'My files' });
        respond(res, 200, { items, breadcrumbs, stats: stats() }); return;
      }
      if (url.pathname === '/api/folders' && method === 'POST') {
        const body = await jsonBody(req);
        const parent = parentId(body.parent ?? 'root'), name = validateName(body.name);
        // Bound folder nesting to keep recursive operations and navigation usable.
        let depth = 0, cursor = parent;
        while (cursor) { depth++; cursor = db.prepare('SELECT parent FROM nodes WHERE id=?').get(cursor)?.parent; }
        if (depth >= 64) throw new HttpError(400, 'Folders can be nested up to 64 levels.');
        const now = new Date().toISOString();
        const row = { id: randomUUID(), parent, name, kind: 'folder', mime: '', size: 0, status: 'ready', created_at: now, updated_at: now };
        insertNode(row); respond(res, 201, publicItem(row)); return;
      }
      if (url.pathname === '/api/upload' && method === 'PUT') { await upload(req, res, url); return; }
      const slidesMatch = /^\/api\/files\/([^/]+)\/preview\.pdf$/.exec(url.pathname);
      if (slidesMatch && method === 'GET') {
        const row = getNode(slidesMatch[1]);
        if (row.kind !== 'file') throw new HttpError(400, 'Folders cannot be previewed as presentations.');
        if (presentationsInFlight >= 1) { res.setHeader('Retry-After', '5'); throw new HttpError(429, 'Another slide preview is being prepared. Try again in a moment.'); }
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', abort);
        req.setTimeout(110000);
        presentationsInFlight++;
        try {
          const pdf = await createPresentationPreview({ filePath: storage.blobPath(row), name: row.name, size: row.size,
            socketPath: overrides.presentationRendererSocket ?? process.env.PRESENTATION_RENDERER_SOCKET, signal: controller.signal });
          // Conversion may outlive a password reset or session expiry.
          session(req);
          if (res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Accept-Ranges': 'none',
            'Content-Disposition': 'inline; filename="preview.pdf"', 'Content-Security-Policy': "default-src 'none'; sandbox" });
          res.end(pdf);
        } finally { presentationsInFlight--; res.off('close', abort); }
        return;
      }
      const previewMatch = /^\/api\/files\/([^/]+)\/preview$/.exec(url.pathname);
      if (previewMatch && method === 'GET') {
        const row = getNode(previewMatch[1]);
        if (row.kind !== 'file') throw new HttpError(400, 'Folders cannot be previewed as documents.');
        if (previewsInFlight >= 2) { res.setHeader('Retry-After', '2'); throw new HttpError(429, 'Document previews are busy. Please try again shortly.'); }
        const filePath = storage.blobPath(row);
        const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size !== row.size) throw new HttpError(503, 'File content is unavailable or unsafe.');
          if (previewsInFlight >= 2) { res.setHeader('Retry-After', '2'); throw new HttpError(429, 'Document previews are busy. Please try again shortly.'); }
          previewsInFlight++;
          try {
            const { createTextPreview } = await import('./preview.js');
            respond(res, 200, await createTextPreview({ filePath, name: row.name, size: row.size }));
          } finally { previewsInFlight--; }
        } finally { await handle.close(); }
        return;
      }
      const contentMatch = /^\/api\/files\/([^/]+)\/content$/.exec(url.pathname);
      if (contentMatch && ['GET', 'HEAD'].includes(method)) { await streamContent(req, res, url, contentMatch[1]); return; }
      const nodeMatch = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
      if (nodeMatch && method === 'PATCH') {
        const body = await jsonBody(req), row = getNode(nodeMatch[1]), name = validateName(body.name);
        const mime = row.kind === 'file' ? mimeForName(name) : '';
        const now = new Date().toISOString();
        try { db.prepare('UPDATE nodes SET name=?,mime=?,updated_at=? WHERE id=?').run(name, mime, now, row.id); }
        catch (error) { if (error.message.includes('UNIQUE constraint failed')) throw new HttpError(409, 'A file or folder with that name already exists here.'); throw error; }
        respond(res, 200, publicItem({ ...row, name, mime, updated_at: now })); return;
      }
      if (nodeMatch && method === 'DELETE') {
        const row = getNode(nodeMatch[1]);
        const descendants = db.prepare(`WITH RECURSIVE tree AS (
          SELECT id,kind,status,storage_id FROM nodes WHERE id=? UNION ALL
          SELECT n.id,n.kind,n.status,n.storage_id FROM nodes n JOIN tree t ON n.parent=t.id
        ) SELECT * FROM tree`).all(row.id);
        const deletionPaths = new Map(descendants.filter(child => child.kind === 'file' && child.status === 'ready')
          .map(child => [child.id, storage.blobPath(child, { requireFile: false })]));
        for (const child of descendants) activeUploads.get(child.id)?.controller.abort();
        db.prepare('DELETE FROM nodes WHERE id=?').run(row.id);
        const pending = [];
        for (const child of descendants) {
          if (activeUploads.has(child.id)) pending.push(activeUploads.get(child.id).done);
          if (child.kind === 'file' && child.status === 'ready') {
            try { storage.locationPath(child.storage_id); await unlink(deletionPaths.get(child.id)); }
            catch (error) { if (error.code !== 'ENOENT') config.logger.error('Could not remove a deleted blob:', error); }
          }
        }
        await Promise.all(pending);
        respond(res, 204); return;
      }
      throw new HttpError(404, 'API endpoint not found.');
    }
    if (!['GET', 'HEAD'].includes(method)) throw new HttpError(405, 'Method not allowed.');
    const publicFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'],
      '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'], '/document-preview.js': ['document-preview.js', 'text/javascript; charset=utf-8'],
      '/document-preview.css': ['document-preview.css', 'text/css; charset=utf-8'],
      '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
    let asset = publicFiles[url.pathname];
    let vendor = false;
    if (url.pathname.startsWith('/vendor/pdfjs/')) {
      let relative;
      try { relative = decodeURIComponent(url.pathname.slice('/vendor/pdfjs/'.length)); } catch { throw new HttpError(404, 'Page not found.'); }
      const types = { '.mjs': 'text/javascript; charset=utf-8', '.bcmap': 'application/octet-stream', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream', '.wasm': 'application/wasm' };
      const jsFallbacks = new Set(['wasm/jbig2_nowasm_fallback.js', 'wasm/openjpeg_nowasm_fallback.js']);
      const mime = jsFallbacks.has(relative) ? 'text/javascript; charset=utf-8' : types[path.extname(relative)];
      if (relative === 'wasm/quickjs-eval.wasm' || relative === 'wasm/quickjs-eval.js') throw new HttpError(404, 'Page not found.');
      if (!mime || !relative.split('/').every(segment => /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(segment))) throw new HttpError(404, 'Page not found.');
      asset = ['vendor/pdfjs/' + relative, mime]; vendor = true;
    }
    if (!asset) throw new HttpError(404, 'Page not found.');
    const filePath = path.join(here, 'public', asset[0]);
    let info;
    try { info = await stat(filePath); } catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, 'Page not found.'); throw error; }
    if (!info.isFile()) throw new HttpError(404, 'Page not found.');
    if (vendor) {
      const actual = await realpath(filePath), allowed = path.join(here, 'public', 'vendor', 'pdfjs') + path.sep;
      if ((await lstat(filePath)).isSymbolicLink() || !actual.startsWith(allowed)) throw new HttpError(404, 'Page not found.');
    }
    res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': info.size });
    if (method === 'HEAD') res.end();
    else await pipeline(createReadStream(filePath), res);
  }

  const server = http.createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 15000,
    requestTimeout: 6 * 60 * 60 * 1000, keepAliveTimeout: 5000 }, (req, res) => {
    route(req, res).catch(error => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = error.status ?? (error.code === 'ECONNRESET' ? 400 : error.code === 'ENOSPC' ? 507 : 500);
      if (status === 500) config.logger.error('Request failed:', error);
      // Streaming headers must not survive a pre-stream error response.
      res.removeHeader('Content-Length'); res.removeHeader('Content-Disposition');
      respond(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : error.code === 'ENOSPC' ? 'The server storage is full.' : error.message });
      req.resume();
    });
  });
  // Allow large transfers for six hours, while dropping stalled sockets after
  // one minute without network activity. Streaming uploads are also count-capped.
  server.setTimeout(60000, socket => socket.destroy());
  server.maxConnections = 200;
  server.on('clientError', (error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  let closed;
  async function close() {
    if (closed) return closed;
    closed = (async () => {
      closing = true;
      for (const pending of activeUploads.values()) pending.controller.abort();
      const requestsStopped = new Promise(resolve => {
        if (!server.listening) { resolve(); return; }
        server.close(resolve); server.closeIdleConnections();
      });
      await Promise.all([...activeUploads.values()].map(pending => pending.done));
      server.closeAllConnections();
      await requestsStopped;
      db.close();
    })();
    return closed;
  }
  return { server, close, config };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = await createApplication();
    app.server.listen(app.config.port, app.config.host, () => {
      console.log(`Harbor is listening on ${app.config.host}:${app.config.port}. Public origin: ${app.config.appOrigin}`);
    });
    app.server.on('error', error => { console.error('Server could not start:', error.message); app.close().finally(() => { process.exitCode = 1; }); });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => app.close().then(() => { process.exitCode = 0; }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
