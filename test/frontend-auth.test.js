import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const securityError = 'Invalid security token. Refresh the page and try again.';
const session = token => ({ user: { username: 'Owner', role: 'admin' }, csrfToken: token, limits: { maxUploadBytes: 10000, maxStorageBytes: 100000 } });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// Run the shipped app, exposing its closure only in this test VM. The small DOM
// models the controls used by the actual request/submit handlers, not a second
// implementation of authentication or retry behavior.
function harness() {
  const elements = new Map();
  const requests = [];
  const uploads = [];
  let requestHandler = () => { throw new Error('Unexpected request'); };
  let uploadHandler = () => { throw new Error('Unexpected upload'); };
  let now = Date.UTC(2026, 0, 1, 12);
  let nextTimer = 0;
  const timers = new Map();
  const schedule = (fn, delay = 0) => { const id = ++nextTimer; timers.set(id, { at: now + Math.max(0, delay), fn }); return id; };
  const cancel = id => timers.delete(id);
  let document;

  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.listeners = new Map();
      this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this.textContent = ''; this.type = '';
      const classes = new Set();
      this.classList = { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle: (name, force) => { const enabled = force ?? !classes.has(name); if (enabled) classes.add(name); else classes.delete(name); return enabled; } };
      this.dataset = {};
    }
    append(...children) { for (const child of children) { this.children.push(child); if (child && typeof child === 'object') child.parent = this; } }
    prepend(...children) { this.children.unshift(...children); }
    replaceChildren(...children) { this.children = []; this.textContent = children.map(child => typeof child === 'string' ? child : child?.textContent || '').join(''); this.append(...children); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, callback) { const entries = this.listeners.get(name) || []; entries.push(callback); this.listeners.set(name, entries); }
    async emit(name, event = {}) { for (const fn of this.listeners.get(name) || []) await fn({ preventDefault() {}, target: this, ...event }); }
    querySelectorAll(selector) { return this.children.flatMap(child => child instanceof Element ? [child, ...child.querySelectorAll('*')] : []).filter(child => selector === '*' || selector.split(',').some(tag => child.tagName === tag.toUpperCase())); }
    querySelector(selector) { let result = this.querySelectorAll(selector)[0]; if (!result && selector === 'strong') { result = new Element('strong'); this.append(result); } return result || null; }
    contains(child) { return child === this || this.children.some(entry => entry instanceof Element && entry.contains(child)); }
    focus() { document.activeElement = this; }
    select() {}
    reset() { this.querySelectorAll('input,select').forEach(child => { child.value = ''; }); }
    scrollIntoView() {}
    getClientRects() { return this.hidden ? [] : [{}]; }
    showModal() { this.open = true; }
    close() { if (this.open) { this.open = false; void this.emit('close'); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  }

  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const element = new Element(match[1]); element.id = match[3]; element.hidden = /\bhidden\b/.test(match[2]); elements.set(element.id, element);
  }
  const $ = id => { assert.ok(elements.has(id), `Missing real HTML element: ${id}`); return elements.get(id); };
  document = {
    activeElement: null, title: '', getElementById: $, querySelectorAll: () => [], addEventListener() {},
    createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), createTextNode: text => ({ textContent: text }), createDocumentFragment: () => new Element('fragment'),
  };
  const window = { setTimeout: schedule, clearTimeout: cancel, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  class FormData {
    constructor(form) { this.values = (form.id === 'dialog-form' ? $('dialog-fields').children : form.children).filter(child => child?.name && !child.disabled).map(child => [child.name, child.value]); }
    [Symbol.iterator]() { return this.values[Symbol.iterator](); }
  }
  class XMLHttpRequest extends Element {
    constructor() { super(); delete this.open; this.upload = new Element(); this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) {
      const request = { method: this.method, url: this.url, headers: this.headers, body };
      uploads.push(request);
      Promise.resolve().then(() => uploadHandler(request)).then(result => {
        if (this.aborted) return;
        this.status = result.status; this.responseText = JSON.stringify(result.body);
        return this.emit('load');
      }).catch(error => { this.failure = error; void this.emit('error'); });
    }
    abort() { this.aborted = true; void this.emit('abort'); }
  }
  let bootstrap = true;
  const context = vm.createContext({
    document, window, Date: ClockDate, FormData, XMLHttpRequest, Response, Headers, AbortSignal, AbortController, URLSearchParams, Intl, console,
    localStorage: { getItem: () => null, setItem() {} }, location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
    fetch: async (url, options) => {
      if (bootstrap) { bootstrap = false; assert.equal(url, '/api/session'); return new Promise(() => {}); }
      const request = { url, ...options }; requests.push(request); return requestHandler(request);
    },
  });
  const instrumented = source.replace(/\}\)\(\);\s*$/, 'globalThis.testAuth = { state, api, showLogin, showApp, changePassword, sendUpload };\n})();');
  assert.notEqual(instrumented, source);
  vm.runInContext(instrumented, context, { filename: 'public/app.js' });
  const app = context.testAuth;
  const signedIn = (token = 'old-token') => { app.state.user = session(token).user; app.state.csrf = token; $('login-view').hidden = true; $('app-view').hidden = false; };
  const advance = milliseconds => {
    const target = now + milliseconds;
    for (;;) { const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > target) break; now = next[1].at; timers.delete(next[0]); next[1].fn(); }
    now = target;
  };
  return { app, $, requests, uploads, signedIn, advance, timerCount: () => timers.size, now: () => now, respond: fn => { requestHandler = fn; }, upload: fn => { uploadHandler = fn; } };
}

test('stale-tab write refreshes CSRF once and commits the action only once', async () => {
  const h = harness(); h.signedIn(); let committed = 0;
  h.respond(request => {
    if (request.url === '/api/session') return json(session('fresh-token'));
    assert.equal(request.url, '/api/folders');
    if (request.headers['X-CSRF-Token'] === 'old-token') return json({ error: securityError }, 403);
    assert.equal(request.headers['X-CSRF-Token'], 'fresh-token'); committed++;
    return json({ id: 'folder-id' }, 201);
  });
  const result = await h.app.api('/api/folders', { method: 'POST', body: { parent: 'root', name: 'Photos' } });
  assert.equal(result.id, 'folder-id'); assert.equal(committed, 1);
  assert.deepEqual(h.requests.map(request => request.url), ['/api/folders', '/api/session', '/api/folders']);
  assert.equal(h.requests[0].body, h.requests[2].body);
  assert.equal(h.app.state.csrf, 'fresh-token');
});

test('ordinary 403 and network failures never replay a mutation', async () => {
  for (const failure of ['forbidden', 'network']) {
    const h = harness(); h.signedIn();
    h.respond(() => { if (failure === 'network') throw new Error('offline'); return json({ error: 'Administrator access is required.' }, 403); });
    await assert.rejects(h.app.api('/api/admin/settings', { method: 'PATCH', body: { sessionHours: 4 } }));
    assert.equal(h.requests.length, 1);
  }
});

test('CSRF rejection after recovery stops after one retry', async () => {
  const h = harness(); h.signedIn();
  h.respond(request => request.url === '/api/session' ? json(session('fresh-token')) : json({ error: securityError }, 403));
  await assert.rejects(h.app.api('/api/files/file-id', { method: 'DELETE' }), error => error.status === 403);
  assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 2);
  assert.equal(h.requests.filter(request => request.url === '/api/session').length, 1);
});

test('simultaneous stale-tab mutations share the refresh and each commit once', async () => {
  const h = harness(); h.signedIn(); let release; let started;
  const fresh = new Promise(resolve => { release = resolve; });
  const refreshing = new Promise(resolve => { started = resolve; });
  let committed = 0;
  h.respond(request => {
    if (request.url === '/api/session') { started(); return fresh; }
    if (request.headers['X-CSRF-Token'] === 'old-token') return json({ error: securityError }, 403);
    committed++; return json({ ok: true });
  });
  const pending = Promise.all([h.app.api('/api/folders', { method: 'POST', body: { name: 'One' } }), h.app.api('/api/folders', { method: 'POST', body: { name: 'Two' } })]);
  await refreshing; release(json(session('fresh-token'))); await pending;
  assert.equal(h.requests.filter(request => request.url === '/api/session').length, 1);
  assert.equal(committed, 2);
});

test('signing out during CSRF refresh prevents replay or session restoration', async () => {
  const h = harness(); h.signedIn(); let release; let started;
  const fresh = new Promise(resolve => { release = resolve; });
  const refreshing = new Promise(resolve => { started = resolve; });
  h.respond(request => { if (request.url === '/api/session') { started(); return fresh; } return json({ error: securityError }, 403); });
  const pending = h.app.api('/api/files/file-id', { method: 'DELETE' });
  await refreshing; h.app.showLogin(); release(json(session('fresh-token')));
  await assert.rejects(pending, error => error.status === 403);
  assert.equal(h.app.state.user, null);
  assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 1);
});

test('raw upload retries only the explicit pre-action CSRF failure', async () => {
  const h = harness(); h.signedIn(); let committed = 0;
  h.respond(request => { assert.equal(request.url, '/api/session'); return json(session('fresh-token')); });
  h.upload(request => {
    if (request.headers['X-CSRF-Token'] === 'old-token') return { status: 403, body: { error: securityError } };
    committed++; return { status: 201, body: { id: 'uploaded-file' } };
  });
  const file = { name: 'photo.png', size: 12 };
  await h.app.sendUpload({ file, parent: 'root', status: 'uploading', progress: 0 });
  assert.equal(h.uploads.length, 2); assert.equal(committed, 1);
  assert.equal(h.uploads[0].body, file); assert.equal(h.uploads[1].body, file);
  assert.equal(h.requests.length, 1);
});

test('old password-session check cannot expire a newer sign-in', async () => {
  const h = harness(); h.signedIn(); let release; let started;
  const delayed = new Promise(resolve => { release = resolve; });
  const checking = new Promise(resolve => { started = resolve; });
  h.respond(request => {
    if (request.url === '/api/password') return json({ error: 'The current password is incorrect.' }, 401);
    if (request.url === '/api/session') { started(); return delayed; }
    return json({ items: [], breadcrumbs: [{ id: 'root', name: 'My files' }], stats: {} });
  });
  const pending = h.app.api('/api/password', { method: 'POST', body: { currentPassword: 'old password', newPassword: 'new long password' } });
  await checking; await h.app.showApp(session('new-login'));
  release(json({ error: 'Your session has expired.' }, 401));
  await assert.rejects(pending, error => error.status === 401);
  assert.equal(h.app.state.csrf, 'new-login');
  assert.equal(h.app.state.user.username, 'Owner');
  assert.equal(h.$('login-view').hidden, true);
});

test('login honors Retry-After, preserves credential case/whitespace, and unblocks on expiry', async () => {
  const h = harness(); h.app.showLogin(); h.advance(0);
  h.$('username').value = ' Owner '; h.$('password').value = ' Password with spaces! ';
  h.respond(() => json({ error: 'Too many sign-in attempts. Try again later.' }, 429, { 'Retry-After': '2' }));
  await h.$('login-form').emit('submit');
  assert.deepEqual(JSON.parse(h.requests[0].body), { username: 'Owner', password: ' Password with spaces! ' });
  assert.equal(h.$('sign-in').disabled, true);
  assert.match(h.$('sign-in').textContent, /0:02/);
  assert.match(h.$('login-error').textContent, /You can try again at/);
  h.advance(1000); await h.$('login-form').emit('submit'); assert.equal(h.requests.length, 1);
  h.advance(1000); assert.equal(h.$('sign-in').disabled, false); assert.match(h.$('sign-in').textContent, /Sign in/);
  h.respond(() => json({ error: 'Incorrect username or password.' }, 401));
  await h.$('login-form').emit('submit'); assert.equal(h.requests.length, 2); assert.equal(h.$('sign-in').disabled, false);
});

test('password cooldown leaves cancel available and releases timer when dialog closes', async () => {
  const h = harness(); h.signedIn(); h.app.changePassword();
  for (const input of h.$('dialog-fields').children.filter(child => child.name)) input.value = input.name === 'currentPassword' ? 'Old secret password!' : 'New secret password!';
  h.respond(() => json({ error: 'Sign-in is busy. Try again shortly.' }, 429, { 'Retry-After': '2' }));
  await h.$('dialog-form').emit('submit');
  assert.equal(h.$('dialog-submit').disabled, true); assert.equal(h.$('dialog-cancel').disabled, false);
  assert.equal(h.timerCount(), 1);
  await h.$('dialog-cancel').emit('click'); assert.equal(h.timerCount(), 0);
  h.app.showLogin(); h.advance(2000);
  assert.equal(h.$('sign-in').disabled, false); assert.equal(h.timerCount(), 0);
});

test('successful sign-in hides cooldown controls and cancels their timer', async () => {
  const h = harness(); h.app.showLogin(); h.advance(0);
  h.respond(() => json({ error: 'Try again later.' }, 429, { 'Retry-After': '30' }));
  await h.$('login-form').emit('submit'); assert.equal(h.timerCount(), 1);
  h.respond(() => json({ items: [], breadcrumbs: [{ id: 'root', name: 'My files' }], stats: {} }));
  await h.app.showApp(session('new-login'));
  assert.equal(h.$('login-view').hidden, true); assert.equal(h.timerCount(), 0); assert.equal(h.$('sign-in').disabled, false);
});

test('mobile username input opts out of case changes without altering credentials', () => {
  const username = html.match(/<input\b[^>]*id="username"[^>]*>/)?.[0];
  assert.match(username, /autocapitalize="none"/); assert.match(username, /autocorrect="off"/); assert.match(username, /spellcheck="false"/);
});
