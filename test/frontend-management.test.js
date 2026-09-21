import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createDom, settle } from './helpers/preview-dom.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const item = (id, name = id, kind = 'file') => ({ id, name, kind, size: 3, mime: 'image/png', updatedAt: '2026-09-20T12:00:00Z' });
const response = (status, value) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const listing = (items = [], breadcrumbs = [{ id: 'root', name: 'My files' }]) => ({ items, breadcrumbs, stats: {} });

function harness(handler = () => response(200, listing()), userAgent = 'Desktop browser') {
  const dom = createDom(html);
  const requests = []; const uploads = []; const downloads = [];
  const timers = new Map(); let timer = 0;
  const window = { setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: id => timers.delete(id), matchMedia: () => ({ matches: false }) };
  dom.$('drop-zone').append(new dom.Element('strong'));
  const create = dom.document.createElement;
  dom.document.createElement = tag => { const el = create(tag); if (tag === 'a') el.click = () => downloads.push(el.href); return el; };
  class Xhr {
    constructor() { this.listeners = {}; this.headers = {}; this.upload = { addEventListener() {} }; this.status = 201; this.responseText = '{}'; }
    open(method, path) { this.path = path; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    send(file) { uploads.push({ path: this.path, file, headers: this.headers }); queueMicrotask(() => this.listeners.load()); }
    abort() { this.listeners.abort?.(); }
  }
  const context = vm.createContext({ document: dom.document, window, navigator: { userAgent }, Intl, Date, URLSearchParams, AbortController, AbortSignal, XMLHttpRequest: Xhr,
    location: { pathname: '/', search: '', hash: '' }, history: { replaceState() {} },
    fetch: async (path, options) => { requests.push({ path, options }); return handler(path, options); },
  });
  const marker = "  $('login-form').addEventListener";
  const folderPickerBinding = source.match(/^  \$\('upload-folder'\)\.addEventListener\('click', chooseFolderUpload\);$/m)?.[0];
  assert.ok(folderPickerBinding, 'the shipped folder-upload button is bound');
  vm.runInContext(source.slice(0, source.indexOf(marker)) + folderPickerBinding + `\nglobalThis.app = { state, selected, renderFiles, renderUploads, loadFiles, trashItems, restoreItems, purgeItems, openDestination, loadDestination, submitDestination, closeDestination, prepareArchive, queueImport, addFiles, readDroppedEntries, importDrop, pumpUploads, retryFailedUploads, showLogin, confirm: () => dialogSubmit({}), getDestination: () => destination }; })();`, context);
  context.app.state.user = { username: 'Owner' }; context.app.state.csrf = 'csrf'; context.app.state.limits.maxUploadBytes = 1024;
  return { ...dom, app: context.app, requests, uploads, downloads, timers };
}
async function idle(h) { for (let i = 0; i < 50 && (h.app.state.uploading || h.app.state.uploads.some(entry => entry.status === 'queued')); i++) await settle(); assert.equal(h.app.state.uploading, false); }

test('bulk trash, restore, purge and empty require the appropriate explicit confirmation and exact JSON', async () => {
  const h = harness((path) => path.startsWith('/api/files?') ? response(200, listing()) : response(200, { count: 2, items: [] }));
  const files = [item('folder', 'Family', 'folder'), item('file', 'hello.png')];
  h.app.trashItems(files);
  assert.equal(h.requests.length, 0, 'opening a confirmation never mutates');
  assert.match(h.$('dialog-description').textContent, /including all files and subfolders/);
  assert.equal(h.$('dialog-submit').textContent, 'Move to recycle bin');
  await h.app.confirm();
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { action: 'trash', ids: ['folder', 'file'] });
  assert.equal(h.requests[0].options.headers['X-CSRF-Token'], 'csrf');
  assert.equal(h.requests[0].options.headers['Content-Type'], 'application/json');
  h.app.restoreItems(files); assert.match(h.$('dialog-description').textContent, /original folder/); await h.app.confirm();
  h.app.purgeItems(files); assert.match(h.$('dialog-description').textContent, /This cannot be undone/); await h.app.confirm();
  h.app.purgeItems([], true); assert.match(h.$('dialog-description').textContent, /every item in the recycle bin/); await h.app.confirm();
  assert.deepEqual(h.requests.filter(r => r.options.method === 'POST').map(r => r.path), ['/api/files/bulk', '/api/trash/restore', '/api/trash/purge', '/api/trash/empty']);
});

test('trash view uses trash metadata, filters names locally and never requests thumbnails or opens previews', async () => {
  const deleted = { ...item('one', '<b>photo.png</b>'), deletedAt: '2026-09-21T10:00:00Z', originalPath: 'My files / Photos / <b>photo.png</b>', purging: true };
  const h = harness(() => response(200, { items: [deleted, item('two', 'notes.txt')], stats: { trashCount: 2, trashBytes: 55, usedBytes: 60 }, retentionDays: 14 }));
  h.app.state.route = { parent: 'root', type: 'trash', q: 'photo' };
  await h.app.loadFiles();
  assert.equal(h.requests[0].path, '/api/trash');
  assert.equal(h.app.state.items.length, 1);
  assert.equal(h.$('files').querySelectorAll('img').length, 0);
  assert.equal(h.$('files').querySelectorAll('a').length, 0);
  assert.equal(h.$('files').querySelector('.file-open').disabled, true);
  assert.equal(h.$('files').querySelector('.file-original-path').textContent, deleted.originalPath);
  assert.match(h.$('trash-notice-text').textContent, /14 days/);
  assert.equal(h.$('files').querySelector('.file-menu-panel').querySelector('button').disabled, true);
  assert.equal(h.$('upload-button').hidden, true);
});

test('selection is keyboard-operable, capped at100, and builds the Android-compatible literal-comma ZIP URL', async () => {
  const h = harness();
  h.app.state.items = Array.from({ length: 101 }, (_, i) => item('id-' + i)); h.app.renderFiles();
  const checks = h.$('files').querySelectorAll('input');
  for (const checkbox of checks) { checkbox.checked = true; await checkbox.emit('change'); }
  assert.equal(h.app.selected.size, 100); assert.equal(checks[100].checked, false);
  assert.match(h.$('selected-count').textContent, /100 maximum/);
  assert.match(h.$('bulk-download').href, /^\/api\/archive\?ids=id-0,id-1,/);
  assert.equal(h.$('bulk-download').href.includes('%2C'), false);
  checks[0].checked = false; await checks[0].emit('change'); assert.equal(h.app.selected.size, 99);
});

test('destination navigation blocks self/descendants; copy has no client timeout or duplicate submission', async () => {
  let finish;
  const h = harness((path, options) => {
    if (options.method === 'POST') return new Promise(resolve => { finish = resolve; });
    const parent = new URL('https://example.test' + path).searchParams.get('parent');
    if (parent === 'inside') return response(200, listing([], [{ id: 'root', name: 'My files' }, { id: 'source', name: 'Source' }, { id: 'inside', name: 'Inside' }]));
    return response(200, listing([item('source', 'Source', 'folder'), item('target', 'Target', 'folder')]));
  });
  h.app.openDestination('copy', [item('source', 'Source', 'folder')]); await settle();
  assert.equal(h.$('destination-folders').querySelectorAll('button')[0].disabled, true);
  await h.app.loadDestination('inside'); assert.equal(h.$('destination-submit').disabled, true);
  await h.app.loadDestination('target');
  const pending = h.app.submitDestination(); await settle(); await h.app.submitDestination();
  const posts = h.requests.filter(request => request.options.method === 'POST'); assert.equal(posts.length, 1);
  assert.equal(posts[0].options.signal, undefined); assert.equal(h.$('destination-cancel').disabled, true);
  assert.deepEqual(JSON.parse(posts[0].options.body), { action: 'copy', ids: ['source'], parent: 'target' });
  finish(response(200, { count: 1, items: [] })); await pending;
  assert.equal(h.$('destination-dialog').open, false);
});

test('folder import preserves nested/empty folders and captured destination without rewriting file bytes', async () => {
  let folderId = 0;
  const h = harness(() => response(201, { id: 'created-' + ++folderId }));
  const file = { name: 'photo.png', size: 3, bytes: 'abc' };
  h.app.queueImport([{ path: 'Trip/Empty', directory: true }, { path: 'Trip/Photos/photo.png', file }], { parent: 'original-folder', name: 'Original', epoch: 0 });
  h.app.state.route.parent = 'navigated-away'; await idle(h);
  assert.deepEqual(h.requests.map(r => JSON.parse(r.options.body)), [{ parent: 'original-folder', name: 'Trip' }, { parent: 'created-1', name: 'Empty' }, { parent: 'created-1', name: 'Photos' }]);
  assert.equal(h.uploads.length, 1); assert.equal(h.uploads[0].file, file);
  assert.equal(new URL('https://example.test' + h.uploads[0].path).searchParams.get('parent'), 'created-3');
  assert.equal(h.app.state.uploads.filter(u => u.status === 'complete').length, 4);
});

test('folder conflicts stay visible, never merge into unknown folders, and dependent retries work after parent succeeds', async () => {
  let fail = true;
  const h = harness(() => fail ? response(409, { error: 'An item with that name already exists.' }) : response(201, { id: 'new-folder' }));
  h.app.queueImport([{ path: 'Trip/photo.png', file: { name: 'photo.png', size: 3 } }], { parent: 'root', name: 'My files', epoch: 0 }); await idle(h);
  assert.equal(h.uploads.length, 0); assert.equal(h.app.state.uploads[0].status, 'failed'); assert.match(h.app.state.uploads[1].error, /parent folder/);
  fail = false; h.app.retryFailedUploads(); await idle(h);
  assert.equal(h.uploads.length, 1); assert.equal(h.app.state.uploads[1].status, 'complete');
});

test('invalid and conflicting import paths are rejected before any server write', () => {
  const h = harness(); const target = { parent: 'root', name: 'My files', epoch: 0 };
  for (const path of ['../secret', 'okay/../secret', '/absolute', 'a//b', 'a\\b', 'a/ trailing', 'a/\u0000b']) {
    assert.throws(() => h.app.queueImport([{ path, file: { name: 'x', size: 0 } }], target), /invalid/);
  }
  assert.throws(() => h.app.queueImport([{ path: 'same', directory: true }, { path: 'same', file: { name: 'same', size: 0 } }], target), /share the path/);
  assert.equal(h.requests.length, 0); assert.equal(h.app.state.uploads.length, 0);
});

test('dragged directory readers consume every batch and retain empty directories', async () => {
  const h = harness(); let reads = 0;
  const file = { name: 'a.txt', size: 0 };
  const entry = { name: 'Folder', isDirectory: true, createReader: () => ({ readEntries: resolve => { reads++; resolve(reads === 1 ? [{ name: 'Empty', isDirectory: true, createReader: () => ({ readEntries: resolve => resolve([]) }) }] : reads === 2 ? [{ name: 'a.txt', isFile: true, file: resolve => resolve(file) }] : []); } }) };
  const entries = await h.app.readDroppedEntries([entry]);
  assert.deepEqual(Array.from(entries, x => x.path), ['Folder', 'Folder/Empty', 'Folder/a.txt']); assert.equal(reads, 3);
});

test('ZIP preflight prevents invalid downloads and releases its busy state without retrying', async () => {
  let valid = false;
  const h = harness(() => valid ? response(204) : response(409, { error: 'Names conflict in the archive.' }));
  const link = h.$('bulk-download');
  await h.app.prepareArchive({ preventDefault() {} }, link, ['one', 'two']);
  assert.equal(h.downloads.length, 0); assert.match(h.$('toasts').textContent, /Names conflict/);
  valid = true; await h.app.prepareArchive({ preventDefault() {} }, link, ['one', 'two']);
  assert.deepEqual(h.downloads, ['/api/archive?ids=one,two&download=1']);
  assert.equal(h.requests.length, 2); assert.ok(h.requests.every(r => r.options.method === 'HEAD'));
  assert.equal(link.getAttribute('aria-busy'), null);
});

test('folder picker rejects providers that omit relative paths instead of flattening files', () => {
  const h = harness();
  h.app.addFiles([{ name: 'photo.png', size: 3, webkitRelativePath: '' }], { parent: 'root', name: 'My files', epoch: 0 }, true);
  assert.equal(h.requests.length, 0); assert.equal(h.app.state.uploads.length, 0);
  assert.match(h.$('toasts').textContent, /does not support folder uploads/);
});

test('folder-upload button shows Android guidance before opening a picker while desktop still opens it', async () => {
  for (const [userAgent, expectedClicks] of [['Mozilla/5.0 Android HarborAndroid/0.1.5-alpha', 0], ['Mozilla/5.0 Chrome/133.0 Desktop', 1]]) {
    const h = harness(undefined, userAgent); let clicks = 0;
    h.$('folder-input').click = () => { clicks++; };
    await h.$('upload-folder').emit('click');
    assert.equal(clicks, expectedClicks);
    if (!expectedClicks) assert.match(h.$('toasts').textContent, /Use a desktop browser for folder uploads\./);
    else assert.equal(h.$('toasts').textContent, '');
  }
});

test('signing out during directory enumeration discards File objects and clears private selection URLs', async () => {
  let finish;
  const entry = { name: 'secret.txt', isFile: true, file: resolve => { finish = resolve; } };
  const h = harness(); h.app.selected.add('secret-id'); h.$('bulk-download').href = '/api/archive?ids=secret-id&download=1';
  h.$('bulk-download').setAttribute('href', '/api/archive?ids=secret-id&download=1');
  const pending = h.app.importDrop({ items: [{ kind: 'file', webkitGetAsEntry: () => entry }], files: [] });
  h.app.showLogin(); finish({ name: 'secret.txt', size: 3 }); await pending;
  assert.equal(h.app.state.uploads.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.app.selected.size, 0);
  assert.equal(h.$('bulk-download').getAttribute('href'), null);
});

test('a late copy response after signout cannot reopen private UI or refresh another session', async () => {
  let finish;
  const h = harness((path, options) => options.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : response(200, listing()));
  h.app.openDestination('copy', [item('one', 'Private document')]); await settle();
  const pending = h.app.submitDestination(); await settle(); h.app.showLogin();
  finish(response(200, { count: 1 })); await pending;
  assert.equal(h.requests.length, 2); assert.equal(h.$('destination-dialog').open, false);
  assert.equal(h.$('destination-description').textContent, ''); assert.equal(h.$('toasts').textContent, '');
});

test('large upload queues bound visible rows while keeping total progress and failed-item controls', () => {
  const h = harness();
  h.app.state.uploads = Array.from({ length: 101 }, (_, i) => ({ id: i, file: { name: 'file-' + i, size: 1 }, status: i === 100 ? 'failed' : 'complete', error: 'Conflict', destination: 'My files' }));
  h.app.renderUploads();
  assert.equal(h.$('upload-list').children.length, 50);
  assert.equal(h.$('upload-page-label').textContent, '1 of 3'); assert.equal(h.$('upload-next').disabled, false);
  assert.equal(h.$('retry-failed-uploads').hidden, false); assert.match(h.$('uploads-summary').textContent, /1 need attention/);
});
