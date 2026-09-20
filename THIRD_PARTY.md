# Third-party software

Harbor uses locally hosted libraries; preview files are not sent to an external document service.

- **PDF.js 6.3.289**, Mozilla and contributors, Apache-2.0. Renderer assets and their license are included in `public/vendor/pdfjs`. [Project](https://mozilla.github.io/pdf.js/).
- **word-extractor 1.0.4**, Stuart Watt and contributors, MIT. Extracts readable text from `.doc` and `.docx` files inside a bounded worker. [Project](https://github.com/morungos/node-word-extractor).
- **yauzl 3.4.0**, Josh Wolfe and contributors, MIT. Checks DOCX archive sizes before extraction. The dependency override also supplies this version to word-extractor. [Project](https://github.com/thejoshwolfe/yauzl).

Transitive library versions and integrity hashes are pinned in `pnpm-lock.yaml`; their licenses accompany the installed packages. PDF character maps, fonts, and image decoder assets carry the license files shipped in their respective vendor directories.
