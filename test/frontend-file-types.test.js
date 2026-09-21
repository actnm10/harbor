import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDom, settle } from './helpers/preview-dom.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const file = (name, mime = 'application/octet-stream') => ({ id: 'file-id', kind: 'file', name, mime, size: 32, updatedAt: '2026-09-20T12:00:00Z' });

test('preview download retains an accessible name when its mobile text is hidden', () => {
  const link = html.match(/<a\b[^>]*\bid="preview-download"[^>]*>/)?.[0];
  assert.ok(link);
  assert.match(link, /\baria-label="Download"/);
});

function harness(theme) {
  const dom = createDom(html, theme);
  const mounts = []; let cleaned = 0; let importCount = 0; let load;
  const module = { mountDocumentPreview: options => { mounts.push(options); return () => { cleaned++; }; } };
  load = () => Promise.resolve(module);
  const context = vm.createContext({ document: dom.document, Intl, Date, URLSearchParams,
    importDocumentPreview: () => { importCount++; return load(); },
  });
  // Expose the actual rendering closure, skipping unrelated login/bootstrap wiring.
  // Only module loading is stubbed; openPreview's route and lifecycle run unchanged.
  const marker = "  $('login-form').addEventListener";
  assert.ok(source.includes(marker));
  const instrumented = source.slice(0, source.indexOf(marker)).replace("import('/document-preview.js')", 'globalThis.importDocumentPreview()')
    + 'globalThis.app = { state, classify, canPreviewDocument, fileIcon, renderFiles, renderUploads, openPreview, cleanPreview };\n})();';
  vm.runInContext(instrumented, context, { filename: 'public/app.js' });
  context.app.state.user = { username: 'Owner' };
  return { ...dom, app: context.app, mounts, module, imports: () => importCount, cleaned: () => cleaned, loader: fn => { load = fn; } };
}

const cases = [
  ['report.DOCX', 'application/octet-stream', 'document', 'document', true],
  ['notes.txt', 'text/plain; charset=utf-8', 'document', 'document', true],
  ['report', 'application/msword', 'document', 'document', false],
  ['accounts.XLSX', 'application/octet-stream', 'spreadsheet', 'sheet', true],
  ['accounts.xls', 'application/vnd.ms-excel', 'spreadsheet', 'sheet', true],
  ['accounts', ' Application/Vnd.Openxmlformats-Officedocument.Spreadsheetml.Sheet; charset=utf-8 ', 'spreadsheet', 'sheet', false],
  ['accounts.csv', 'text/csv', 'spreadsheet', 'sheet', true],
  ['accounts.tsv', 'text/tab-separated-values', 'spreadsheet', 'sheet', true],
  ['accounts.xlsm', 'application/octet-stream', 'spreadsheet', 'sheet', false],
  ['accounts.ods', 'application/vnd.oasis.opendocument.spreadsheet', 'spreadsheet', 'sheet', false],
  ['report.PDF', 'application/octet-stream', 'pdf', 'pdf', true],
  ['report', 'application/pdf', 'pdf', 'pdf', false],
  ['slides.PPTX', 'application/octet-stream', 'presentation', 'slides', true],
  ['slides.ppt', 'application/vnd.ms-powerpoint', 'presentation', 'slides', true],
  ['slides', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'presentation', 'slides', false],
  ['slides.pptm', 'application/octet-stream', 'presentation', 'slides', false],
  ['holiday.jpg', 'image/jpeg', 'image', 'image', false],
  ['film.mp4', 'video/mp4', 'video', 'video', false],
  ['song.mp3', 'audio/mpeg', 'audio', 'audio', false],
  ['archive.zip', 'application/zip', 'file', 'file', false],
  ['drawing.svg', 'image/svg+xml', 'file', 'file', false],
  ['page.html', 'text/html', 'document', 'document', false],
  ['xlsx', 'application/octet-stream', 'file', 'file', false],
];

for (const theme of ['light', 'dark']) {
  test(`${theme}: Office MIME aliases and extensions retain precise preview eligibility`, () => {
    const h = harness(theme);
    for (const [name, mime, kind, symbol, previewable] of cases) {
      const item = file(name, mime);
      assert.equal(h.app.classify(item), kind, name);
      assert.equal(h.app.canPreviewDocument(item), previewable, name);
      const icon = h.app.fileIcon(kind);
      assert.equal(icon.querySelector('use').getAttribute('href'), '#i-' + symbol, name);
      assert.equal(icon.getAttribute('aria-hidden'), 'true');
      assert.ok(html.includes(`id="i-${symbol}"`), `${symbol} exists in the shipped sprite`);
    }
    const folder = { ...file('accounts.xlsx', 'application/vnd.ms-excel'), kind: 'folder' };
    assert.equal(h.app.classify(folder), 'folder');
    assert.equal(h.app.canPreviewDocument(folder), false);
    assert.equal(h.app.classify(file('image.png', 'image/svg+xml')), 'file', 'SVG cannot become an inline image through its filename');
  });

  test(`${theme}: cards, list rows, uploads and preview headers share Office icons and labels`, async () => {
    const h = harness(theme);
    const samples = [['report.docx', 'document', 'document'], ['budget.xlsx', 'spreadsheet', 'sheet'], ['report.pdf', 'pdf', 'pdf'], ['talk.pptx', 'presentation', 'slides']];
    for (const [name, kind, symbol] of samples) {
      const item = file(name);
      for (const view of ['grid', 'list']) {
        h.app.state.view = view; h.app.state.items = [item]; h.app.renderFiles();
        assert.equal(h.$('files').className, 'file-' + view);
        const card = h.$('files').querySelector('article');
        assert.equal(card.className, 'file-card kind-' + kind);
        assert.equal(card.querySelector('.file-visual').querySelector('use').getAttribute('href'), '#i-' + symbol);
        assert.match(card.querySelector('button').getAttribute('aria-label'), new RegExp(kind === 'pdf' ? 'PDF document' : kind, 'i'));
      }
      // Browser File objects expose type, whereas API items expose mime.
      h.app.state.uploads = [{ id: 'upload', file: { name, type: item.mime, size: item.size }, status: 'complete', destination: 'My files' }];
      h.app.renderUploads();
      const row = h.$('upload-list').querySelector('.upload-row');
      assert.equal(row.className, 'upload-row kind-' + kind);
      assert.deepEqual(row.querySelectorAll('use').map(use => use.getAttribute('href')), ['#i-' + symbol, '#i-check'], 'status glyph remains independent');
      h.app.openPreview(item); await settle();
      assert.equal(h.$('preview-file-icon').className, 'file-type-icon preview-type-icon kind-' + kind);
      assert.equal(h.$('preview-file-icon').querySelector('use').getAttribute('href'), '#i-' + symbol);
      assert.equal(h.mounts.at(-1).item, item);
      assert.equal(h.$('preview-download').download, name);
      h.app.cleanPreview();
    }
    assert.equal(h.cleaned(), samples.length);
  });
}

test('legacy and modern Office files invoke document preview; unsupported formats keep download fallback', async () => {
  const h = harness('light');
  for (const extension of ['xls', 'xlsx', 'ppt', 'pptx', 'doc', 'docx', 'pdf', 'csv', 'tsv', 'txt']) {
    const item = file('example.' + extension);
    h.app.openPreview(item); await settle();
    assert.equal(h.mounts.at(-1).item, item, extension);
    assert.equal(h.$('preview-content').classList.contains('document-preview-host'), true);
  }
  const imports = h.imports();
  for (const extension of ['xlsm', 'pptm', 'ods', 'zip', 'svg', 'html']) {
    h.app.openPreview(file('example.' + extension)); await settle();
    assert.equal(h.imports(), imports, extension);
    assert.ok(h.$('preview-content').querySelector('.unsupported-preview'));
    assert.equal(h.$('preview-content').classList.contains('document-preview-host'), false);
  }
});

test('renavigation cancels stale Office imports and displays hostile-looking filenames only as text', async () => {
  const h = harness('dark'); let release;
  h.loader(() => new Promise(resolve => { release = resolve; }));
  const item = file('<img src=x onerror=alert(1)>.xlsx');
  h.app.state.items = [item]; h.app.renderFiles();
  assert.equal(h.$('files').querySelector('.file-name').textContent, item.name);
  assert.equal(h.$('files').querySelector('img'), null);
  h.app.openPreview(item);
  h.app.openPreview(file('archive.zip'));
  release(h.module); await settle();
  assert.equal(h.mounts.length, 0);
  assert.equal(h.$('preview-title').textContent, 'archive.zip');
  assert.ok(h.$('preview-content').querySelector('.unsupported-preview'));
});
