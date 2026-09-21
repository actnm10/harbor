import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { HttpError, validateName, publicItem } from './lib.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// Selected roots count toward the cap, as do all descendant files and folders.
const MAX_NODES = 10000;
const busy = () => new HttpError(409, 'Files are busy. Try again after the current copy or download finishes.');

export function createFileOperations({ db, config, storage, activeUploads, availableBytes, reserveBytes, releaseBytes, stats }) {
  const locks = new Set(), copies = new Set(), purges = new Set();
  let stopped = false, cleanupPromise;
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = work(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); if (error.message.includes('UNIQUE constraint failed')) throw new HttpError(409, 'A file or folder with that name already exists here.'); throw error; }
  }
  function active(id) {
    if (!uuid.test(id ?? '')) throw new HttpError(404, 'File not found.');
    const row = db.prepare("SELECT * FROM nodes WHERE id=? AND status='ready' AND deleted_at IS NULL").get(id);
    if (!row) throw new HttpError(404, 'File not found.');
    return row;
  }
  function parent(value) {
    if (value === 'root' || value === null) return null;
    const row = active(value);
    if (row.kind !== 'folder') throw new HttpError(404, 'Folder not found.');
    return row.id;
  }
  function tree(id) {
    const rows = db.prepare(`WITH RECURSIVE tree AS (SELECT *,0 AS depth FROM nodes WHERE id=? UNION ALL
      SELECT n.*,t.depth+1 AS depth FROM nodes n JOIN tree t ON n.parent=t.id)
      SELECT * FROM tree LIMIT ?`).all(id, MAX_NODES + 1);
    if (rows.length > MAX_NODES || rows.some(row => row.depth > 64)) throw new HttpError(413, 'Choose a smaller folder tree (up to 10,000 total entries including its root, and 64 folder levels).');
    // Make parent-before-child order explicit for copy insertion and ZIP paths.
    return rows.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  }
  function selection(ids, trashed = false) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !uuid.test(id))) {
      throw new HttpError(400, 'Select between 1 and 100 valid file or folder IDs.');
    }
    const unique = new Set(ids);
    const roots = [...unique].map(id => {
      if (!trashed) return active(id);
      const row = db.prepare("SELECT * FROM nodes WHERE id=? AND status='ready' AND deleted_at IS NOT NULL AND trash_root=1").get(id);
      if (!row) throw new HttpError(404, 'Recycle bin item not found.');
      return row;
    }).filter(row => {
      if (trashed) return true;
      let cursor = row.parent, depth = 0;
      while (cursor) {
        if (unique.has(cursor)) return false;
        if (++depth > 64) throw new HttpError(503, 'The stored folder hierarchy is invalid.');
        cursor = active(cursor).parent;
      }
      return true;
    });
    const groups = roots.map(row => ({ root: row, rows: tree(row.id) }));
    if (groups.reduce((sum, group) => sum + group.rows.length, 0) > MAX_NODES) throw new HttpError(413, 'Choose fewer items (up to 10,000 entries per operation).');
    return groups;
  }
  function assertWritable(id, recursive = false) {
    const ids = recursive && id ? tree(id).map(row => row.id) : [id ?? 'root'];
    if (ids.some(value => locks.has(value))) throw busy();
  }
  function lock(ids) {
    const keys = new Set(ids.map(id => id ?? 'root'));
    if ([...keys].some(id => locks.has(id))) throw busy();
    for (const id of keys) locks.add(id);
    let released = false;
    return () => { if (released) return; released = true; for (const id of keys) locks.delete(id); };
  }
  function depthOf(id) {
    let depth = 0;
    while (id) { if (++depth > 64) throw new HttpError(400, 'Folders can be nested up to 64 levels.'); id = active(id).parent; }
    return depth;
  }
  function displayPath(row) {
    const names = [row.name]; let cursor = row.parent;
    for (let depth = 0; cursor; depth++) {
      if (depth >= 64) throw new HttpError(503, 'The stored folder hierarchy is invalid.');
      const ancestor = active(cursor); names.unshift(ancestor.name); cursor = ancestor.parent;
    }
    return ['My files', ...names].join(' / ');
  }
  function validateDestination(groups, destination, copying) {
    assertWritable(destination);
    const destinationDepth = depthOf(destination);
    const selectedNames = [];
    for (const group of groups) {
      for (const row of group.rows) assertWritable(row.id);
      if (group.rows.some(row => row.id === destination)) throw new HttpError(400, 'A folder cannot be moved or copied into itself.');
      if (group.rows.some(row => row.kind === 'folder' && destinationDepth + row.depth + 1 > 64)) throw new HttpError(400, 'Folders can be nested up to 64 levels.');
      if (selectedNames.some(name => db.prepare('SELECT ? = ? COLLATE NOCASE AS same').get(name, group.root.name).same)) throw new HttpError(409, 'Selected items have conflicting names.');
      selectedNames.push(group.root.name);
      const conflict = db.prepare('SELECT id FROM nodes WHERE parent IS ? AND name=? COLLATE NOCASE AND deleted_at IS NULL').get(destination, group.root.name);
      if (conflict && (copying || conflict.id !== group.root.id)) throw new HttpError(409, 'A file or folder with that name already exists here.');
    }
  }
  async function trash(ids) {
    const groups = selection(ids);
    for (const group of groups) for (const row of group.rows) assertWritable(row.id);
    const now = new Date().toISOString(), pending = [];
    const paths = groups.map(group => displayPath(group.root));
    transaction(() => {
      groups.forEach((group, index) => {
        for (const row of group.rows) {
          if (row.status === 'pending') {
            const transfer = activeUploads.get(row.id);
            if (transfer) pending.push(transfer);
            db.prepare("DELETE FROM nodes WHERE id=? AND status='pending'").run(row.id);
          } else db.prepare('UPDATE nodes SET deleted_at=?,updated_at=? WHERE id=?').run(now, now, row.id);
        }
        db.prepare('UPDATE nodes SET parent=NULL,original_parent=?,original_path=?,trash_root=1 WHERE id=?').run(group.root.parent, paths[index], group.root.id);
      });
    });
    for (const transfer of pending) transfer.controller.abort();
    await Promise.all(pending.map(transfer => transfer.done));
    return { items: groups.map(group => ({ ...publicItem(group.root), deletedAt: now, originalPath: paths[groups.indexOf(group)] })), count: groups.length };
  }
  function trashList() {
    const items = db.prepare("SELECT * FROM nodes WHERE trash_root=1 AND status='ready' ORDER BY deleted_at DESC,id").all().map(row => ({
      ...publicItem(row), deletedAt: row.deleted_at, originalPath: row.original_path, purging: !!row.purge_pending,
    }));
    return { items, stats: stats(), retentionDays: config.trashRetentionDays };
  }
  function restoredName(name, parentId) {
    const exists = value => db.prepare('SELECT id FROM nodes WHERE parent IS ? AND name=? COLLATE NOCASE AND deleted_at IS NULL').get(parentId, value);
    if (!exists(name)) return name;
    const extension = path.extname(name), suffixExtension = Buffer.byteLength(extension) <= 64 ? extension : '';
    const stem = suffixExtension ? name.slice(0, -suffixExtension.length) : name;
    for (let attempt = 1; attempt <= 10000; attempt++) {
      const suffix = ` (restored ${attempt})${suffixExtension}`;
      let prefix = stem;
      while (Buffer.byteLength(prefix + suffix) > 255) prefix = [...prefix].slice(0, -1).join('');
      const candidate = validateName(prefix + suffix);
      if (!exists(candidate)) return candidate;
    }
    throw new HttpError(409, 'Too many files share this restored name. Rename an existing file first.');
  }
  function restore(ids) {
    const groups = selection(ids, true);
    for (const group of groups) {
      if (group.root.purge_pending) throw new HttpError(409, 'This item is already being permanently deleted.');
      for (const row of group.rows) { assertWritable(row.id); if (row.kind === 'file') storage.blobPath(row); }
    }
    return transaction(() => {
      const items = [], now = new Date().toISOString();
      // Parents selected in the same batch are restored first, regardless of selection order.
      const remaining = [...groups];
      while (remaining.length) {
        let index = remaining.findIndex(group => !remaining.some(other => other !== group && other.rows.some(row => row.id === group.root.original_parent)));
        if (index < 0) index = 0;
        const group = remaining.splice(index, 1)[0], row = group.root;
        const original = row.original_parent && db.prepare("SELECT id FROM nodes WHERE id=? AND kind='folder' AND status='ready' AND deleted_at IS NULL").get(row.original_parent);
        let destination = original?.id ?? null;
        assertWritable(destination);
        const depth = depthOf(destination);
        if (group.rows.some(child => child.kind === 'folder' && depth + child.depth + 1 > 64)) destination = null;
        const name = restoredName(row.name, destination);
        db.prepare('UPDATE nodes SET parent=?,name=?,original_parent=NULL,original_path=NULL,trash_root=0 WHERE id=?').run(destination, name, row.id);
        for (const child of group.rows) db.prepare('UPDATE nodes SET deleted_at=NULL,updated_at=? WHERE id=?').run(now, child.id);
        items.push(publicItem({ ...row, parent: destination, name, updated_at: now }));
      }
      return { items, count: items.length };
    });
  }
  function move(ids, value) {
    const groups = selection(ids), destination = parent(value);
    validateDestination(groups, destination, false);
    return transaction(() => {
      const now = new Date().toISOString();
      for (const group of groups) db.prepare('UPDATE nodes SET parent=?,updated_at=? WHERE id=?').run(destination, now, group.root.id);
      return { items: groups.map(group => publicItem({ ...group.root, parent: destination, updated_at: now })), count: groups.length };
    });
  }
  async function openBlob(row) {
    const handle = await open(storage.blobPath(row), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const info = await handle.stat(); if (!info.isFile() || info.size !== row.size) throw new HttpError(503, 'File content is unavailable or unsafe.'); return handle; }
    catch (error) { await handle.close(); throw error; }
  }
  async function copy(ids, value, { signal, authorize = () => {} } = {}) {
    if (stopped) throw new HttpError(503, 'The server is stopping.');
    if (copies.size) throw new HttpError(429, 'Another copy is in progress. Try again shortly.');
    const groups = selection(ids), destination = parent(value);
    validateDestination(groups, destination, true);
    if (groups.some(group => group.rows.some(row => row.status !== 'ready'))) throw new HttpError(409, 'Wait for uploads in the selected folders to finish before copying.');
    const sources = groups.flatMap(group => group.rows.filter(row => row.status === 'ready'));
    let total = 0;
    for (const row of sources) if (row.kind === 'file') { total += row.size; storage.blobPath(row); }
    if (!Number.isSafeInteger(total) || total > availableBytes()) throw new HttpError(507, 'There is not enough storage available for this copy.');
    const storageId = config.activeStorageId, blobDir = storage.locationPath(storageId);
    const release = lock([...sources.map(row => row.id), destination]);
    reserveBytes(total);
    const controller = new AbortController(), cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let finish;
    const operation = { controller, done: new Promise(resolve => { finish = resolve; }) };
    copies.add(operation);
    const newIds = new Map(sources.map(row => [row.id, randomUUID()])), now = new Date().toISOString();
    const roots = new Set(groups.map(group => group.root.id));
    const created = sources.map(row => ({ ...row, id: newIds.get(row.id), parent: roots.has(row.id) ? destination : newIds.get(row.parent), storage_id: storageId, status: 'pending', created_at: now, updated_at: now }));
    let committed = false;
    const check = () => { if (stopped || controller.signal.aborted) throw new HttpError(409, 'Copy canceled.'); authorize(); };
    try {
      check();
      transaction(() => {
        const insert = db.prepare('INSERT INTO nodes(id,parent,name,kind,mime,size,status,created_at,updated_at,storage_id) VALUES(?,?,?,?,?,?,?,?,?,?)');
        for (const row of created) insert.run(row.id, row.parent, row.name, row.kind, row.mime, row.size, row.status, now, now, storageId);
      });
      for (let index = 0; index < sources.length; index++) {
        check(); const row = sources[index], target = created[index];
        if (row.kind !== 'file') continue;
        storage.locationPath(storageId);
        const source = await openBlob(row);
        let output;
        try {
          output = await open(path.join(blobDir, target.id + '.part'), 'wx', 0o600);
          let bytes = 0;
          const buffer = Buffer.allocUnsafe(64 * 1024);
          for (;;) {
            check();
            const { bytesRead } = await source.read(buffer, 0, buffer.length, bytes);
            if (!bytesRead) break;
            if (bytes + bytesRead > row.size) throw new HttpError(503, 'Source file changed during copying.');
            let written = 0;
            while (written < bytesRead) {
              check();
              const { bytesWritten } = await output.write(buffer, written, bytesRead - written, bytes + written);
              if (!bytesWritten) throw new HttpError(503, 'The copied file could not be written completely.');
              written += bytesWritten;
            }
            bytes += bytesRead;
          }
          if (bytes !== row.size) throw new HttpError(503, 'Source file changed during copying.');
          await output.sync();
        } finally { await source.close(); if (output) await output.close(); }
        check(); storage.locationPath(storageId);
        await rename(path.join(blobDir, target.id + '.part'), path.join(blobDir, target.id));
      }
      if (process.platform !== 'win32') { const directory = await open(blobDir, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
      check(); parent(destination);
      for (const row of sources) active(row.id);
      transaction(() => { for (const row of created) db.prepare("UPDATE nodes SET status='ready' WHERE id=? AND status='pending'").run(row.id); });
      committed = true;
      return { items: created.filter(row => [...roots].some(id => newIds.get(id) === row.id)).map(publicItem), count: groups.length };
    } finally {
      if (!committed) {
        transaction(() => { for (const group of groups) db.prepare("DELETE FROM nodes WHERE id=? AND status='pending'").run(newIds.get(group.root.id)); });
        try {
          storage.locationPath(storageId);
          for (const row of created.filter(row => row.kind === 'file')) for (const suffix of ['.part', '']) {
            try { await unlink(path.join(blobDir, row.id + suffix)); } catch (error) { if (error.code !== 'ENOENT') config.logger.error('Incomplete copy retained for startup cleanup:', error); }
          }
        } catch (error) { config.logger.error('Incomplete copy retained until its storage mount is restored:', error); }
      }
      signal?.removeEventListener('abort', cancel);
      releaseBytes(total); release(); copies.delete(operation); finish();
    }
  }
  function purge(ids) {
    if (stopped) return Promise.reject(new HttpError(503, 'The server is stopping.'));
    const promise = purgeWork(ids);
    purges.add(promise);
    promise.finally(() => { purges.delete(promise); }).catch(() => {});
    return promise;
  }
  async function purgeWork(ids) {
    const groups = selection(ids, true);
    const release = lock(groups.flatMap(group => group.rows.map(row => row.id)));
    try {
      // Validate every storage identity before committing any irreversible intent.
      for (const group of groups) for (const row of group.rows) if (row.kind === 'file') storage.locationPath(row.storage_id);
      transaction(() => { for (const group of groups) db.prepare('UPDATE nodes SET purge_pending=1 WHERE id=?').run(group.root.id); });
      for (const group of groups) {
        for (const row of group.rows) if (row.kind === 'file') {
          const candidate = storage.blobPath(row, { requireFile: false });
          try {
            const info = await lstat(candidate);
            if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(503, 'A stored file is unsafe. Restore its storage before emptying the recycle bin.');
            storage.locationPath(row.storage_id);
            await unlink(candidate);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        db.prepare('DELETE FROM nodes WHERE id=? AND purge_pending=1').run(group.root.id);
      }
      return { count: groups.length };
    } catch (error) {
      if (error.status) throw error;
      throw new HttpError(503, 'Permanent deletion could not finish. Restore the storage mount and try again; remaining files stay tracked in the recycle bin.');
    } finally { release(); }
  }
  async function empty() {
    let count = 0;
    for (;;) {
      // Bound each tree independently; the entire bin may exceed a bulk selection's cap.
      const rows = db.prepare('SELECT id FROM nodes WHERE trash_root=1 LIMIT 1').all();
      if (!rows.length) return { count };
      count += (await purge(rows.map(row => row.id))).count;
    }
  }
  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const cutoff = new Date(Date.now() - config.trashRetentionDays * 86400000).toISOString();
      let last = '';
      for (;;) {
        const rows = db.prepare('SELECT id FROM nodes WHERE trash_root=1 AND (deleted_at<=? OR purge_pending=1) AND id>? ORDER BY id LIMIT 100').all(cutoff, last);
        if (!rows.length || stopped) break;
        for (const row of rows) {
          last = row.id;
          try { await purge([row.id]); }
          catch (error) { if (error.status !== 409) config.logger.error('Recycle bin cleanup deferred; files and deletion records remain tracked:', error); }
        }
      }
    })().finally(() => { cleanupPromise = null; });
    return cleanupPromise;
  }
  function archive(ids) {
    const groups = selection(ids);
    if (groups.some(group => group.rows.some(row => row.status !== 'ready'))) throw new HttpError(409, 'Wait for uploads in the selected folders to finish before downloading an archive.');
    const rows = groups.flatMap(group => group.rows.filter(row => row.status === 'ready'));
    const release = lock(rows.map(row => row.id));
    try {
      const entries = [];
      for (const group of groups) {
        const names = new Map();
        for (const row of group.rows.filter(row => row.status === 'ready')) {
          validateName(row.name);
          const name = row.id === group.root.id ? row.name : names.get(row.parent) + '/' + row.name;
          names.set(row.id, name);
          if (row.kind === 'file') storage.blobPath(row);
          entries.push({ name, kind: row.kind, size: row.size, modifiedAt: row.updated_at,
            open: async () => { active(row.id); return openBlob(row); } });
        }
      }
      return { entries, release };
    } catch (error) { release(); throw error; }
  }
  async function close() {
    stopped = true;
    for (const operation of copies) operation.controller.abort();
    await Promise.all([...copies].map(operation => operation.done));
    await Promise.allSettled([...purges]);
    if (cleanupPromise) await cleanupPromise;
  }
  return { active, parent, assertWritable, trash, trashList, restore, move, copy, purge, empty, cleanup, archive, close };
}
