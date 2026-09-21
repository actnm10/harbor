import http from 'node:http';
import { open, constants } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './lib.js';

export const PRESENTATION_INPUT_BYTES = 20 * 1024 * 1024;
export const PRESENTATION_OUTPUT_BYTES = 100 * 1024 * 1024;
const unavailable = () => new HttpError(503, 'PowerPoint previews need the local preview renderer. Start the renderer service and try again.');

export async function createPresentationPreview({ filePath, name, size, socketPath = process.env.PRESENTATION_RENDERER_SOCKET, signal, timeoutMs = 100000 }) {
  const extension = path.extname(name).toLowerCase();
  if (!['.ppt', '.pptx'].includes(extension)) throw new HttpError(415, 'Slide previews support PowerPoint .ppt and .pptx files.');
  if (!Number.isSafeInteger(size) || size < 0 || size > PRESENTATION_INPUT_BYTES) throw new HttpError(413, 'PowerPoint previews support files up to 20 MiB. You can still download this file.');
  if (!socketPath) throw unavailable();
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== size) throw new HttpError(409, 'The file changed. Refresh the library and try again.');
    bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (!bytesRead) throw new HttpError(409, 'The file changed. Refresh the library and try again.');
      offset += bytesRead;
    }
  } finally { await handle.close(); }
  return new Promise((resolve, reject) => {
    const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    const request = http.request({ socketPath, path: `/convert?extension=${extension}`, method: 'POST', signal: abort,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': size }, agent: false }, response => {
      let count = 0;
      const chunks = [], successful = response.statusCode === 200;
      const declared = Number(response.headers['content-length']);
      if (successful && (!/^application\/pdf(?:;|$)/i.test(response.headers['content-type'] ?? '') ||
          (Number.isFinite(declared) && declared > PRESENTATION_OUTPUT_BYTES))) {
        response.destroy(); reject(new HttpError(422, 'The generated preview exceeds the preview limits.')); return;
      }
      response.on('data', chunk => {
        count += chunk.length;
        if (count > (successful ? PRESENTATION_OUTPUT_BYTES : 16384)) {
          response.destroy(); reject(new HttpError(422, 'The generated preview exceeds the preview limits.')); return;
        }
        chunks.push(chunk);
      });
      response.on('error', () => reject(abort.aborted ? new HttpError(422, 'Slide preview was cancelled or took too long. Try a smaller presentation.') : unavailable()));
      response.on('end', () => {
        if (!successful) {
          const status = [413, 415, 422, 429, 503].includes(response.statusCode) ? response.statusCode : 422;
          const messages = { 413: 'The presentation exceeds the preview limits.', 415: 'This presentation format cannot be previewed.',
            422: 'This presentation could not be previewed. It may be encrypted, damaged, or too complex.',
            429: 'Another slide preview is being prepared. Try again in a moment.', 503: unavailable().message };
          reject(new HttpError(status, messages[status])); return;
        }
        const pdf = Buffer.concat(chunks, count);
        if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) { reject(new HttpError(422, 'The renderer did not produce a readable PDF.')); return; }
        resolve(pdf);
      });
    });
    request.on('error', () => reject(abort.aborted ? new HttpError(422, 'Slide preview was cancelled or took too long. Try a smaller presentation.') : unavailable()));
    request.end(bytes);
  });
}
