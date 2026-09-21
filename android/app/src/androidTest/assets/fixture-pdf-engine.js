// Run the shipped PDF.js browser and worker bundles, with a small real PDF.
(async () => {
  window.fixturePdf = 'opening';
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  const stream = 'BT /F1 24 Tf 24 80 Td (Harbor PDF fixture) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let text = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(text.length); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach(offset => { text += String(offset).padStart(10, '0') + ' 00000 n \n'; });
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const task = pdfjs.getDocument({
    data: new TextEncoder().encode(text), withCredentials: true,
    isEvalSupported: false, enableXfa: false, useWasm: false, isOffscreenCanvasSupported: false,
    cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/',
  });
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  const canvas = document.createElement('canvas'); canvas.id = 'fixture-pdf-canvas';
  const viewport = page.getViewport({ scale: 1 });
  canvas.width = viewport.width; canvas.height = viewport.height; document.body.append(canvas);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
  const content = await page.getTextContent();
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let darkPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] && pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100) darkPixels++;
  }
  window.fixturePdfResult = { version: pdfjs.version, pages: pdf.numPages, text: content.items.map(item => item.str || '').join(' '), width: canvas.width, height: canvas.height, darkPixels };
  await task.destroy();
  window.fixturePdf = 'done';
})().catch(error => {
  window.fixturePdfError = [error?.name, error?.message, error?.details, error?.stack].filter(Boolean).join('\n') || String(error);
  window.fixturePdf = 'error';
});
