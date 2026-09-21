import http from 'node:http';
import { mkdtemp, chmod, lstat, unlink, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INPUT_LIMIT = 20 * 1024 * 1024, OUTPUT_LIMIT = 100 * 1024 * 1024;
const helper = fileURLToPath(new URL('./renderer-convert.py', import.meta.url));
function failure(status, message) { return Object.assign(new Error(message), { status }); }
function send(res, status, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify({ error: message });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Connection': 'close' });
  res.end(body);
}

function convert(input, output, job, signal, pythonPath, converterPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [converterPath, input, output, path.join(job, 'profile')], {
      cwd: job, stdio: 'ignore', detached: true,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: job, TMPDIR: job, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', SAL_USE_VCLPLUGIN: 'svp' },
    });
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); } } };
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    child.once('error', error => { signal.removeEventListener('abort', kill); reject(error); });
    child.once('close', code => {
      signal.removeEventListener('abort', kill);
      // Clean up any LibreOffice descendants even when the helper failed early.
      kill();
      if (code === 0 && !signal.aborted) resolve();
      else reject(failure(422, 'The presentation could not be converted within the preview limits.'));
    });
  });
}

export async function createRenderer({ socketPath = '/run/harbor-preview/renderer.sock', tempRoot = '/tmp', timeoutMs = 90000, pythonPath = '/usr/bin/python3', converterPath = helper } = {}) {
  let active, closing = false;
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: timeoutMs + 10000, keepAliveTimeout: 1000 }, (req, res) => {
    const route = async () => {
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); return;
      }
      const url = new URL(req.url, 'http://renderer');
      if (req.method !== 'POST' || url.pathname !== '/convert') throw failure(404, 'Route not found.');
      if (closing) throw failure(503, 'The preview renderer is stopping.');
      if (active) throw failure(429, 'Another preview is being prepared.');
      const extension = url.searchParams.get('extension');
      if (!['.ppt', '.pptx'].includes(extension)) throw failure(415, 'Unsupported presentation format.');
      if (req.headers['content-type'] !== 'application/octet-stream' || req.headers['content-encoding']) throw failure(415, 'Send unencoded presentation bytes.');
      const declared = req.headers['content-length'];
      if (typeof declared !== 'string' || !/^\d+$/.test(declared)) throw failure(411, 'A content length is required.');
      const size = Number(declared);
      if (!Number.isSafeInteger(size) || size > INPUT_LIMIT) throw failure(413, 'Presentation exceeds the input limit.');
      const controller = new AbortController();
      let done;
      active = { controller, done: new Promise(resolve => { done = resolve; }) };
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortInput = () => { if (!req.complete) req.destroy(); };
      controller.signal.addEventListener('abort', abortInput, { once: true });
      const onDisconnect = () => { if (!res.writableEnded) controller.abort(); };
      req.once('aborted', onDisconnect); res.once('close', onDisconnect);
      req.setTimeout(30000, () => controller.abort());
      let job;
      try {
        job = await mkdtemp(path.join(tempRoot, 'harbor-render-'));
        await chmod(job, 0o700);
        const input = path.join(job, `input${extension}`), output = path.join(job, 'preview.pdf');
        const handle = await open(input, 'wx', 0o600);
        try {
          let received = 0;
          for await (const chunk of req) {
            if (controller.signal.aborted) throw failure(422, 'Preview cancelled.');
            received += chunk.length;
            if (received > size || received > INPUT_LIMIT) throw failure(413, 'Presentation exceeds the input limit.');
            await handle.writeFile(chunk);
          }
          if (received !== size) throw failure(422, 'Incomplete presentation.');
        } finally { await handle.close(); }
        if (controller.signal.aborted) throw failure(422, 'Preview cancelled.');
        req.setTimeout(timeoutMs + 10000);
        await convert(input, output, job, controller.signal, pythonPath, converterPath);
        const pdf = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await pdf.stat();
          if (!info.isFile() || info.size < 5 || info.size > OUTPUT_LIMIT) throw failure(422, 'Generated preview exceeds output limits.');
          const signature = Buffer.alloc(5);
          await pdf.read(signature, 0, 5, 0);
          if (signature.toString('ascii') !== '%PDF-') throw failure(422, 'Conversion did not create a PDF.');
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
          await pipeline(pdf.createReadStream({ start: 0 }), res, { signal: controller.signal });
        } finally { await pdf.close().catch(() => {}); }
      } finally {
        clearTimeout(timer); req.off('aborted', onDisconnect); res.off('close', onDisconnect);
        controller.signal.removeEventListener('abort', abortInput);
        try { if (job) await rm(job, { recursive: true, force: true }); }
        finally { active = undefined; done(); }
      }
    };
    route().catch(error => { send(res, error.status ?? 422, error.status ? error.message : 'The presentation could not be converted.'); req.resume(); });
  });
  server.maxConnections = 8;
  server.setTimeout(30000, socket => socket.destroy());
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket() || existing.uid !== process.getuid()) throw new Error('Renderer socket path is not an owned socket.');
    await unlink(socketPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  const close = async () => {
    closing = true;
    const pending = active;
    pending?.controller.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (pending) await pending.done;
  };
  return { server, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = await createRenderer({ socketPath: process.env.PRESENTATION_RENDERER_SOCKET });
    console.log('Harbor slide renderer is ready.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().catch(() => { process.exitCode = 1; }));
  } catch (error) { console.error('Slide renderer could not start:', error.message); process.exitCode = 1; }
}
