import { cp, copyFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const source = path.dirname(require.resolve('pdfjs-dist/package.json'));
const target = path.join(root, 'public/vendor/pdfjs');
await mkdir(target, { recursive: true });
// The official compatibility build includes polyfills required by Android WebView.
for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs']) await copyFile(path.join(source, 'legacy', 'build', name), path.join(target, name));
// Harbor does not run PDF scripts. Keep the unused QuickJS evaluator out of
// published assets, including stale copies from an earlier vendoring run.
for (const name of ['quickjs-eval.js', 'quickjs-eval.wasm']) {
  await rm(path.join(target, 'wasm', name), { force: true });
}
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(path.join(source, directory), path.join(target, directory), {
    recursive: true,
    filter: candidate => !path.basename(candidate).startsWith('quickjs-eval.'),
  });
}
await copyFile(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));
console.log('PDF.js assets copied for local delivery.');
