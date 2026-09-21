const PDF_LIMIT = 100 * 1024 * 1024;
const OFFICE_LIMIT = 20 * 1024 * 1024;
let pdfLibrary;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(text, label = text) {
  const element = node('button', 'button secondary document-button', text);
  element.type = 'button';
  element.setAttribute('aria-label', label);
  return element;
}

export function mountDocumentPreview({ item, holder, onUnauthorized = () => {} }) {
  const isPresentation = /\.pptx?$/i.test(item.name);
  const controller = new AbortController();
  let disposed = false, failed = false, loadingTask, renderTask, pdf, pageNumber = 1, zoom = 0, renderVersion = 0;
  let resizeObserver, resizeFrame;
  let showText = false;
  const shell = node('section', 'document-preview-shell');
  const status = node('p', 'document-status', isPresentation ? 'Preparing slides…' : 'Opening document…');
  status.setAttribute('role', 'status');
  shell.append(status);
  holder.replaceChildren(shell);

  function fail(error) {
    if (disposed || error?.name === 'AbortError' || error?.name === 'RenderingCancelledException') return;
    if (error?.status === 401) { onUnauthorized(); return; }
    failed = true;
    renderVersion++;
    renderTask?.cancel();
    resizeObserver?.disconnect();
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    shell.replaceChildren(node('div', 'document-preview-error', error?.message || 'This document could not be previewed. You can still download it.'));
  }

  async function showContent() {
    const response = await fetch(`/api/files/${encodeURIComponent(item.id)}/preview`, {
      credentials: 'same-origin', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
    });
    let data;
    try { data = await response.json(); } catch {
      throw Object.assign(new Error('The server could not provide a document preview. You can still download the file.'), { status: response.status });
    }
    if (!response.ok) throw Object.assign(new Error(data.error || 'The preview is unavailable.'), { status: response.status });
    if (disposed) return;
    if (data.kind === 'spreadsheet') { showSpreadsheet(data); return; }
    const toolbar = node('div', 'document-toolbar');
    const wrap = button('Wrap lines');
    wrap.setAttribute('aria-pressed', 'true');
    const pre = node('pre', 'document-text document-wrap', data.text || 'This document has no readable text.');
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', data.label || 'Document text');
    wrap.addEventListener('click', () => {
      const enabled = pre.classList.toggle('document-wrap');
      wrap.setAttribute('aria-pressed', String(enabled));
    });
    toolbar.append(node('strong', '', data.label || 'Text preview'), wrap);
    shell.replaceChildren(toolbar);
    if (/\.docx?$/i.test(item.name)) shell.append(node('p', 'document-note', 'Readable document text. Original page layout and images are available in the downloaded file.'));
    if (data.truncated) shell.append(node('p', 'document-note', 'This preview is shortened. Download the file to read the complete document.'));
    shell.append(pre);
  }

  function showSpreadsheet(data) {
    if (!Array.isArray(data.sheets) || !data.sheets.length) throw new Error('This workbook has no worksheets to preview.');
    const toolbar = node('div', 'document-toolbar spreadsheet-toolbar');
    const selector = node('select', 'document-sheet-select');
    selector.setAttribute('aria-label', 'Worksheet');
    data.sheets.forEach((sheet, index) => {
      const option = node('option', '', sheet.name || `Sheet ${index + 1}`);
      option.value = String(index); selector.append(option);
    });
    const summary = node('span', 'spreadsheet-summary'); summary.setAttribute('role', 'status');
    toolbar.append(node('strong', '', 'Excel preview'), selector);
    const note = node('p', 'document-note', 'Saved cell values. Formulas are not recalculated. Download for charts and original formatting.');
    const viewport = node('div', 'spreadsheet-viewport'); viewport.tabIndex = 0;
    viewport.setAttribute('aria-label', 'Worksheet cells; scroll to see more columns');
    const footer = node('div', 'document-note spreadsheet-footer'); footer.append(summary);
    shell.replaceChildren(toolbar, note, viewport, footer);

    function columnName(number) {
      let name = '';
      for (let n = number; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
      return name;
    }
    function renderSheet() {
      const index = Number(selector.value) || 0;
      const sheet = data.sheets[index];
      if (!sheet) return;
      const rows = sheet.rows || [];
      const startRow = sheet.startRow || 1, startColumn = sheet.startColumn || 1;
      const columns = rows.reduce((count, row) => Math.max(count, row.length), 0);
      if (!rows.length || !columns) viewport.replaceChildren(node('p', 'document-preview-empty', 'This sheet has no cells to preview.'));
      else {
        const table = node('table', 'spreadsheet-table');
        const caption = node('caption', 'sr-only', `${sheet.name}: saved worksheet values`); table.append(caption);
        const head = node('thead'); const headings = node('tr');
        const corner = node('th', 'spreadsheet-corner'); corner.scope = 'col'; corner.setAttribute('aria-label', 'Row'); headings.append(corner);
        for (let c = 0; c < columns; c++) { const th = node('th', '', columnName(startColumn + c)); th.scope = 'col'; headings.append(th); }
        head.append(headings); table.append(head);
        const body = node('tbody');
        rows.forEach((row, r) => {
          const tr = node('tr'); const number = node('th', '', String(startRow + r)); number.scope = 'row'; tr.append(number);
          for (let c = 0; c < columns; c++) {
            const value = String(row[c] ?? '');
            const td = node('td', /^[-+]?\d[\d,.%\s]*$/.test(value) ? 'spreadsheet-number' : '', value);
            tr.append(td);
          }
          body.append(tr);
        });
        table.append(body); viewport.replaceChildren(table);
      }
      viewport.scrollTop = 0; viewport.scrollLeft = 0;
      summary.textContent = `Sheet ${index + 1} of ${data.sheets.length} · ${rows.length} rows · ${columns} columns${sheet.truncated || data.truncated ? ' · Preview shortened — download for all cells and sheets.' : ''}`;
    }
    selector.addEventListener('change', renderSheet);
    renderSheet();
  }

  async function showPdf() {
    if (item.size > (isPresentation ? OFFICE_LIMIT : PDF_LIMIT)) throw new Error(`${isPresentation ? 'PowerPoint previews support files up to 20' : 'PDF previews support files up to 100'} MiB. Download this file to open it locally.`);
    pdfLibrary ??= import('/vendor/pdfjs/pdf.min.mjs').catch(error => {
      pdfLibrary = undefined;
      throw error;
    });
    const library = await pdfLibrary;
    if (disposed) return;
    library.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    let source = { url: `/api/files/${encodeURIComponent(item.id)}/content` };
    if (isPresentation) {
      const response = await fetch(`/api/files/${encodeURIComponent(item.id)}/preview.pdf`, {
        credentials: 'same-origin', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
      });
      if (!response.ok) {
        let problem; try { problem = await response.json(); } catch { /* Use the readable fallback below. */ }
        throw Object.assign(new Error(problem?.error || 'The slide preview is unavailable. You can still download the presentation.'), { status: response.status });
      }
      const bytes = await response.arrayBuffer();
      if (disposed) return;
      if (bytes.byteLength > PDF_LIMIT) throw new Error('This slide preview is too large. Download the presentation to view it.');
      source = { data: new Uint8Array(bytes) };
    }
    loadingTask = library.getDocument({
      ...source,
      withCredentials: true, isEvalSupported: false, enableXfa: false, useWasm: false,
      isOffscreenCanvasSupported: false,
      cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
    });
    pdf = await loadingTask.promise;
    if (disposed) return;
    const unit = isPresentation ? 'slide' : 'page';
    const unitLabel = isPresentation ? 'Slide' : 'Page';
    const toolbar = node('div', 'document-toolbar pdf-toolbar');
    const previous = button('←', `Previous ${unit}`);
    const next = button('→', `Next ${unit}`);
    const pageInput = node('input', 'document-page-number');
    pageInput.type = 'number'; pageInput.min = '1'; pageInput.max = String(pdf.numPages); pageInput.value = '1';
    pageInput.setAttribute('aria-label', `${unitLabel} number`);
    const pageCount = node('span', '', `of ${pdf.numPages}`);
    const zoomSelect = node('select', 'document-zoom');
    zoomSelect.setAttribute('aria-label', isPresentation ? 'Slide zoom' : 'PDF zoom');
    for (const [value, label] of [[0, isPresentation ? 'Fit slide' : 'Fit width'], [0.75, '75%'], [1, '100%'], [1.25, '125%'], [1.5, '150%'], [2, '200%']]) {
      const option = node('option', '', label); option.value = String(value); zoomSelect.append(option);
    }
    const textToggle = button('Text view'); textToggle.setAttribute('aria-pressed', 'false');
    const paper = node('div', 'document-paper');
    const canvas = node('canvas', 'document-canvas');
    canvas.setAttribute('aria-label', unitLabel); canvas.setAttribute('role', 'img');
    const pageText = node('pre', 'document-text document-wrap');
    pageText.tabIndex = 0; pageText.hidden = true; pageText.setAttribute('aria-label', `${unitLabel} text`);
    paper.append(canvas, pageText);
    toolbar.append(previous, pageInput, pageCount, next, zoomSelect, textToggle);
    const liveStatus = node('p', 'document-status'); liveStatus.setAttribute('role', 'status');
    shell.replaceChildren(toolbar, liveStatus, paper);
    if (isPresentation) shell.insertBefore(node('p', 'document-note', 'Slide preview. Fonts may differ; animations and embedded media are available in the downloaded presentation.'), paper);

    function fitWidth() {
      const style = getComputedStyle(paper);
      return Math.max(1, paper.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    }
    function fitHeight() {
      const style = getComputedStyle(paper);
      return Math.max(1, paper.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
    }

    async function renderPage() {
      if (disposed || failed) return;
      const version = ++renderVersion;
      const priorRender = renderTask;
      priorRender?.cancel();
      pageInput.value = String(pageNumber);
      previous.disabled = pageNumber <= 1;
      next.disabled = pageNumber >= pdf.numPages;
      liveStatus.textContent = `Opening ${unit} ${pageNumber}…`;
      pageText.textContent = `Opening ${unit} text…`;
      try {
      // PDF.js releases a canvas asynchronously after cancellation. Do not resize or
      // reuse it until that render has settled, including during rapid zoom changes.
      if (priorRender) await priorRender.promise.catch(() => {});
      if (disposed || version !== renderVersion) return;
      const page = await pdf.getPage(pageNumber);
      if (disposed || version !== renderVersion) return;
      const pageViewport = page.getViewport({ scale: 1 });
      const availableWidth = fitWidth();
      const scale = zoom ? zoom * 1.333333 : Math.min(2, availableWidth / pageViewport.width, isPresentation ? fitHeight() / pageViewport.height : Infinity);
      const viewport = page.getViewport({ scale });
      const resolution = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12000000 / (viewport.width * viewport.height)), 16384 / viewport.width, 16384 / viewport.height);
      canvas.width = Math.max(1, Math.floor(viewport.width * resolution));
      canvas.height = Math.max(1, Math.floor(viewport.height * resolution));
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute('aria-label', `${unitLabel} ${pageNumber} of ${pdf.numPages}. Use Text view to read its contents.`);
      renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport,
        transform: resolution === 1 ? null : [resolution, 0, 0, resolution, 0, 0],
        annotationMode: library.AnnotationMode.DISABLE,
      });
      await renderTask.promise;
      if (disposed || version !== renderVersion) return;
      liveStatus.textContent = `${unitLabel} ${pageNumber} of ${pdf.numPages}`;
      const content = await page.getTextContent();
      if (disposed || version !== renderVersion) return;
      pageText.textContent = content.items.map(part => part.str ? part.str + (part.hasEOL ? '\n' : ' ') : '').join('') || `This ${unit} has no selectable text. It may contain only images.`;
      page.cleanup();
      } catch (error) {
        if (!disposed && version === renderVersion) fail(error);
      }
    }
    const redraw = () => renderPage().catch(fail);
    previous.addEventListener('click', () => { if (pageNumber > 1) { pageNumber--; redraw(); } });
    next.addEventListener('click', () => { if (pageNumber < pdf.numPages) { pageNumber++; redraw(); } });
    pageInput.addEventListener('change', () => {
      const chosen = Number(pageInput.value);
      if (Number.isInteger(chosen) && chosen >= 1 && chosen <= pdf.numPages) { pageNumber = chosen; redraw(); }
      else pageInput.value = String(pageNumber);
    });
    zoomSelect.addEventListener('change', () => { zoom = Number(zoomSelect.value); redraw(); });
    textToggle.addEventListener('click', () => {
      showText = !showText; textToggle.setAttribute('aria-pressed', String(showText));
      textToggle.textContent = showText ? `${unitLabel} view` : 'Text view'; canvas.hidden = showText; pageText.hidden = !showText;
    });
    let previousFitWidth = fitWidth();
    let previousFitHeight = fitHeight();
    resizeObserver = new ResizeObserver(() => {
      const width = fitWidth(), height = fitHeight();
      if (Math.abs(width - previousFitWidth) < 1 && (!isPresentation || Math.abs(height - previousFitHeight) < 1)) return;
      previousFitWidth = width; previousFitHeight = height;
      if (disposed || failed || zoom) return;
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => { resizeFrame = undefined; redraw(); });
    });
    resizeObserver.observe(paper);
    await renderPage();
  }

  (/\.pdf$/i.test(item.name) || isPresentation ? showPdf() : showContent()).catch(fail);
  return () => {
    disposed = true; renderVersion++; controller.abort(); renderTask?.cancel();
    resizeObserver?.disconnect();
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    if (loadingTask) { try { Promise.resolve(loadingTask.destroy()).catch(() => {}); } catch { /* Cleanup must also tolerate a worker that already failed. */ } }
    shell.remove();
  };
}
