# Bundled libraries

These ship with the app so files are read on the user's computer and nothing is fetched from
another site. Each loads only when someone opens that kind of file.

| Folder | What | Version | Source | License |
|---|---|---|---|---|
| `pdfjs/` | PDF.js, reads PDFs | pdfjs-dist 6.4.299 | npm, checked against the published sha512 | Apache 2.0 (`pdfjs/LICENSE`) |
| `pdfjs/wasm/` | PDF.js image decoders for scanned pages (JBIG2, JPEG 2000, color profiles) | pdfjs-dist 6.4.299 | same package | see the `LICENSE_*` files beside them (BSD-style for JBIG2/PDFium and OpenJPEG, MIT for qcms) |
| `tesseract/` | Tesseract.js, reads text in pictures and scanned PDFs | tesseract.js 7.0.0 (`tesseract.esm.min.js`, `worker.min.js`) | npm, sha512 checked | Apache 2.0 (`tesseract/LICENSE`) |
| `tesseract/` | Tesseract OCR engine, WebAssembly build with SIMD | tesseract.js-core 7.0.0 (`tesseract-core-simd-lstm.wasm.js`) | npm, sha512 checked | Apache 2.0 |
| `tesseract/` | English text model | @tesseract.js-data/eng 1.0.0, `4.0.0_best_int/eng.traineddata.gz` (from tesseract-ocr/tessdata_best) | npm, sha512 checked | Apache 2.0 (model), MIT (package) |

Source map comments were removed from the minified Tesseract.js files, since the maps aren't shipped.
