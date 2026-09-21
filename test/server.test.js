import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, symlink, rename, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createApplication } from '../server.js';
import { initializeOwner, resetOwnerPassword, loadConfig } from '../lib.js';

const USERNAME = 'test-owner';
const PASSWORD = 'a long private test password 42';
const NEW_PASSWORD = 'a different private password 73';
const ORIGIN = 'http://localhost';

async function fixture(t, overrides = {}, prepare) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'harbor-test-'));
  await initializeOwner(dataDir, USERNAME, PASSWORD);
  if (prepare) await prepare(dataDir);
  const config = {
    dataDir, host: '127.0.0.1', port: 0, appOrigin: ORIGIN, nodeEnv: 'test',
    maxUploadBytes: 2 * 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024,
    sessionHours: 1, trustProxy: false, loginAttempts: 20,
    logger: { error() {} }, ...overrides,
  };
  let app;
  const f = {
    dataDir, config, cookie: '', csrfToken: '',
    async start() {
      app = await createApplication(config);
      app.server.listen(0, '127.0.0.1');
      await once(app.server, 'listening');
      f.url = `http://127.0.0.1:${app.server.address().port}`;
    },
    async stop() {
      if (app) { const running = app; app = undefined; await running.close(); }
    },
    async request(route, options = {}) {
      const { method = 'GET', json, body, authenticated = true, csrf = true,
        origin = true, headers = {} } = options;
      const requestHeaders = { ...headers };
      if (authenticated && f.cookie) requestHeaders.Cookie ??= f.cookie;
      if (method !== 'GET' && method !== 'HEAD') {
        if (origin) requestHeaders.Origin ??= config.appOrigin;
        if (csrf && f.csrfToken) requestHeaders['X-CSRF-Token'] ??= f.csrfToken;
      }
      if (json !== undefined || (!['GET', 'HEAD'].includes(method) && !route.startsWith('/api/upload'))) {
        requestHeaders['Content-Type'] ??= 'application/json';
      }
      return fetch(f.url + route, {
        method, headers: requestHeaders,
        body: json !== undefined ? JSON.stringify(json) : body,
        redirect: 'manual',
      });
    },
    async login(password = PASSWORD) {
      const response = await f.request('/api/login', {
        method: 'POST', json: { username: USERNAME, password }, authenticated: false, csrf: false,
      });
      if (response.ok) {
        f.cookie = response.headers.get('set-cookie').split(';')[0];
        const session = await response.clone().json();
        f.csrfToken = session.csrfToken;
      }
      return response;
    },
    async folder(name, parent = 'root') {
      const response = await f.request('/api/folders', { method: 'POST', json: { name, parent } });
      assert.equal(response.status, 201, await response.clone().text());
      return response.json();
    },
    async upload(name, content, parent = 'root', mime = 'application/octet-stream') {
      return f.request(`/api/upload?${new URLSearchParams({ name, parent })}`, {
        method: 'PUT', headers: { 'Content-Type': mime }, body: content,
      });
    },
    async file(name, content, parent = 'root', mime) {
      const response = await f.upload(name, content, parent, mime);
      assert.equal(response.status, 201, await response.clone().text());
      return response.json();
    },
    async list(query = '') {
      const response = await f.request('/api/files' + (query ? `?${query}` : ''));
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    },
  };
  t.after(async () => { await f.stop(); await rm(dataDir, { recursive: true, force: true }); });
  await f.start();
  return f;
}

async function expectError(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  const body = await response.json();
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length > 0);
  assert.equal('stack' in body, false);
}

async function delayedLogins(f, passwords) {
  const requests = [], connected = [], completed = [];
  for (const password of passwords) {
    const body = JSON.stringify({ username: USERNAME, password });
    let signalConnected;
    connected.push(new Promise(resolve => { signalConnected = resolve; }));
    completed.push(new Promise((resolve, reject) => {
      const request = http.request(f.url + '/api/login', {
        method: 'POST', headers: {
          Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        },
      }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject);
      request.on('socket', socket => socket.once('connect', signalConnected));
      request.flushHeaders();
      requests.push({ request, body });
    }));
  }
  try {
    await Promise.all(connected);
    // Complete every body's credentials together after the headers have arrived.
    await new Promise(resolve => setTimeout(resolve, 30));
    for (const { request, body } of requests) request.end(body);
    return await Promise.all(completed);
  } finally {
    for (const { request } of requests) request.destroy();
  }
}

test('health is minimal and unauthenticated callers cannot access files or sessions', async t => {
  const f = await fixture(t);
  const health = await f.request('/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  for (const route of ['/api/session', '/api/files', '/api/files/nonexistent/content']) {
    await expectError(await f.request(route), 401);
  }
  for (const cookie of ['harbor_session=invalid', 'harbor_session=%ZZ', 'harbor_session=']) {
    await expectError(await f.request('/api/session', { headers: { Cookie: cookie } }), 401);
  }
  await expectError(await f.request('/api/folders', {
    method: 'POST', json: { parent: 'root', name: 'private' },
  }), 401);
  await expectError(await f.request('/api/upload?name=private.txt&parent=root', {
    method: 'PUT', body: 'private', headers: { 'Content-Type': 'application/octet-stream' },
  }), 401);
});

test('login rejects cross-origin and malformed requests, and issues a private session cookie', async t => {
  const f = await fixture(t);
  const credentials = { username: USERNAME, password: PASSWORD };
  for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: 'null' }]) {
    await expectError(await f.request('/api/login', { method: 'POST', json: credentials, headers }), 403);
  }
  await expectError(await f.request('/api/login', { method: 'POST', json: credentials, origin: false }), 403);
  await expectError(await f.request('/api/login', {
    method: 'POST', body: '{"username":', headers: { 'Content-Type': 'application/json' },
  }), 400);
  const badType = await f.request('/api/login', {
    method: 'POST', body: JSON.stringify(credentials), headers: { 'Content-Type': 'text/plain' },
  });
  assert.ok([400, 415].includes(badType.status));
  const wrong = await f.login('a deliberately wrong password');
  await expectError(wrong, 401);
  const response = await f.login();
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^harbor_session=/);
  assert.match(cookie, /;\s*HttpOnly/i);
  assert.match(cookie, /;\s*SameSite=Strict/i);
  assert.match(cookie, /;\s*Path=\//i);
  assert.doesNotMatch(cookie, /;\s*Secure/i);
  assert.equal(cookie.includes(PASSWORD), false);
  const session = await response.json();
  assert.deepEqual(session.user, { username: USERNAME, role: 'admin' });
  assert.ok(session.csrfToken.length >= 32);
  assert.equal(session.limits.maxUploadBytes, f.config.maxUploadBytes);
  const restored = await f.request('/api/session');
  assert.deepEqual(await restored.json(), session);
  const token = f.cookie.slice(f.cookie.indexOf('=') + 1);
  for (const file of await diskFiles(f.dataDir)) {
    const persisted = await readFile(path.join(f.dataDir, file));
    assert.equal(persisted.includes(Buffer.from(PASSWORD)), false, 'password must not be stored in plaintext');
    assert.equal(persisted.includes(Buffer.from(token)), false, 'session bearer token must be hashed on disk');
  }
});

test('production requires HTTPS and HTTPS-origin sessions use Secure cookies', async t => {
  assert.throws(() => loadConfig({ nodeEnv: 'production', appOrigin: 'http://public.example' }, {}), /https/i);
  const f = await fixture(t, { appOrigin: 'https://files.example.com', nodeEnv: 'production' });
  const login = await f.login();
  assert.equal(login.status, 200, await login.clone().text());
  assert.match(login.headers.get('set-cookie'), /;\s*Secure/i);
});

test('all state changes require an exact origin and session CSRF token; logout revokes the cookie', async t => {
  const f = await fixture(t);
  await f.login();
  const folder = await f.folder('before');
  const mutations = [
    ['/api/folders', { method: 'POST', json: { parent: 'root', name: 'blocked' } }],
    ['/api/upload?parent=root&name=blocked.txt', { method: 'PUT', body: 'blocked' }],
    [`/api/files/${folder.id}`, { method: 'PATCH', json: { name: 'blocked' } }],
    [`/api/files/${folder.id}`, { method: 'DELETE' }],
    ['/api/logout', { method: 'POST' }],
    ['/api/password', { method: 'POST', json: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } }],
  ];
  for (const [route, options] of mutations) {
    await expectError(await f.request(route, { ...options, csrf: false }), 403);
    await expectError(await f.request(route, { ...options, headers: { 'X-CSRF-Token': 'invalid' } }), 403);
    await expectError(await f.request(route, { ...options, headers: { Origin: ORIGIN + '.attacker.example' } }), 403);
    await expectError(await f.request(route, { ...options, origin: false }), 403);
  }
  assert.deepEqual((await f.list()).items.map(item => item.name), ['before']);
  const response = await f.request('/api/logout', { method: 'POST' });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  await expectError(await f.request('/api/session'), 401);
});

test('password changes validate current credentials and revoke every existing session', async t => {
  const f = await fixture(t);
  await f.login();
  const firstCookie = f.cookie;
  await f.login();
  const secondCookie = f.cookie;
  assert.notEqual(firstCookie, secondCookie);
  const rejected = await f.request('/api/password', {
    method: 'POST', json: { currentPassword: 'wrong', newPassword: NEW_PASSWORD },
  });
  assert.ok([400, 401, 403].includes(rejected.status));
  await expectError(await f.request('/api/password', {
    method: 'POST', json: { currentPassword: PASSWORD, newPassword: 'short' },
  }), 400);
  assert.equal((await f.request('/api/password', {
    method: 'POST', json: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
  })).status, 204);
  for (const cookie of [firstCookie, secondCookie]) {
    await expectError(await f.request('/api/session', { headers: { Cookie: cookie } }), 401);
  }
  await expectError(await f.login(), 401);
  assert.equal((await f.login(NEW_PASSWORD)).status, 200);
});

test('files, metadata, and sessions persist across restart; the admin reset revokes access', async t => {
  const f = await fixture(t);
  await f.login();
  const content = Buffer.from([0, 1, 2, 255, 0, 128, 13, 10]);
  const folder = await f.folder('persistent');
  const item = await f.file('persist.bin', content, folder.id);
  const cookie = f.cookie;
  await f.stop();
  await f.start();
  assert.equal((await f.request('/api/session')).status, 200);
  assert.deepEqual((await f.list(`parent=${folder.id}`)).items.map(file => file.id), [item.id]);
  const download = await f.request(`/api/files/${item.id}/content?download=1`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
  await f.stop();
  await resetOwnerPassword(f.dataDir, NEW_PASSWORD);
  await f.start();
  await expectError(await f.request('/api/session', { headers: { Cookie: cookie } }), 401);
  await expectError(await f.login(), 401);
  assert.equal((await f.login(NEW_PASSWORD)).status, 200);
  assert.equal((await f.request(`/api/files/${item.id}/content`)).status, 200);
});

test('folders, breadcrumbs, global search and media filters reflect real stored files', async t => {
  const f = await fixture(t);
  await f.login();
  const folder = await f.folder('Trips');
  const child = await f.folder('京都', folder.id);
  const image = await f.file('Sunset.PNG', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), child.id, 'image/png');
  const video = await f.file('clip.mp4', 'video bytes', folder.id, 'video/mp4');
  const audio = await f.file('song.mp3', 'audio bytes', 'root', 'audio/mpeg');
  const textFile = await f.file('notes.txt', 'hello', 'root', 'text/plain');
  assert.deepEqual(new Set((await f.list()).items.map(item => item.id)), new Set([folder.id, audio.id, textFile.id]));
  const nested = await f.list(`parent=${child.id}`);
  assert.deepEqual(nested.items.map(item => item.id), [image.id]);
  assert.deepEqual(nested.breadcrumbs, [
    { id: 'root', name: 'My files' }, { id: folder.id, name: 'Trips' }, { id: child.id, name: '京都' },
  ]);
  assert.deepEqual((await f.list('q=sUnSeT')).items.map(item => item.id), [image.id]);
  for (const [type, item] of [['image', image], ['video', video], ['audio', audio]]) {
    assert.deepEqual((await f.list(`type=${type}`)).items.map(file => file.id), [item.id]);
  }
  assert.deepEqual((await f.list('type=image&q=missing')).items, []);
  const stats = (await f.list()).stats;
  assert.equal(stats.fileCount, 4);
  assert.equal(stats.folderCount, 2);
  assert.equal(stats.imageCount, 1);
  assert.equal(stats.videoCount, 1);
  assert.equal(stats.audioCount, 1);
  assert.equal(stats.usedBytes, image.size + video.size + audio.size + textFile.size);
  assert.equal(stats.maxStorageBytes, f.config.maxStorageBytes);
  const rename = await f.request(`/api/files/${textFile.id}`, { method: 'PATCH', json: { name: 'renamed.txt' } });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json()).name, 'renamed.txt');
  assert.equal((await f.request(`/api/files/${folder.id}`, { method: 'DELETE' })).status, 204);
  await expectError(await f.request(`/api/files/${image.id}/content`), 404);
  const remaining = (await f.list()).stats;
  assert.equal(remaining.folderCount, 0);
  assert.equal(remaining.fileCount, 2);
  assert.equal(remaining.usedBytes, audio.size + textFile.size);
});

test('duplicate names, invalid parents and filesystem traversal names are rejected without overwrites', async t => {
  const f = await fixture(t);
  await f.login();
  const one = await f.file('one.txt', 'first');
  const two = await f.file('two.txt', 'second');
  await expectError(await f.upload('one.txt', 'replacement'), 409);
  await expectError(await f.request('/api/folders', { method: 'POST', json: { parent: 'root', name: 'one.txt' } }), 409);
  await expectError(await f.request(`/api/files/${two.id}`, { method: 'PATCH', json: { name: 'one.txt' } }), 409);
  for (const name of ['..', '.', '../escape', '..\\escape', 'slash/name', 'slash\\name', '\u0000bad', '\r\ninjected']) {
    await expectError(await f.upload(name, 'unsafe'), 400);
    await expectError(await f.request('/api/folders', { method: 'POST', json: { parent: 'root', name } }), 400);
    await expectError(await f.request(`/api/files/${one.id}`, { method: 'PATCH', json: { name } }), 400);
  }
  for (const parent of ['../outside', one.id, 'missing-id']) {
    const response = await f.upload('orphan.txt', 'bad', parent);
    assert.ok([400, 404].includes(response.status));
  }
  assert.equal(await (await f.request(`/api/files/${one.id}/content`)).text(), 'first');
  assert.equal((await f.list()).stats.fileCount, 2);
});

test('binary downloads and media ranges are byte exact, including suffix and unsatisfiable ranges', async t => {
  const f = await fixture(t);
  await f.login();
  const content = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const item = await f.file('binary.mp4', content, 'root', 'video/mp4');
  const route = `/api/files/${item.id}/content`;
  const full = await f.request(route);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(full.headers.get('content-length')), content.length);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), content);
  for (const [range, start, end] of [['bytes=0-15', 0, 15], ['bytes=240-', 240, 255], ['bytes=-10', 246, 255], ['bytes=250-999', 250, 255]]) {
    const part = await f.request(route, { headers: { Range: range } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes ${start}-${end}/${content.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), content.subarray(start, end + 1));
  }
  for (const range of ['bytes=256-', 'bytes=99-2', 'bytes=-0', 'bytes=abc', 'bytes=0-1,4-5']) {
    const response = await f.request(route, { headers: { Range: range } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */256');
    await response.arrayBuffer();
  }
  const head = await f.request(route, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '256');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const forced = await f.request(route + '?download=1');
  assert.match(forced.headers.get('content-disposition'), /^attachment;/);
});

test('active content stays an attachment with nosniff and restrictive headers', async t => {
  const f = await fixture(t);
  await f.login();
  for (const [name, mime, content] of [
    ['page.html', 'text/html', '<script>alert(document.cookie)</script>'],
    ['vector.svg', 'image/svg+xml', '<svg onload="alert(1)"></svg>'],
    ['report.pdf', 'application/pdf', '%PDF-1.7'],
    ['spoof.html', 'image/png', '<script>alert(1)</script>'],
  ]) {
    const item = await f.file(name, content, 'root', mime);
    const response = await f.request(`/api/files/${item.id}/content`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment;/, name);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('content-security-policy'));
    assert.match(response.headers.get('cache-control'), /no-store|private/);
    assert.equal(await response.text(), content);
  }
  const image = await f.file('safe.png', Buffer.from([137, 80, 78, 71]), 'root', 'image/png');
  const preview = await f.request(`/api/files/${image.id}/content`);
  assert.equal(preview.headers.get('content-type').split(';')[0], 'image/png');
  assert.match(preview.headers.get('content-disposition'), /^inline;/);
});

test('malformed and unsupported authenticated requests fail cleanly without changing storage', async t => {
  const f = await fixture(t);
  await f.login();
  for (const json of [null, [], 'folder', { parent: 'root', name: 123 }, { parent: 'root', name: '' }]) {
    await expectError(await f.request('/api/folders', { method: 'POST', json }), 400);
  }
  await expectError(await f.request('/api/folders', {
    method: 'POST', body: '{bad-json', headers: { 'Content-Type': 'application/json' },
  }), 400);
  const hugeJson = await f.request('/api/folders', {
    method: 'POST', json: { parent: 'root', name: 'a'.repeat(1024 * 1024) },
  });
  assert.ok([400, 413].includes(hugeJson.status));
  const unsupported = await f.request('/api/folders', { method: 'PUT', json: { name: 'wrong-method' } });
  assert.ok([404, 405].includes(unsupported.status));
  const unknown = await f.request('/api/does-not-exist');
  await expectError(unknown, 404);
  for (const route of ['/lib.js', '/server.js', '/admin.js', '/data/harbor.db', '/.env']) {
    const response = await f.request(route);
    assert.equal(response.status, 404, route);
  }
  assert.equal((await f.list()).stats.fileCount, 0);
  assert.equal((await f.list()).stats.folderCount, 0);
});

test('Unicode and quoted filenames download without corrupting response headers', async t => {
  const f = await fixture(t);
  await f.login();
  const name = '京都 "trip" 100%.txt';
  const item = await f.file(name, 'Unicode file content');
  assert.equal(item.name, name);
  const response = await f.request(`/api/files/${item.id}/content?download=1`);
  assert.equal(response.status, 200);
  const disposition = response.headers.get('content-disposition');
  assert.match(disposition, /^attachment;/);
  assert.match(disposition, /filename\*=UTF-8''/i);
  assert.ok(disposition.includes(encodeURIComponent(name)));
  assert.equal(await response.text(), 'Unicode file content');
});

test('upload limits and concurrent quota checks prevent overshoot; deleting frees capacity', async t => {
  const f = await fixture(t, { maxUploadBytes: 64, maxStorageBytes: 100 });
  await f.login();
  await expectError(await f.upload('too-big.bin', Buffer.alloc(65)), 413);
  assert.equal((await f.list()).stats.usedBytes, 0);
  const responses = await Promise.all([
    f.upload('concurrent-a.bin', Buffer.alloc(60, 1)),
    f.upload('concurrent-b.bin', Buffer.alloc(60, 2)),
  ]);
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  for (const response of responses.filter(response => response.status !== 201)) {
    assert.ok([413, 507].includes(response.status), await response.clone().text());
  }
  const state = await f.list();
  assert.equal(state.stats.fileCount, 1);
  assert.equal(state.stats.usedBytes, 60);
  assert.equal((await f.request(`/api/files/${state.items[0].id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await f.upload('space-reused.bin', Buffer.alloc(64))).status, 201);
  assert.equal((await f.list()).stats.usedBytes, 64);
});

test('a disconnected streaming upload leaves no file or quota reservation', async t => {
  const f = await fixture(t, { maxUploadBytes: 128, maxStorageBytes: 128 });
  await f.login();
  const before = await diskFiles(f.dataDir);
  await new Promise((resolve, reject) => {
    const request = http.request(f.url + '/api/upload?parent=root&name=cancelled.bin', {
      method: 'PUT', headers: {
        Origin: ORIGIN, Cookie: f.cookie, 'X-CSRF-Token': f.csrfToken,
        'Content-Type': 'application/octet-stream', 'Content-Length': '128',
      },
    });
    request.on('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error));
    request.on('socket', socket => socket.once('connect', () => {
      request.write(Buffer.alloc(32));
      setTimeout(() => { request.destroy(); resolve(); }, 30);
    }));
  });
  await eventually(async () => {
    const state = await f.list();
    assert.equal(state.stats.usedBytes, 0);
    assert.equal(state.stats.fileCount, 0);
    const after = await diskFiles(f.dataDir);
    assert.deepEqual(after, before);
  });
  assert.equal((await f.upload('after-cancel.bin', Buffer.alloc(128))).status, 201);
});

test('chunked uploads are bounded when Content-Length is absent', async t => {
  const f = await fixture(t, { maxUploadBytes: 64, maxStorageBytes: 200 });
  await f.login();
  const status = await new Promise((resolve, reject) => {
    const request = http.request(f.url + '/api/upload?parent=root&name=chunked.bin', {
      method: 'PUT', headers: {
        Origin: ORIGIN, Cookie: f.cookie, 'X-CSRF-Token': f.csrfToken,
        'Content-Type': 'application/octet-stream',
      },
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.write(Buffer.alloc(40));
    request.end(Buffer.alloc(40));
  });
  assert.equal(status, 413);
  assert.equal((await f.list()).stats.usedBytes, 0);
  assert.equal((await f.list()).stats.fileCount, 0);
});

test('deleting an upload destination aborts its pending files and releases the upload slot', async t => {
  const f = await fixture(t, { maxUploadBytes: 128, maxStorageBytes: 256, maxConcurrentUploads: 1 });
  await f.login();
  const folder = await f.folder('temporary destination');
  const before = await diskFiles(f.dataDir);
  let request;
  const uploadFinished = new Promise((resolve, reject) => {
    request = http.request(f.url + `/api/upload?parent=${folder.id}&name=pending.bin`, {
      method: 'PUT', headers: {
        Origin: ORIGIN, Cookie: f.cookie, 'X-CSRF-Token': f.csrfToken,
        'Content-Type': 'application/octet-stream', 'Content-Length': '128',
      },
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.write(Buffer.alloc(32));
  });
  t.after(() => request.destroy());
  await eventually(async () => {
    assert.ok((await diskFiles(f.dataDir)).some(name => name.endsWith('.part')));
  });
  assert.equal((await f.list(`parent=${folder.id}`)).items.length, 0, 'pending files remain private until committed');
  await expectError(await f.upload('above-limit.bin', Buffer.alloc(10)), 429);
  const deleted = await f.request(`/api/files/${folder.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal(await uploadFinished, 409);
  request.destroy();
  await eventually(async () => {
    assert.deepEqual(await diskFiles(f.dataDir), before);
    const state = await f.list();
    assert.equal(state.stats.folderCount, 0);
    assert.equal(state.stats.fileCount, 0);
    assert.equal(state.stats.usedBytes, 0);
  });
  assert.equal((await f.upload('slot-reused.bin', Buffer.alloc(128))).status, 201);
});

test('failed logins are rate limited without trusting client-supplied forwarding headers', async t => {
  const f = await fixture(t, { loginAttempts: 3, loginWindowMs: 60_000, loginBlockMs: 60_000 });
  for (let index = 0; index < 3; index++) {
    const response = await f.request('/api/login', {
      method: 'POST', json: { username: USERNAME, password: 'wrong password' },
      headers: { 'X-Real-IP': `192.0.2.${index + 1}`, 'X-Forwarded-For': `192.0.2.${index + 1}` },
    });
    await expectError(response, 401);
  }
  const blocked = await f.login();
  await expectError(blocked, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('successful sign-ins neither consume nor clear the failed-credential allowance', async t => {
  const f = await fixture(t, { loginAttempts: 3, loginWindowMs: 60_000, loginBlockMs: 60_000 });
  for (let index = 0; index < 5; index++) {
    assert.equal((await f.login()).status, 200, 'ordinary successful sign-ins must not cause a failure lockout');
  }
  await expectError(await f.login('incorrect password'), 401);
  assert.equal((await f.login()).status, 200);
  await expectError(await f.login('incorrect password'), 401);
  await expectError(await f.login('incorrect password'), 401);
  const blocked = await f.login();
  await expectError(blocked, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('a console password reset clears a running server failure lockout and revokes old sessions', async t => {
  const f = await fixture(t, { loginAttempts: 3, loginWindowMs: 60_000, loginBlockMs: 60_000 });
  assert.equal((await f.login()).status, 200);
  const oldCookie = f.cookie;
  await f.stop();
  await f.start();
  for (let index = 0; index < 3; index++) await expectError(await f.login('incorrect password'), 401);
  await expectError(await f.login(), 429);
  // The console writes the same database while the HTTP server remains running.
  await resetOwnerPassword(f.dataDir, NEW_PASSWORD);
  await expectError(await f.request('/api/session', { headers: { Cookie: oldCookie } }), 401);
  assert.equal((await f.login(NEW_PASSWORD)).status, 200, 'recovery must work without restarting the server');
  await expectError(await f.login(PASSWORD), 401);
  assert.equal((await f.login(NEW_PASSWORD)).status, 200);
});

test('the short attempt burst guard also limits successful logins and survives a console reset', async t => {
  const f = await fixture(t, {
    loginAttempts: 10, loginBurstAttempts: 2, loginBurstWindowMs: 60_000,
  });
  assert.equal((await f.login()).status, 200);
  assert.equal((await f.login()).status, 200);
  const blocked = await f.login();
  await expectError(blocked, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  await resetOwnerPassword(f.dataDir, NEW_PASSWORD);
  await expectError(await f.login(NEW_PASSWORD), 429);
});

test('simultaneous delayed guesses cannot exceed the remaining failed-credential allowance', async t => {
  const f = await fixture(t, { loginAttempts: 1, loginWindowMs: 60_000, loginBlockMs: 60_000 });
  const statuses = await delayedLogins(f, Array(4).fill('incorrect password'));
  assert.equal(statuses.filter(status => status === 401).length, 1);
  assert.equal(statuses.filter(status => status === 429).length, 3);
  await expectError(await f.login(), 429);
});

test('concurrent successful sign-ins release their reserved failure capacity without a long lockout', async t => {
  const f = await fixture(t, { loginAttempts: 1, loginWindowMs: 60_000, loginBlockMs: 60_000 });
  const statuses = await delayedLogins(f, Array(4).fill(PASSWORD));
  assert.equal(statuses.filter(status => status === 200).length, 1);
  assert.equal(statuses.filter(status => status === 429).length, 3);
  assert.equal((await f.login()).status, 200, 'a busy response while a valid login runs must not create a failure lockout');
  await expectError(await f.login('incorrect password'), 401);
});

test('delayed login bodies cannot bypass the limit on concurrent password hashing', async t => {
  const f = await fixture(t, { loginAttempts: 30 });
  const statuses = await delayedLogins(f, Array(5).fill(PASSWORD));
  assert.equal(statuses.filter(status => status === 200).length, 2);
  assert.equal(statuses.filter(status => status === 429).length, 3);
});

test('admin settings require authentication and the current database role on every request', async t => {
  const f = await fixture(t);
  const routes = [
    ['/api/admin/settings', {}],
    ['/api/admin/settings', { method: 'PATCH', json: { sessionHours: 2 } }],
    ['/api/admin/storage', { method: 'POST', json: { name: 'new library' } }],
  ];
  for (const [route, options] of routes) await expectError(await f.request(route, options), 401);
  const login = await f.login();
  assert.equal((await login.json()).user.role, 'admin');
  const settings = await adminSettings(f);
  assert.equal(settings.settings.activeStorageId, 'original');
  assert.equal(settings.deployment.dataDir, f.dataDir);
  assert.equal(settings.storage.locations.find(item => item.id === 'original').label, 'Original storage');
  for (const [route, options] of routes.filter(([, options]) => options.method)) {
    await expectError(await f.request(route, { ...options, csrf: false }), 403);
    await expectError(await f.request(route, { ...options, origin: false }), 403);
    await expectError(await f.request(route, { ...options, headers: { Origin: 'https://other.example' } }), 403);
  }
  withDatabase(f.dataDir, db => db.prepare("UPDATE owner SET role='user' WHERE id=1").run());
  assert.equal((await (await f.request('/api/session')).json()).user.role, 'user');
  for (const [route, options] of routes) await expectError(await f.request(route, options), 403);
  assert.equal((await f.list()).stats.fileCount, 0, 'changing the role must not break regular file access');
});

test('settings validate atomically, persist, and leave existing session expiry unchanged', async t => {
  const f = await fixture(t);
  await f.login();
  const before = await adminSettings(f);
  const expires = withDatabase(f.dataDir, db => db.prepare('SELECT expires_at FROM sessions').get().expires_at);
  for (const json of [
    { unknownSetting: true }, { maxUploadBytes: 0 }, { maxStorageBytes: -1 },
    { maxConcurrentUploads: 1.5 }, { maxConcurrentUploads: 65 }, { sessionHours: 721 },
    { sessionHours: '3' }, { maxStorageBytes: true }, { activeStorageId: 'unknown-location' },
    { maxUploadBytes: 2 ** 41 }, { maxStorageBytes: 2 ** 51 },
    { sessionHours: 4, unknownSetting: true },
  ]) {
    await expectError(await f.request('/api/admin/settings', { method: 'PATCH', json }), 400);
    assert.deepEqual((await adminSettings(f)).settings, before.settings);
  }
  const update = { maxUploadBytes: 128, maxStorageBytes: 1024, maxConcurrentUploads: 2, sessionHours: 3 };
  const saved = await f.request('/api/admin/settings', { method: 'PATCH', json: update });
  assert.equal(saved.status, 200, await saved.clone().text());
  for (const [key, value] of Object.entries(update)) assert.equal((await saved.clone().json()).settings[key], value);
  assert.equal(withDatabase(f.dataDir, db => db.prepare('SELECT expires_at FROM sessions').get().expires_at), expires);
  await expectError(await f.upload('over-new-limit.bin', Buffer.alloc(129)), 413);
  await f.stop();
  await f.start();
  const persisted = await adminSettings(f);
  for (const [key, value] of Object.entries(update)) assert.equal(persisted.settings[key], value);
  const session = await (await f.request('/api/session')).json();
  assert.equal(session.limits.maxUploadBytes, 128);
  assert.equal(session.limits.maxStorageBytes, 1024);
});

test('an admin role revoked while a request body is pending cannot change settings', async t => {
  const f = await fixture(t);
  await f.login();
  const body = JSON.stringify({ sessionHours: 5 });
  let request;
  let connected;
  const connection = new Promise(resolve => { connected = resolve; });
  const completed = new Promise((resolve, reject) => {
    request = http.request(f.url + '/api/admin/settings', {
      method: 'PATCH', headers: {
        Origin: f.config.appOrigin, Cookie: f.cookie, 'X-CSRF-Token': f.csrfToken,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      },
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('socket', socket => socket.once('connect', connected));
    request.on('error', reject);
    request.flushHeaders();
  });
  t.after(() => request.destroy());
  await connection;
  await new Promise(resolve => setTimeout(resolve, 30));
  withDatabase(f.dataDir, db => db.prepare("UPDATE owner SET role='user' WHERE id=1").run());
  request.end(body);
  assert.equal(await completed, 403);
  withDatabase(f.dataDir, db => db.prepare("UPDATE owner SET role='admin' WHERE id=1").run());
  assert.equal((await adminSettings(f)).settings.sessionHours, f.config.sessionHours);
});

test('settings cannot reduce the storage quota below used plus reserved upload bytes', async t => {
  const f = await fixture(t, { maxUploadBytes: 256, maxStorageBytes: 512 });
  await f.login();
  await f.file('existing.bin', Buffer.alloc(50));
  const pending = await parkedUpload(f, 'pending.bin', 128);
  t.after(() => pending.request.destroy());
  const status = await adminSettings(f);
  assert.equal(status.storage.usedBytes, 50);
  assert.equal(status.storage.reservedBytes, 128);
  await expectError(await f.request('/api/admin/settings', { method: 'PATCH', json: { maxStorageBytes: 177 } }), 409);
  assert.equal((await adminSettings(f)).settings.maxStorageBytes, 512);
  assert.equal((await f.request('/api/admin/settings', { method: 'PATCH', json: { maxStorageBytes: 178 } })).status, 200);
  pending.request.end(Buffer.alloc(128 - pending.sent));
  assert.equal(await pending.completed, 201);
  assert.equal((await f.list()).stats.usedBytes, 178);
});

test('upgrading an original database grants the existing owner admin and preserves old blobs', async t => {
  const legacyId = '11111111-1111-4111-8111-111111111111';
  const legacyBytes = Buffer.from('legacy stored file');
  const f = await fixture(t, {}, async dataDir => {
    const oldHash = withDatabase(dataDir, db => db.prepare('SELECT password_hash FROM owner').get().password_hash);
    for (const suffix of ['', '-wal', '-shm']) await rm(path.join(dataDir, 'harbor.sqlite' + suffix), { force: true });
    withDatabase(dataDir, db => {
      db.exec(`
        CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password_hash TEXT NOT NULL);
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE nodes (id TEXT PRIMARY KEY, parent TEXT REFERENCES nodes(id) ON DELETE CASCADE,
          name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','folder')), mime TEXT NOT NULL,
          size INTEGER NOT NULL DEFAULT 0 CHECK(size>=0), status TEXT NOT NULL DEFAULT 'ready',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      `);
      db.prepare('INSERT INTO owner VALUES(1,?,?)').run(USERNAME, oldHash);
      db.prepare('INSERT INTO nodes VALUES(?,NULL,?,?,?,?,?,?,?)').run(
        legacyId, 'legacy.txt', 'file', 'text/plain', legacyBytes.length, 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      );
    });
    await mkdir(path.join(dataDir, 'blobs'), { recursive: true });
    await writeFile(path.join(dataDir, 'blobs', legacyId), legacyBytes);
  });
  const login = await f.login();
  assert.equal((await login.json()).user.role, 'admin');
  assert.equal(withDatabase(f.dataDir, db => db.prepare('SELECT storage_id FROM nodes WHERE id=?').get(legacyId).storage_id), 'original');
  const response = await f.request(`/api/files/${legacyId}/content`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), legacyBytes);
  assert.equal((await adminSettings(f)).storage.locations.find(item => item.id === 'original').usedBytes, legacyBytes.length);
});

test('storage switching retains every library across restart and deletes from the correct location', async t => {
  const f = await fixture(t);
  await f.login();
  const oldFile = await f.file('original.txt', 'old bytes');
  const created = await f.request('/api/admin/storage', { method: 'POST', json: { name: 'Family archive' } });
  assert.equal(created.status, 201, await created.clone().text());
  const settings = await created.json();
  const newId = settings.settings.activeStorageId;
  assert.notEqual(newId, 'original');
  const location = settings.storage.locations.find(item => item.id === newId);
  assert.equal(path.resolve(location.path), path.resolve(settings.storage.root, 'Family archive'));
  const newFile = await f.file('new.txt', 'new bytes');
  assert.equal(await readFile(path.join(f.dataDir, 'blobs', oldFile.id), 'utf8'), 'old bytes');
  assert.equal(await readFile(path.join(location.path, newFile.id), 'utf8'), 'new bytes');
  assert.equal((await f.request('/api/admin/settings', { method: 'PATCH', json: { activeStorageId: 'original' } })).status, 200);
  const returnedFile = await f.file('returned.txt', 'returned bytes');
  assert.equal(await readFile(path.join(f.dataDir, 'blobs', returnedFile.id), 'utf8'), 'returned bytes');
  await f.stop();
  await f.start();
  for (const [item, content] of [[oldFile, 'old bytes'], [newFile, 'new bytes'], [returnedFile, 'returned bytes']]) {
    assert.equal(await (await f.request(`/api/files/${item.id}/content`)).text(), content);
  }
  assert.equal((await f.request(`/api/files/${newFile.id}`, { method: 'DELETE' })).status, 204);
  await assert.rejects(stat(path.join(location.path, newFile.id)), { code: 'ENOENT' });
  assert.equal((await adminSettings(f)).storage.locations.find(item => item.id === newId).fileCount, 0);
  assert.equal(await readFile(path.join(f.dataDir, 'blobs', oldFile.id), 'utf8'), 'old bytes');
});

test('an upload captures its original storage and size limit while settings change', async t => {
  const f = await fixture(t, { maxUploadBytes: 256, maxStorageBytes: 1024 });
  await f.login();
  const pending = await parkedUpload(f, 'started-before-switch.bin', 128);
  t.after(() => pending.request.destroy());
  const created = await f.request('/api/admin/storage', { method: 'POST', json: { name: 'New uploads' } });
  assert.equal(created.status, 201);
  const config = await created.json();
  const location = config.storage.locations.find(item => item.id === config.settings.activeStorageId);
  assert.equal((await f.request('/api/admin/settings', { method: 'PATCH', json: { maxUploadBytes: 64 } })).status, 200);
  pending.request.end(Buffer.alloc(128 - pending.sent));
  assert.equal(await pending.completed, 201);
  const finished = (await f.list()).items.find(item => item.name === 'started-before-switch.bin');
  assert.equal((await stat(path.join(f.dataDir, 'blobs', finished.id))).size, 128);
  await assert.rejects(stat(path.join(location.path, finished.id)), { code: 'ENOENT' });
  await expectError(await f.upload('new-too-big.bin', Buffer.alloc(65)), 413);
  const newFile = await f.file('new-small.bin', Buffer.alloc(64));
  assert.equal((await stat(path.join(location.path, newFile.id))).size, 64);
});

test('storage folder creation rejects escape, symlink, duplicate, and unrelated nonempty paths', async t => {
  const f = await fixture(t);
  await f.login();
  const initial = await adminSettings(f);
  const storageRoot = initial.storage.root;
  for (const name of ['..', '.', '../outside', '..\\outside', '/absolute', 'C:\\outside', 'bad/name', 'bad\\name', '', 'a'.repeat(65), 'line\nname']) {
    await expectError(await f.request('/api/admin/storage', { method: 'POST', json: { name } }), 400);
  }
  await mkdir(path.join(storageRoot, 'Unrelated'));
  await writeFile(path.join(storageRoot, 'Unrelated', 'sentinel'), 'do not modify');
  await expectError(await f.request('/api/admin/storage', { method: 'POST', json: { name: 'Unrelated' } }), 409);
  assert.equal(await readFile(path.join(storageRoot, 'Unrelated', 'sentinel'), 'utf8'), 'do not modify');
  const outside = await mkdtemp(path.join(tmpdir(), 'harbor-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'sentinel'), 'outside data');
  await symlink(outside, path.join(storageRoot, 'Linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await f.request('/api/admin/storage', { method: 'POST', json: { name: 'Linked' } });
  assert.ok([400, 409, 503].includes(linked.status), await linked.clone().text());
  assert.deepEqual(await readdir(outside), ['sentinel']);
  const first = await f.request('/api/admin/storage', { method: 'POST', json: { name: 'Managed' } });
  assert.equal(first.status, 201);
  await expectError(await f.request('/api/admin/storage', { method: 'POST', json: { name: 'Managed' } }), 409);
});

test('managed storage resolves after a root relocation and refuses a missing root', async t => {
  const parent = await mkdtemp(path.join(tmpdir(), 'harbor-mount-'));
  const initialRoot = path.join(parent, 'mounted');
  const relocatedRoot = path.join(parent, 'relocated');
  await mkdir(initialRoot);
  const f = await fixture(t, { storageRoot: initialRoot });
  t.after(() => rm(parent, { recursive: true, force: true }));
  await f.login();
  assert.equal((await f.request('/api/admin/storage', { method: 'POST', json: { name: 'Archive' } })).status, 201);
  const item = await f.file('portable.txt', 'portable content');
  await f.stop();
  await rename(initialRoot, relocatedRoot);
  f.config.storageRoot = relocatedRoot;
  await f.start();
  assert.equal(await (await f.request(`/api/files/${item.id}/content`)).text(), 'portable content');
  const status = await adminSettings(f);
  assert.equal(status.storage.root, relocatedRoot);
  assert.ok(status.storage.locations.some(location => location.path === path.join(relocatedRoot, 'Archive')));
  await f.stop();
  await rename(relocatedRoot, initialRoot);
  await assert.rejects(f.start(), /storage|missing|exist|unavailable/i);
  await assert.rejects(stat(relocatedRoot), { code: 'ENOENT' });
});

test('replacing a managed folder with a symlink or empty directory cannot expose outside files or lose metadata', async t => {
  const f = await fixture(t);
  await f.login();
  const created = await f.request('/api/admin/storage', { method: 'POST', json: { name: 'Protected' } });
  const settings = await created.json();
  const location = settings.storage.locations.find(item => item.id === settings.settings.activeStorageId);
  const item = await f.file('preserved.txt', 'preserved content');
  const held = location.path + '-held';
  const outside = await mkdtemp(path.join(tmpdir(), 'harbor-unsafe-mount-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, item.id), 'outside secret');
  await rename(location.path, held);
  await symlink(outside, location.path, process.platform === 'win32' ? 'junction' : 'dir');
  await expectError(await f.request(`/api/files/${item.id}/content`), 503);
  await expectError(await f.request(`/api/files/${item.id}/preview`), 503);
  await expectError(await f.upload('refused.txt', 'new data'), 503);
  assert.equal(await readFile(path.join(outside, item.id), 'utf8'), 'outside secret');
  assert.equal(withDatabase(f.dataDir, db => db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE id=?').get(item.id).count), 1);
  await f.stop();
  await assert.rejects(f.start(), /unsafe|storage|mount/i);
  await rm(location.path, { recursive: true, force: true });
  await mkdir(location.path);
  await assert.rejects(f.start(), /identity|storage|mount/i);
  assert.equal(withDatabase(f.dataDir, db => db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE id=?').get(item.id).count), 1);
  await rm(location.path, { recursive: true });
  await rename(held, location.path);
  await f.start();
  assert.equal(await (await f.request(`/api/files/${item.id}/content`)).text(), 'preserved content');
});

test('text previews are authenticated, contain inert source text, and truncate bounded input', async t => {
  const f = await fixture(t);
  await f.login();
  const source = '<script>window.previewExecuted = true;</script>\nPlain text & <tags>';
  const item = await f.file('source.txt', source);
  await expectError(await f.request(`/api/files/${item.id}/preview`, { authenticated: false }), 401);
  const response = await f.request(`/api/files/${item.id}/preview`);
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const preview = await response.json();
  assert.equal(preview.kind, 'text');
  assert.equal(preview.text, source);
  assert.equal(preview.truncated, false);
  assert.equal(typeof preview.label, 'string');
  const large = await f.file('long.log', 'x'.repeat(1024 * 1024 + 512));
  const longPreview = await (await f.request(`/api/files/${large.id}/preview`)).json();
  assert.equal(longPreview.truncated, true);
  assert.ok(Buffer.byteLength(longPreview.text, 'utf8') <= 1024 * 1024);
  for (const name of ['unsafe.html', 'unsafe.svg', 'unsupported.zip']) {
    const unsupported = await f.file(name, source);
    await expectError(await f.request(`/api/files/${unsupported.id}/preview`), 415);
    assert.match((await f.request(`/api/files/${unsupported.id}/content`)).headers.get('content-disposition'), /^attachment;/);
  }
});

test('Word previews extract genuine DOC and DOCX files while rejecting malformed and oversized documents', async t => {
  const f = await fixture(t, { maxUploadBytes: 24 * 1024 * 1024, maxStorageBytes: 48 * 1024 * 1024 });
  await f.login();
  for (const [name, expected] of [
    ['legacy-word.doc', /Ooops, where are the \( opening \( brackets\?/],
    ['modern-word.docx', /Harbor Word preview fixture[\s\S]*Unicode café[\s\S]*literal <script> source/],
  ]) {
    const bytes = await readFile(new URL('./fixtures/' + name, import.meta.url));
    const item = await f.file(name, bytes);
    const response = await f.request(`/api/files/${item.id}/preview`);
    assert.equal(response.status, 200, await response.clone().text());
    const preview = await response.json();
    assert.equal(preview.kind, 'text');
    assert.equal(preview.label, 'Word text preview');
    assert.equal(preview.truncated, false);
    assert.match(preview.text, expected);
    assert.match((await f.request(`/api/files/${item.id}/content`)).headers.get('content-disposition'), /^attachment;/);
  }
  for (const name of ['broken.doc', 'broken.docx']) {
    const item = await f.file(name, 'not a Word document');
    await expectError(await f.request(`/api/files/${item.id}/preview`), 422);
  }
  const bounded = await f.file('expanded-limit.docx', await readFile(new URL('./fixtures/expanded-limit.docx', import.meta.url)));
  await expectError(await f.request(`/api/files/${bounded.id}/preview`), 422);
  const oversized = await f.file('over-input-limit.docx', Buffer.alloc(20 * 1024 * 1024 + 1));
  await expectError(await f.request(`/api/files/${oversized.id}/preview`), 413);
  assert.equal((await f.request(`/api/files/${oversized.id}/content`, { method: 'HEAD' })).status, 200);
});

test('legacy Word preflight promptly rejects hostile allocation headers and sector graphs', async t => {
  const f = await fixture(t);
  await f.login();
  const valid = await readFile(new URL('./fixtures/legacy-word.doc', import.meta.url));
  const sectorSize = 1 << valid.readUInt16LE(30);
  const directorySector = valid.readInt32LE(48);
  const fatOffset = (valid.readInt32LE(76) + 1) * sectorSize;
  let wordEntry;
  for (let offset = (directorySector + 1) * sectorSize; offset < (directorySector + 2) * sectorSize; offset += 128) {
    const nameLength = valid.readUInt16LE(offset + 64);
    if (valid.subarray(offset, offset + nameLength - 2).toString('utf16le') === 'WordDocument') wordEntry = offset;
  }
  assert.notEqual(wordEntry, undefined, 'fixture must contain its expected WordDocument stream');
  const mutations = [
    ['sector-shift', bytes => bytes.writeUInt16LE(30, 30)],
    ['impossible-fat-count', bytes => bytes.writeUInt32LE(0x7fffffff, 44)],
    ['out-of-range-directory', bytes => bytes.writeUInt32LE(0x7ffffffe, 48)],
    ['two-sector-cycle', bytes => {
      bytes.writeInt32LE(directorySector + 1, fatOffset + directorySector * 4);
      bytes.writeInt32LE(directorySector, fatOffset + (directorySector + 1) * 4);
    }],
    ['oversized-stream', bytes => bytes.writeBigUInt64LE(0x7fffffffn, wordEntry + 120)],
  ];
  for (const [name, mutate] of mutations) {
    const bytes = Buffer.from(valid);
    mutate(bytes);
    const item = await f.file(name + '.doc', bytes);
    const started = Date.now();
    await expectError(await f.request(`/api/files/${item.id}/preview`), 422);
    assert.ok(Date.now() - started < 4000, `${name} should fail preflight without waiting for the 8-second worker timeout`);
  }
  const normal = await f.file('still-readable.doc', valid);
  const response = await f.request(`/api/files/${normal.id}/preview`);
  assert.equal(response.status, 200);
  assert.match((await response.json()).text, /This line gets read fine/);
});

function withDatabase(dataDir, callback) {
  const db = new DatabaseSync(path.join(dataDir, 'harbor.sqlite'));
  try { return callback(db); } finally { db.close(); }
}

async function adminSettings(f) {
  const response = await f.request('/api/admin/settings');
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function parkedUpload(f, name, size) {
  let request;
  const sent = Math.min(16, size - 1);
  const completed = new Promise((resolve, reject) => {
    request = http.request(f.url + `/api/upload?parent=root&name=${encodeURIComponent(name)}`, {
      method: 'PUT', headers: {
        Origin: f.config.appOrigin, Cookie: f.cookie, 'X-CSRF-Token': f.csrfToken,
        'Content-Type': 'application/octet-stream', 'Content-Length': String(size),
      },
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', error => error.code === 'ECONNRESET' ? resolve(400) : reject(error));
    request.write(Buffer.alloc(sent));
  });
  await eventually(async () => assert.ok((await diskFiles(f.dataDir)).some(file => file.endsWith('.part'))));
  return { request, completed, sent };
}

async function diskFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await diskFiles(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

async function eventually(assertion, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await assertion(); return; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
