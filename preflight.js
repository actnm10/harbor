import { closeSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadConfig } from './lib.js';

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function explainFilesystemError(error, candidate, setting) {
  if (!['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT'].includes(error.code)) return error;
  const location = path.resolve(candidate);
  let guidance;
  if (error.code === 'EROFS') guidance = 'The filesystem is read-only. Mount this directory with write access.';
  else if (error.code === 'ENOSPC' || error.code === 'EDQUOT') guidance = 'The filesystem has no space available or its quota has been reached. Free space or increase its quota.';
  else {
    const user = typeof process.getuid === 'function' ? `UID ${process.getuid()} / GID ${process.getgid()}` : 'the user running Harbor';
    guidance = `Check ownership and read/write access for ${user}.`;
  }
  return new Error(`Harbor cannot access ${location} (${error.code}). ${guidance} In Docker, check the Linux guest directory mapped by ${setting}.`, { cause: error });
}

// Probe a fresh file, never a stored file or identity marker. For an optional
// directory that does not yet exist, check the nearest existing parent instead.
export function checkWritableDirectory(candidate, { allowMissing = false, setting = 'STORAGE_PATH' } = {}) {
  const requested = path.resolve(candidate);
  let directory = requested;
  try {
    for (;;) {
      try {
        const info = lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(directory), directory)) {
          throw new Error(`${requested} must be a real directory without symlink components.`);
        }
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!allowMissing) throw new Error(`${requested} is missing. Provision or restore the mount configured by ${setting} before starting Harbor.`);
        const parent = path.dirname(directory);
        if (parent === directory) throw error;
        directory = parent;
      }
    }
    const probe = path.join(directory, `.harbor-write-check-${randomUUID()}`);
    let descriptor, created = false;
    try {
      descriptor = openSync(probe, 'wx', 0o600);
      created = true;
      writeSync(descriptor, 'Harbor installation check\n');
      fsyncSync(descriptor);
    } finally {
      try { if (descriptor !== undefined) closeSync(descriptor); }
      finally { if (created) unlinkSync(probe); }
    }
  } catch (error) { throw explainFilesystemError(error, requested, setting); }
  return requested;
}

export function checkInstallation(config = loadConfig()) {
  const original = path.join(config.dataDir, 'blobs');
  if (samePath(config.storageRoot, config.dataDir) || samePath(config.storageRoot, original) ||
      config.storageRoot.startsWith(original + path.sep)) {
    throw new Error('STORAGE_ROOT must be separate from DATA_DIR itself and its original blobs folder.');
  }
  checkWritableDirectory(config.dataDir, { allowMissing: true, setting: 'DATA_PATH' });
  checkWritableDirectory(config.storageRoot, { allowMissing: !config.storageRootExplicit, setting: 'STORAGE_PATH' });
  return { dataDir: config.dataDir, storageRoot: config.storageRoot, appOrigin: config.appOrigin };
}
