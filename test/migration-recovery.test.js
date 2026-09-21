import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { hashPassword } from '../lib.js';
import { createApplication } from '../server.js';

test('an original database upgrades without losing files, and a complete backup preserves recycle-bin recovery', async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'harbor-migration-recovery-'));
  const originalDir = path.join(scratch, 'original'), restoredDir = path.join(scratch, 'restored');
  await mkdir(path.join(originalDir, 'blobs'), { recursive: true });
  const fileId = randomUUID(), folderId = randomUUID(), payload = Buffer.from('Original user content: café and 日本語\n');
  const password = 'a disposable migration password 2026';
  const db = new DatabaseSync(path.join(originalDir, 'harbor.sqlite'));
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE owner(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,password_hash TEXT NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,csrf_token TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE nodes(id TEXT PRIMARY KEY,parent TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('file','folder')),mime TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0 CHECK(size>=0),status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','pending')),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX nodes_sibling_name ON nodes(COALESCE(parent,''),name COLLATE NOCASE);
    CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO owner VALUES(1,?,?)').run('legacy-owner', await hashPassword(password));
  db.prepare('INSERT INTO app_meta VALUES(?,?)').run('settings', JSON.stringify({
    maxUploadBytes: 1048576, maxStorageBytes: 10485760, maxConcurrentUploads: 4, sessionHours: 1, activeStorageId: 'original',
  }));
  const insert = db.prepare("INSERT INTO nodes VALUES(?,?,?,?,?,?,'ready',?,?)"), date = new Date().toISOString();
  insert.run(folderId, null, 'Existing documents', 'folder', '', 0, date, date);
  insert.run(fileId, folderId, 'Notes.txt', 'file', 'text/plain', payload.length, date, date);
  db.close();
  await writeFile(path.join(originalDir, 'blobs', fileId), payload);

  let app, base, cookie, csrf;
  t.after(async () => { if (app) await app.close(); await rm(scratch, { recursive: true, force: true }); });
  async function start(dataDir) {
    app = await createApplication({ dataDir, host: '127.0.0.1', port: 0, appOrigin: 'http://localhost', nodeEnv: 'test' });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'legacy-owner', password }) });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    const session = await login.json(); csrf = session.csrfToken;
    assert.equal(session.user.role, 'admin');
  }
  async function request(route, method = 'GET', body) {
    return fetch(base + route, { method, headers: { Cookie: cookie, Origin: 'http://localhost', 'X-CSRF-Token': csrf,
      'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  await start(originalDir);
  const settings = await (await request('/api/admin/settings')).json();
  assert.equal(settings.settings.trashRetentionDays, 30);
  assert.equal(settings.settings.maxStorageBytes, 10485760);
  assert.deepEqual(Buffer.from(await (await request(`/api/files/${fileId}/content?download=1`)).arrayBuffer()), payload);
  assert.equal((await request(`/api/files/${folderId}`, 'DELETE')).status, 204);
  assert.equal((await request(`/api/files/${fileId}/content`)).status, 404);
  const replacement = await request('/api/folders', 'POST', { name: 'Existing documents' });
  assert.equal(replacement.status, 201);
  await app.close(); app = null;

  // Copy only after shutdown, as the deployment backup does, including all markers.
  await cp(originalDir, restoredDir, { recursive: true, errorOnExist: true, force: false });
  await start(restoredDir);
  const trash = await (await request('/api/trash')).json();
  assert.equal(trash.items.length, 1); assert.equal(trash.items[0].id, folderId);
  assert.equal(trash.stats.usedBytes, payload.length);
  const restore = await request('/api/trash/restore', 'POST', { ids: [folderId] });
  assert.equal(restore.status, 200, await restore.clone().text());
  const result = await restore.json();
  assert.match(result.items[0].name, /restored 1/);
  assert.equal((await (await request('/api/trash')).json()).items.length, 0);
  const folder = await (await request(`/api/files?parent=${folderId}`)).json();
  assert.equal(folder.items[0].id, fileId);
  assert.deepEqual(Buffer.from(await (await request(`/api/files/${fileId}/content?download=1`)).arrayBuffer()), payload);
  assert.deepEqual(await readFile(path.join(originalDir, 'blobs', fileId)), payload);
});
