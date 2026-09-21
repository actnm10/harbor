import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDom, settle } from './helpers/preview-dom.js';

const source = readFileSync(new URL('../public/document-preview.js', import.meta.url), 'utf8');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const item = (name = 'accounts.xlsx', size = 128) => ({ id: 'file/id', kind: 'file', name, size });

function harness() {
  const dom = createDom(); const requests = []; const pdfSources = []; const pages = []; const renders = []; const observers = [];
  let handler = () => { throw new Error('Unexpected preview fetch'); };
  let destroyed = 0, canceled = 0, unauthorized = 0;
  let render = () => ({ promise: Promise.resolve(), cancel() { canceled++; } });
  const pdf = {
    numPages: 2,
    async getPage(number) {
      pages.push(number);
      return {
        getViewport: ({ scale }) => ({ width: 960 * scale, height: 540 * scale }),
        render(options) { renders.push(options); return render(options); },
        async getTextContent() { return { items: [{ str: `Slide ${number}`, hasEOL: true }, { str: '<script>never run</script>' }] }; },
        cleanup() {},
      };
    },
  };
  const library = {
    GlobalWorkerOptions: {}, AnnotationMode: { DISABLE: 0 },
    getDocument(options) { pdfSources.push(options); return { promise: Promise.resolve(pdf), destroy() { destroyed++; } }; },
  };
  class ResizeObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  }
  const context = vm.createContext({
    document: dom.document, window: { devicePixelRatio: 1 }, AbortController, AbortSignal, Uint8Array,
    ResizeObserver, getComputedStyle: () => ({ paddingLeft: '24px', paddingRight: '24px', paddingTop: '24px', paddingBottom: '24px' }),
    requestAnimationFrame: fn => setImmediate(fn), cancelAnimationFrame: clearImmediate,
    fetch: async (url, options) => { requests.push({ url, ...options }); return handler(url, options); },
    importPdfLibrary: async () => library,
  });
  // The real module executes with only transport, PDF.js and the DOM substituted.
  const instrumented = source.replace('export function mountDocumentPreview', 'function mountDocumentPreview')
    .replace("import('/vendor/pdfjs/pdf.min.mjs')", 'globalThis.importPdfLibrary()')
    + '\nglobalThis.mount = mountDocumentPreview;';
  vm.runInContext(instrumented, context, { filename: 'public/document-preview.js' });
  const holder = new dom.Element();
  return {
    ...dom, holder, requests, pdfSources, pages, renders, observers, library,
    mount: selected => context.mount({ item: selected || item(), holder, onUnauthorized: () => { unauthorized++; } }),
    respond: fn => { handler = fn; }, render: fn => { render = fn; },
    destroyed: () => destroyed, canceled: () => canceled, unauthorized: () => unauthorized,
  };
}

test('worksheet selector switches real cells, preserves offsets and treats markup as text', async () => {
  const h = harness();
  h.respond(() => json({ kind: 'spreadsheet', sheets: [
    { name: '<img src=x onerror=alert(1)>', startRow: 7, startColumn: 26, rows: [['<script>alert(1)</script>', 42], ['Total', null]] },
    { name: 'Empty', rows: [] },
    { name: 'Later cells', startRow: 101, startColumn: 28, rows: [['Saved value']], truncated: true },
  ] }));
  const cleanup = h.mount(); await settle();
  assert.equal(h.requests[0].url, '/api/files/file%2Fid/preview');
  assert.equal(h.requests[0].credentials, 'same-origin');
  const selector = h.holder.querySelector('select');
  assert.equal(selector.getAttribute('aria-label'), 'Worksheet');
  assert.equal(selector.querySelector('option').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(h.holder.querySelector('img'), null); assert.equal(h.holder.querySelector('script'), null);
  let table = h.holder.querySelector('table');
  assert.deepEqual(table.querySelector('thead').querySelectorAll('th').map(cell => cell.textContent), ['', 'Z', 'AA']);
  assert.deepEqual(table.querySelector('tbody').querySelectorAll('th').map(cell => cell.textContent), ['7', '8']);
  assert.deepEqual(table.querySelectorAll('td').map(cell => cell.textContent), ['<script>alert(1)</script>', '42', 'Total', '']);
  assert.match(h.holder.textContent, /Formulas are not recalculated/);
  const viewport = h.holder.querySelector('.spreadsheet-viewport'); viewport.scrollTop = 50; viewport.scrollLeft = 100;
  selector.value = '1'; await selector.emit('change');
  assert.equal(h.holder.querySelector('table'), null);
  assert.match(viewport.textContent, /no cells to preview/);
  assert.match(h.holder.querySelector('.spreadsheet-summary').textContent, /Sheet 2 of 3 · 0 rows · 0 columns/);
  assert.equal(viewport.scrollTop, 0); assert.equal(viewport.scrollLeft, 0);
  selector.value = '2'; await selector.emit('change');
  table = h.holder.querySelector('table');
  assert.deepEqual(table.querySelector('thead').querySelectorAll('th').map(cell => cell.textContent), ['', 'AB']);
  assert.equal(table.querySelector('tbody').querySelector('th').textContent, '101');
  assert.equal(table.querySelector('td').textContent, 'Saved value');
  assert.match(h.holder.querySelector('.spreadsheet-summary').textContent, /Sheet 3 of 3.*Preview shortened/);
  cleanup(); assert.equal(h.holder.children.length, 0); assert.equal(h.requests[0].signal.aborted, true);
});

test('workbook-level truncation remains visible and missing worksheets produce a readable error', async () => {
  for (const sheets of [[{ name: 'One', rows: [['Partial']] }], []]) {
    const h = harness(); h.respond(() => json({ kind: 'spreadsheet', sheets, truncated: true }));
    const cleanup = h.mount(); await settle();
    assert.match(h.holder.textContent, sheets.length ? /Preview shortened.*download for all cells and sheets/ : /no worksheets to preview/);
    cleanup();
  }
});

test('closing a pending worksheet preview aborts its request and ignores a late response', async () => {
  const h = harness(); let release;
  h.respond(() => new Promise(resolve => { release = resolve; }));
  const cleanup = h.mount();
  cleanup(); assert.equal(h.requests[0].signal.aborted, true);
  release(json({ kind: 'spreadsheet', sheets: [{ name: 'Late', rows: [['Private']] }] })); await settle();
  assert.equal(h.holder.children.length, 0); assert.equal(h.unauthorized(), 0);
});

test('worksheet and generated-slide unauthorized responses call the session handler', async () => {
  for (const name of ['accounts.xls', 'slides.pptx']) {
    const h = harness(); h.respond(() => json({ error: 'Your session has expired.' }, 401));
    const cleanup = h.mount(item(name)); await settle();
    assert.equal(h.unauthorized(), 1, name); assert.equal(h.pdfSources.length, 0);
    cleanup();
  }
});

test('PowerPoint fetches generated PDF bytes and supports slide navigation, zoom and text view', async () => {
  for (const name of ['slides.ppt', 'slides.PPTX']) {
    const h = harness(); const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    h.respond(() => new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } }));
    const cleanup = h.mount(item(name)); await settle();
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, '/api/files/file%2Fid/preview.pdf');
    assert.equal(h.requests[0].credentials, 'same-origin');
    assert.deepEqual([...h.pdfSources[0].data], [...bytes]);
    assert.equal(h.pdfSources[0].url, undefined, 'PowerPoint source is rendered bytes, not the original Office file');
    assert.equal(h.pdfSources[0].isEvalSupported, false); assert.equal(h.pdfSources[0].enableXfa, false);
    assert.equal(h.library.GlobalWorkerOptions.workerSrc, '/vendor/pdfjs/pdf.worker.min.mjs');
    const paper = h.holder.querySelector('.document-paper');
    assert.ok(h.renders[0].viewport.width <= paper.clientWidth - 48, 'the whole slide fits the available width');
    assert.ok(h.renders[0].viewport.height <= paper.clientHeight - 48, 'the whole slide fits the available height');
    assert.equal(h.holder.querySelector('.document-zoom').getAttribute('aria-label'), 'Slide zoom');
    assert.equal(h.holder.querySelector('.document-zoom').querySelector('option').textContent, 'Fit slide');
    const buttons = h.holder.querySelectorAll('button');
    const previous = buttons.find(button => button.getAttribute('aria-label') === 'Previous slide');
    const next = buttons.find(button => button.getAttribute('aria-label') === 'Next slide');
    const toggle = buttons.find(button => button.textContent === 'Text view');
    assert.equal(previous.disabled, true); assert.equal(next.disabled, false);
    assert.match(h.holder.querySelector('.document-status').textContent, /Slide 1 of 2/);
    await next.emit('click'); await settle();
    assert.equal(previous.disabled, false); assert.equal(next.disabled, true);
    assert.match(h.holder.querySelector('.document-status').textContent, /Slide 2 of 2/);
    const pageInput = h.holder.querySelector('input'); pageInput.value = '99'; await pageInput.emit('change');
    assert.equal(pageInput.value, '2');
    await toggle.emit('click');
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(h.holder.querySelector('canvas').hidden, true);
    assert.match(h.holder.querySelector('pre').textContent, /Slide 2\n<script>never run<\/script>/);
    assert.equal(h.holder.querySelector('script'), null);
    const zoom = h.holder.querySelector('.document-zoom'); zoom.value = '1.5'; await zoom.emit('change'); await settle();
    assert.ok(h.renders.at(-1).viewport.width > h.renders[0].viewport.width);
    cleanup(); assert.equal(h.destroyed(), 1); assert.equal(h.observers[0].disconnected, true);
    assert.equal(h.holder.children.length, 0);
  }
});

test('ordinary PDFs use authenticated content, while oversized presentations stop before rendering', async () => {
  const h = harness(); const cleanup = h.mount(item('report.pdf')); await settle();
  assert.equal(h.requests.length, 0);
  assert.equal(h.pdfSources[0].url, '/api/files/file%2Fid/content');
  assert.equal(h.pdfSources[0].withCredentials, true);
  assert.equal(h.holder.querySelector('.document-zoom').getAttribute('aria-label'), 'PDF zoom');
  assert.equal(h.holder.querySelector('.document-zoom').querySelector('option').textContent, 'Fit width');
  assert.equal(h.renders[0].viewport.width, h.holder.querySelector('.document-paper').clientWidth - 48);
  cleanup();
  const oversized = harness(); oversized.mount(item('slides.pptx', 20 * 1024 * 1024 + 1)); await settle();
  assert.match(oversized.holder.textContent, /PowerPoint previews support files up to 20 MiB/);
  assert.equal(oversized.requests.length, 0); assert.equal(oversized.pdfSources.length, 0);
});

test('closing generated slides during conversion prevents a late PDF from mounting', async () => {
  const h = harness(); let release;
  h.respond(() => new Promise(resolve => { release = resolve; }));
  const cleanup = h.mount(item('slides.ppt')); await settle();
  cleanup(); assert.equal(h.requests[0].signal.aborted, true);
  release(new Response(new Uint8Array([37, 80, 68, 70]))); await settle();
  assert.equal(h.pdfSources.length, 0); assert.equal(h.holder.children.length, 0);
});

test('fit slide reacts to height-only resizing while PDF fit width and manual zoom stay stable', async () => {
  for (const name of ['slides.pptx', 'report.pdf']) {
    const h = harness();
    h.respond(() => new Response(new Uint8Array([37, 80, 68, 70])));
    const cleanup = h.mount(item(name)); await settle();
    const observer = h.observers[0], paper = observer.target;
    const initialHeight = h.renders[0].viewport.height;
    paper.clientHeight = 220; observer.callback(); await settle();
    if (name.endsWith('.pptx')) {
      assert.equal(h.renders.length, 2);
      assert.ok(h.renders.at(-1).viewport.height < initialHeight);
      assert.ok(h.renders.at(-1).viewport.height <= paper.clientHeight - 48);
      assert.ok(h.renders.at(-1).viewport.width <= paper.clientWidth - 48);
      const zoom = h.holder.querySelector('.document-zoom');
      zoom.value = '1.5'; await zoom.emit('change'); await settle();
      const manualRenders = h.renders.length;
      paper.clientHeight = 400; observer.callback(); await settle();
      assert.equal(h.renders.length, manualRenders, 'manual zoom is not replaced by a height resize');
      zoom.value = '0'; await zoom.emit('change'); await settle();
      assert.ok(h.renders.at(-1).viewport.height <= paper.clientHeight - 48);
    } else {
      assert.equal(h.renders.length, 1, 'PDF fit width ignores height-only changes');
      assert.equal(h.renders[0].viewport.height, initialHeight);
    }
    cleanup();
  }
});

test('rapid slide zoom waits for the canceled canvas task and skips stale renders', async () => {
  const h = harness(); const pending = [];
  h.render(() => {
    let resolve; const promise = new Promise(done => { resolve = done; });
    const task = { promise, canceled: false, cancel() { this.canceled = true; }, resolve };
    pending.push(task); return task;
  });
  const cleanup = h.mount(item('report.pdf')); await settle();
  assert.equal(pending.length, 1);
  const zoom = h.holder.querySelector('.document-zoom');
  zoom.value = '1'; await zoom.emit('change');
  zoom.value = '2'; await zoom.emit('change'); await settle();
  assert.equal(pending[0].canceled, true);
  assert.equal(pending.length, 1, 'the same canvas is not reused before cancellation settles');
  pending[0].resolve(); await settle();
  assert.equal(pending.length, 2, 'only the latest zoom renders');
  assert.ok(Math.abs(h.renders[1].viewport.width - 960 * 2 * 1.333333) < 0.01);
  pending[1].resolve(); await settle(); cleanup();
});
