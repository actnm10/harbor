import { mkdirSync, readdirSync, lstatSync, realpathSync, readFileSync, writeFileSync, unlinkSync,
  rmdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './lib.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const markerName = '.harbor-location.json';

function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }

function directory(candidate) {
  try {
    const info = lstatSync(candidate);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(candidate), path.resolve(candidate))) {
      throw new Error('Not a real directory.');
    }
    return candidate;
  } catch { throw new HttpError(503, 'A configured storage directory is missing or unsafe. Restore its mount and restart Harbor.'); }
}

function exists(candidate) {
  try { lstatSync(candidate); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function syncDirectory(candidate) {
  if (process.platform === 'win32') return;
  const descriptor = openSync(candidate, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeMarker(candidate, id) {
  const marker = path.join(candidate, markerName);
  writeFileSync(marker, JSON.stringify({ version: 1, id }), { flag: 'wx', mode: 0o600 });
  const descriptor = openSync(marker, 'r+');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  syncDirectory(candidate);
}

function checkMarker(candidate, id) {
  try {
    const marker = path.join(candidate, markerName), info = lstatSync(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Invalid marker.');
    const value = JSON.parse(readFileSync(marker, 'utf8'));
    if (value.version !== 1 || value.id !== id) throw new Error('Wrong marker.');
  } catch { throw new HttpError(503, 'A configured storage location is missing its identity marker. Restore the correct storage mount.'); }
}

export function validateStorageName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9 ._-]{1,64}$/.test(name) || name !== name.trim() ||
      name === '.' || name === '..' || name.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new HttpError(400, 'Use a folder name of 1–64 letters, numbers, spaces, dots, hyphens, or underscores; no paths or leading/trailing spaces.');
  }
  return name;
}

export function createStorageManager(db, config) {
  const root = config.storageRoot;
  const original = path.join(config.dataDir, 'blobs');
  if (samePath(root, config.dataDir) || samePath(root, original) || root.startsWith(original + path.sep)) {
    throw new Error('STORAGE_ROOT must be separate from DATA_DIR itself and its original blobs folder.');
  }
  const initialized = db.prepare("SELECT value FROM app_meta WHERE key='storage_initialized'").get()?.value === '1';
  if (!exists(original)) {
    if (initialized || db.prepare("SELECT id FROM nodes WHERE kind='file' AND storage_id='original' LIMIT 1").get()) {
      throw new Error('Original storage is missing. Restore DATA_DIR/blobs before starting Harbor.');
    }
    mkdirSync(original, { mode: 0o700 });
  }
  directory(original);
  if (!exists(root)) {
    if (initialized || config.storageRootExplicit) throw new Error('STORAGE_ROOT is missing. Provision or restore the configured mount before starting Harbor.');
    mkdirSync(root, { mode: 0o700 });
  }
  directory(root);
  if (!initialized && !exists(path.join(original, markerName))) writeMarker(original, 'original');
  const savedRootIdentity = db.prepare("SELECT value FROM app_meta WHERE key='storage_root_identity'").get()?.value;
  const rootIdentity = savedRootIdentity ?? `root:${randomUUID()}`;
  if (!savedRootIdentity) db.prepare("INSERT INTO app_meta(key,value) VALUES('storage_root_identity',?)").run(rootIdentity);
  if (!exists(path.join(root, markerName)) && (!savedRootIdentity || !initialized)) writeMarker(root, rootIdentity);
  checkMarker(root, rootIdentity);
  function rootDirectory() { directory(root); checkMarker(root, rootIdentity); }

  function locationPath(id) {
    const location = db.prepare('SELECT * FROM storage_locations WHERE id=?').get(id);
    if (!location) throw new HttpError(503, 'This file references an unavailable storage location.');
    let candidate;
    if (location.id === 'original' && location.relative_path === null) candidate = original;
    else {
      validateStorageName(location.relative_path);
      rootDirectory();
      candidate = path.join(root, location.relative_path);
      if (path.dirname(candidate) !== root) throw new HttpError(503, 'Invalid storage location.');
    }
    directory(candidate);
    checkMarker(candidate, id);
    return candidate;
  }

  // Validate every mount before changing metadata or cleaning any incomplete file.
  for (const row of db.prepare('SELECT id FROM storage_locations').all()) locationPath(row.id);
  db.prepare("INSERT OR REPLACE INTO app_meta(key,value) VALUES('storage_initialized','1')").run();

  function cleanIncomplete() {
    const locations = db.prepare('SELECT id FROM storage_locations').all().map(row => ({ id: row.id, path: locationPath(row.id) }));
    for (const location of locations) {
      const known = new Set(db.prepare("SELECT id FROM nodes WHERE kind='file' AND status='ready' AND storage_id=?").all(location.id).map(row => row.id));
      for (const name of readdirSync(location.path)) {
        const candidate = name.endsWith('.part') ? name.slice(0, -5) : name;
        if (!uuid.test(candidate)) continue;
        const filePath = path.join(location.path, name), info = lstatSync(filePath);
        if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(503, 'An unsafe entry exists in managed file storage.');
        if (name.endsWith('.part') || !known.has(name)) unlinkSync(filePath);
      }
    }
  }

  function blobPath(row, { requireFile = true } = {}) {
    if (!uuid.test(row.id)) throw new HttpError(503, 'Invalid stored file identifier.');
    const candidate = path.join(locationPath(row.storage_id ?? 'original'), row.id);
    if (requireFile) {
      let info;
      try { info = lstatSync(candidate); } catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, 'File content is unavailable.'); throw error; }
      if (!info.isFile() || info.isSymbolicLink() || (row.size !== undefined && row.size !== info.size)) {
        throw new HttpError(503, 'File content is unavailable or unsafe.');
      }
    }
    return candidate;
  }

  function addLocation(name, commit) {
    validateStorageName(name);
    rootDirectory();
    if (db.prepare('SELECT id FROM storage_locations WHERE relative_path=? COLLATE NOCASE').get(name)) throw new HttpError(409, 'That storage folder is already registered.');
    const candidate = path.join(root, name);
    if (path.dirname(candidate) !== root) throw new HttpError(400, 'Invalid storage folder.');
    const alreadyExists = exists(candidate);
    if (alreadyExists) {
      directory(candidate);
      if (readdirSync(candidate).length) throw new HttpError(409, 'That folder is not empty. Choose a new or empty folder.');
    } else mkdirSync(candidate, { mode: 0o700 });
    const id = randomUUID();
    try {
      writeMarker(candidate, id);
      syncDirectory(root);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO storage_locations(id,label,relative_path,created_at) VALUES(?,?,?,?)').run(id, name, name, new Date().toISOString());
        commit(id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return id;
    } catch (error) {
      // Only remove the marker and empty directory created by this attempt.
      directory(candidate);
      try { unlinkSync(path.join(candidate, markerName)); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') config.logger.error('Could not remove unused storage marker:', cleanupError); }
      if (!alreadyExists) { try { rmdirSync(candidate); } catch (cleanupError) { config.logger.error('Could not remove empty storage folder:', cleanupError); } }
      throw error;
    }
  }

  function locations() {
    return db.prepare('SELECT * FROM storage_locations ORDER BY created_at,id').all().map(location => {
      const usage = db.prepare("SELECT COALESCE(SUM(size),0) AS usedBytes,COUNT(*) AS fileCount FROM nodes WHERE kind='file' AND status='ready' AND storage_id=?").get(location.id);
      return { id: location.id, label: location.label, path: locationPath(location.id), ...usage };
    });
  }
  return { root, locationPath, blobPath, addLocation, locations, cleanIncomplete };
}
