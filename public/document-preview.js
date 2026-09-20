const PDF_LIMIT = 100 * 1024 * 1024;
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
  const controller = new AbortController();
  let disposed = false, failed = false, loadingTask, renderTask, pdf, pageNumber = 1, zoom = 0, renderVersion = 0;
  let resizeObserver, resizeFrame;
  let showText = false;
  const shell = node('section', 'document-preview-shell');
  const status = node('p', 'document-status', 'Opening document…');
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

  async function showPlainText() {
    const response = await fetch(`/api/files/${encodeURIComponent(item.id)}/preview`, {
      credentials: 'same-origin', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
    });
    let data;
    try { data = await response.json(); } catch {
      throw Object.assign(new Error('The server could not provide a document preview. You can still download the file.'), { status: response.status });
    }
    if (!response.ok) throw Object.assign(new Error(data.error || 'The preview is unavailable.'), { status: response.status });
    if (disposed) return;
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

  async function showPdf() {
    if (item.size > PDF_LIMIT) throw new Error('PDF previews support files up to 100 MiB. Download this file to open it locally.');
    pdfLibrary ??= import('/vendor/pdfjs/pdf.min.mjs').catch(error => {
      pdfLibrary = undefined;
      throw error;
    });
    const library = await pdfLibrary;
    if (disposed) return;
    library.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    loadingTask = library.getDocument({
      url: `/api/files/${encodeURIComponent(item.id)}/content`,
      withCredentials: true, isEvalSupported: false, enableXfa: false, useWasm: false,
      isOffscreenCanvasSupported: false,
      cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
    });
    pdf = await loadingTask.promise;
    if (disposed) return;
    const toolbar = node('div', 'document-toolbar pdf-toolbar');
    const previous = button('←', 'Previous PDF page');
    const next = button('→', 'Next PDF page');
    const pageInput = node('input', 'document-page-number');
    pageInput.type = 'number'; pageInput.min = '1'; pageInput.max = String(pdf.numPages); pageInput.value = '1';
    pageInput.setAttribute('aria-label', 'PDF page number');
    const pageCount = node('span', '', `of ${pdf.numPages}`);
    const zoomSelect = node('select', 'document-zoom');
    zoomSelect.setAttribute('aria-label', 'PDF zoom');
    for (const [value, label] of [[0, 'Fit width'], [0.75, '75%'], [1, '100%'], [1.25, '125%'], [1.5, '150%'], [2, '200%']]) {
      const option = node('option', '', label); option.value = String(value); zoomSelect.append(option);
    }
    const textToggle = button('Text view'); textToggle.setAttribute('aria-pressed', 'false');
    const paper = node('div', 'document-paper');
    const canvas = node('canvas', 'document-canvas');
    canvas.setAttribute('aria-label', 'PDF page'); canvas.setAttribute('role', 'img');
    const pageText = node('pre', 'document-text document-wrap');
    pageText.tabIndex = 0; pageText.hidden = true; pageText.setAttribute('aria-label', 'PDF page text');
    paper.append(canvas, pageText);
    toolbar.append(previous, pageInput, pageCount, next, zoomSelect, textToggle);
    const liveStatus = node('p', 'document-status'); liveStatus.setAttribute('role', 'status');
    shell.replaceChildren(toolbar, liveStatus, paper);

    function fitWidth() {
      const style = getComputedStyle(paper);
      return Math.max(1, paper.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    }

    async function renderPage() {
      if (disposed || failed) return;
      const version = ++renderVersion;
      const priorRender = renderTask;
      priorRender?.cancel();
      pageInput.value = String(pageNumber);
      previous.disabled = pageNumber <= 1;
      next.disabled = pageNumber >= pdf.numPages;
      liveStatus.textContent = `Opening page ${pageNumber}…`;
      pageText.textContent = 'Opening page text…';
      try {
      // PDF.js releases a canvas asynchronously after cancellation. Do not resize or
      // reuse it until that render has settled, including during rapid zoom changes.
      if (priorRender) await priorRender.promise.catch(() => {});
      if (disposed || version !== renderVersion) return;
      const page = await pdf.getPage(pageNumber);
      if (disposed || version !== renderVersion) return;
      const pageViewport = page.getViewport({ scale: 1 });
      const availableWidth = fitWidth();
      const scale = zoom ? zoom * 1.333333 : Math.min(2, availableWidth / pageViewport.width);
      const viewport = page.getViewport({ scale });
      const resolution = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12000000 / (viewport.width * viewport.height)), 16384 / viewport.width, 16384 / viewport.height);
      canvas.width = Math.max(1, Math.floor(viewport.width * resolution));
      canvas.height = Math.max(1, Math.floor(viewport.height * resolution));
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute('aria-label', `PDF page ${pageNumber} of ${pdf.numPages}. Use Text view to read its contents.`);
      renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport,
        transform: resolution === 1 ? null : [resolution, 0, 0, resolution, 0, 0],
        annotationMode: library.AnnotationMode.DISABLE,
      });
      await renderTask.promise;
      if (disposed || version !== renderVersion) return;
      liveStatus.textContent = `Page ${pageNumber} of ${pdf.numPages}`;
      const content = await page.getTextContent();
      if (disposed || version !== renderVersion) return;
      pageText.textContent = content.items.map(part => part.str ? part.str + (part.hasEOL ? '\n' : ' ') : '').join('') || 'This page has no selectable text. It may be a scanned image.';
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
      textToggle.textContent = showText ? 'Page view' : 'Text view'; canvas.hidden = showText; pageText.hidden = !showText;
    });
    let previousFitWidth = fitWidth();
    resizeObserver = new ResizeObserver(() => {
      const width = fitWidth();
      if (Math.abs(width - previousFitWidth) < 1) return;
      previousFitWidth = width;
      if (disposed || failed || zoom) return;
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => { resizeFrame = undefined; redraw(); });
    });
    resizeObserver.observe(paper);
    await renderPage();
  }

  (/\.pdf$/i.test(item.name) ? showPdf() : showPlainText()).catch(fail);
  return () => {
    disposed = true; renderVersion++; controller.abort(); renderTask?.cancel();
    resizeObserver?.disconnect();
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    if (loadingTask) { try { Promise.resolve(loadingTask.destroy()).catch(() => {}); } catch { /* Cleanup must also tolerate a worker that already failed. */ } }
    shell.remove();
  };
}
