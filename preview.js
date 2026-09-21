import { open, constants } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { HttpError } from './lib.js';

const textExtensions = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log', '.ini', '.conf', '.cfg', '.js', '.ts', '.css', '.py', '.sh', '.c', '.h', '.cpp', '.java', '.sql']);
export const TEXT_PREVIEW_BYTES = 1024 * 1024;
export const WORD_PREVIEW_BYTES = 20 * 1024 * 1024;
let activeDocumentPreviews = 0;

export async function createTextPreview({ filePath, name, size }) {
  const extension = path.extname(name).toLowerCase();
  const isWord = extension === '.doc' || extension === '.docx';
  const isSpreadsheet = extension === '.xls' || extension === '.xlsx';
  const isDocument = isWord || isSpreadsheet;
  if (!isDocument && !textExtensions.has(extension)) throw new HttpError(415, 'This file does not have a text preview. Download it to open it in another app.');
  if (isDocument && size > WORD_PREVIEW_BYTES) throw new HttpError(413, `${isSpreadsheet ? 'Excel' : 'Word'} previews support files up to 20 MiB. You can still download this file.`);
  if (isDocument && activeDocumentPreviews >= 2) throw new HttpError(429, 'Document previews are busy. Try again in a moment.');
  if (isDocument) activeDocumentPreviews++;
  try {
    const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== size) throw new HttpError(409, 'The file changed. Refresh the library and try again.');
      const limit = isDocument ? WORD_PREVIEW_BYTES : TEXT_PREVIEW_BYTES;
      const buffer = Buffer.alloc(Math.min(size, limit));
      let read = 0;
      while (read < buffer.length) {
        const result = await handle.read(buffer, read, buffer.length - read, read);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      if (read !== buffer.length) throw new HttpError(409, 'The file changed. Refresh the library and try again.');
      bytes = buffer;
    } finally { await handle.close(); }
    if (isDocument) return await documentPreview(bytes, extension);
    let encoding = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    const text = new TextDecoder(encoding).decode(bytes);
    if (text.includes('\u0000')) throw new HttpError(415, 'This appears to be a binary file. Download it to open it in another app.');
    return { kind: 'text', text, truncated: size > TEXT_PREVIEW_BYTES, label: 'Text preview' };
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, 'File content is unavailable.');
    throw error;
  } finally { if (isDocument) activeDocumentPreviews--; }
}

function documentPreview(bytes, extension) {
  return new Promise((resolve, reject) => {
    const label = extension === '.xls' || extension === '.xlsx' ? 'Excel' : 'Word';
    const worker = new Worker(new URL('./preview-worker.js', import.meta.url), {
      workerData: { bytes, extension },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().finally(() => error ? reject(error) : resolve(result));
    };
    const timer = setTimeout(() => finish(new HttpError(422, 'This document took too long to preview. Download it to open it locally.')), 8000);
    worker.once('message', message => {
      if (message.error) finish(new HttpError(422, message.error));
      else if (message.kind === 'spreadsheet') finish(null, message);
      else finish(null, { kind: 'text', text: message.text, truncated: message.truncated, label: 'Word text preview' });
    });
    worker.once('error', () => finish(new HttpError(422, `This ${label} document could not be previewed. It may be encrypted, damaged, or too complex.`)));
    worker.once('exit', code => { if (!settled) finish(new HttpError(422, `This ${label} document could not be previewed${code ? ' within the preview limits' : ''}.`)); });
  });
}
