import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPresentationPreview, PRESENTATION_OUTPUT_BYTES } from '../presentation-preview.js';
import { createRenderer } from '../renderer.js';
import { createApplication } from '../server.js';
import { initializeOwner, resetOwnerPassword } from '../lib.js';

const PDF = Buffer.from('%PDF-1.7\nsynthetic renderer response\n%%EOF');
const INPUT = Buffer.from('synthetic presentation bytes');
const PASSWORD = 'private presentation test password';

async function fixture(t, handler) {
  const directory = await mkdtemp(path.join(tmpdir(), 'harbor-ppt-test-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\harbor-ppt-${randomUUID()}` : path.join(directory, 'renderer.sock');
  const filePath = path.join(directory, 'slide.pptx');
  const result = { directory, socketPath, filePath, name: 'slides.pptx', size: INPUT.length };
  await writeFile(filePath, INPUT);
  let server;
  if (handler) {
    server = http.createServer(handler); server.listen(socketPath); await once(server, 'listening');
  }
  t.after(async () => {
    await result.beforeCleanup?.();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  return result;
}

test('presentation client sends only bounded document bytes over the private socket and accepts a PDF', async t => {
  let received;
  const f = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = { url: req.url, headers: req.headers, bytes: Buffer.concat(chunks) };
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': PDF.length }); res.end(PDF);
  });
  assert.deepEqual(await createPresentationPreview(f), PDF);
  assert.equal(received.url, '/convert?extension=.pptx');
  assert.deepEqual(received.bytes, INPUT);
  assert.equal(received.headers['content-type'], 'application/octet-stream');
  assert.equal(received.headers.cookie, undefined);
  assert.equal(received.headers.authorization, undefined);
});

test('presentation client reports disabled renderer, unsupported type and oversized input before conversion', async t => {
  const f = await fixture(t);
  await assert.rejects(createPresentationPreview({ ...f, socketPath: '' }), error => error.status === 503);
  await assert.rejects(createPresentationPreview({ ...f, name: 'slide.html' }), error => error.status === 415);
  await assert.rejects(createPresentationPreview({ ...f, size: 20 * 1024 * 1024 + 1 }), error => error.status === 413);
});

test('presentation client bounds converter responses and does not pass through converter error content', async t => {
  let mode = 'oversized';
  const f = await fixture(t, (req, res) => {
    req.resume();
    if (mode === 'oversized') { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': PRESENTATION_OUTPUT_BYTES + 1 }); res.end(); }
    else if (mode === 'invalid') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end('not a PDF'); }
    else { res.writeHead(429); res.end('sensitive converter details'); }
  });
  await assert.rejects(createPresentationPreview(f), error => error.status === 422);
  mode = 'invalid';
  await assert.rejects(createPresentationPreview(f), error => error.status === 422);
  mode = 'busy';
  await assert.rejects(createPresentationPreview(f), error => error.status === 429 && !error.message.includes('sensitive'));
});

test('presentation client cancellation disconnects the converter request', async t => {
  let started, disconnected;
  const start = new Promise(resolve => { started = resolve; });
  const closed = new Promise(resolve => { disconnected = resolve; });
  const f = await fixture(t, (req, res) => { req.resume(); res.once('close', disconnected); started(); });
  const controller = new AbortController();
  const preview = createPresentationPreview({ ...f, signal: controller.signal });
  await start; controller.abort();
  await assert.rejects(preview, error => error.status === 422);
  await closed;
});

test('presentation PDF endpoint authenticates requests and rechecks sessions after conversion', async t => {
  let hold = false, started, release, calls = 0;
  const f = await fixture(t, (req, res) => {
    calls++; req.resume();
    const send = () => { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(PDF); };
    if (hold) { release = send; started(); } else send();
  });
  const dataDir = path.join(f.directory, 'data');
  await initializeOwner(dataDir, 'ppt-owner', PASSWORD);
  const app = await createApplication({ dataDir, appOrigin: 'http://localhost', nodeEnv: 'test', presentationRendererSocket: f.socketPath, logger: { error() {} } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  f.beforeCleanup = () => app.close();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ppt-owner', password: PASSWORD }) });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers.get('set-cookie').split(';')[0], session = await login.json();
  const upload = await fetch(base + '/api/upload?name=slides.pptx', { method: 'PUT', headers: { Cookie: cookie, Origin: 'http://localhost', 'X-CSRF-Token': session.csrfToken }, body: INPUT });
  assert.equal(upload.status, 201, await upload.clone().text());
  const item = await upload.json(), route = base + `/api/files/${item.id}/preview.pdf`;
  assert.equal((await fetch(route)).status, 401); assert.equal(calls, 0);
  const good = await fetch(route, { headers: { Cookie: cookie } });
  assert.equal(good.status, 200, await good.clone().text()); assert.equal(good.headers.get('content-type'), 'application/pdf');
  assert.equal(good.headers.get('accept-ranges'), 'none');
  assert.equal(good.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await good.arrayBuffer()), PDF);
  hold = true;
  const trashStart = new Promise(resolve => { started = resolve; });
  const trashedPreview = fetch(route, { headers: { Cookie: cookie } });
  await trashStart;
  const mutationHeaders = { Cookie: cookie, Origin: 'http://localhost', 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + `/api/files/${item.id}`, { method: 'DELETE', headers: mutationHeaders })).status, 204);
  release(); assert.equal((await trashedPreview).status, 404);
  assert.equal((await fetch(base + '/api/trash/restore', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ ids: [item.id] }) })).status, 200);
  const pendingStart = new Promise(resolve => { started = resolve; });
  const pending = fetch(route, { headers: { Cookie: cookie } });
  await pendingStart;
  await resetOwnerPassword(dataDir, 'replacement presentation password');
  release();
  assert.equal((await pending).status, 401);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for renderer cleanup.');
}

test('isolated renderer cancels and times out jobs, cleans scratch files, and reuses its single slot', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t);
  const executable = path.join(f.directory, 'fake-converter');
  await writeFile(executable, `const fs=require('fs'),path=require('path');\nconst input=process.argv[2],output=process.argv[3];\nfs.writeFileSync(path.join(path.dirname(input),'pid'),String(process.pid));\nif(fs.readFileSync(input,'utf8')==='FAST')fs.writeFileSync(output,${JSON.stringify(PDF.toString())});else setTimeout(()=>{},30000);\n`, { mode: 0o700 });
  const renderer = await createRenderer({ socketPath: f.socketPath, tempRoot: f.directory, pythonPath: process.execPath, converterPath: executable, timeoutMs: 700 });
  f.beforeCleanup = () => renderer.close();
  let job, childPid;
  const controller = new AbortController();
  const cancelled = createPresentationPreview({ ...f, signal: controller.signal });
  cancelled.catch(() => {});
  await waitFor(async () => {
    job = (await readdir(f.directory)).find(name => name.startsWith('harbor-render-'));
    if (!job) return false;
    try { childPid = Number(await readFile(path.join(f.directory, job, 'pid'), 'utf8')); return true; } catch { return false; }
  });
  await assert.rejects(createPresentationPreview(f), error => error.status === 429);
  controller.abort(); await assert.rejects(cancelled);
  await waitFor(async () => !(await readdir(f.directory)).some(name => name.startsWith('harbor-render-')));
  assert.throws(() => process.kill(childPid, 0), error => error.code === 'ESRCH');
  await assert.rejects(createPresentationPreview(f), error => error.status === 422);
  await waitFor(async () => !(await readdir(f.directory)).some(name => name.startsWith('harbor-render-')));
  await writeFile(f.filePath, 'FAST');
  assert.deepEqual(await createPresentationPreview({ ...f, size: 4 }), PDF);
  await waitFor(async () => !(await readdir(f.directory)).some(name => name.startsWith('harbor-render-')));
});
