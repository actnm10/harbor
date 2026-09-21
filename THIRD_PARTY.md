# Third-party software

Harbor uses locally hosted libraries; preview files are not sent to an external document service.

- **PDF.js 6.3.289**, Mozilla and contributors, Apache-2.0. Renderer assets and their license are included in `public/vendor/pdfjs`. [Project](https://mozilla.github.io/pdf.js/).
- **word-extractor 1.0.4**, Stuart Watt and contributors, MIT. Extracts readable text from `.doc` and `.docx` files inside a bounded worker. [Project](https://github.com/morungos/node-word-extractor).
- **yauzl 3.4.0**, Josh Wolfe and contributors, MIT. Checks DOCX archive sizes and reads bounded XLSX entries before extraction. The dependency override also supplies this version to word-extractor. [Project](https://github.com/thejoshwolfe/yauzl).
- **SheetJS Community Edition 0.20.3**, SheetJS LLC, Apache-2.0. Reads saved Excel cell values inside the bounded document worker. Installed from the [official SheetJS distribution](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/) with integrity pinned in the lockfile.
- **saxes 6.0.0**, Louis-Dominique Dubeau and contributors, ISC. Validates spreadsheet XML with DTD, depth, and node limits before workbook parsing. [Project](https://github.com/lddubeau/saxes).
- **LibreOffice Impress and Python UNO**, installed from Debian security-maintained packages in the optional renderer image. LibreOffice is primarily MPL-2.0 and includes components under other free-software licenses; package copyright files are included in `/usr/share/doc` inside the image. [Licensing](https://www.libreoffice.org/about-us/licenses/), [headless operation](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html).
- **Carlito, Caladea, Liberation 2, and DejaVu fonts**, installed in the optional renderer from Debian packages. Their license/copyright notices accompany the installed packages in `/usr/share/doc`. These provide substitutes for common presentation fonts.

Transitive library versions and integrity hashes are pinned in `pnpm-lock.yaml`; their licenses accompany the installed packages. PDF character maps, fonts, and image decoder assets carry the license files shipped in their respective vendor directories.
