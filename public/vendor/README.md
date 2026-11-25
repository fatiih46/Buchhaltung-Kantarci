# Mitgelieferte Bibliotheken (unverändert)

| Datei | Paket | Version |
|---|---|---|
| `supabase.js` | [@supabase/supabase-js](https://github.com/supabase/supabase-js) (UMD-Build, MIT) | 2.118.0 |
| `sql-wasm.js`, `sql-wasm.wasm` | [sql.js](https://github.com/sql-js/sql.js) (MIT) | 1.15.0 |
| `tesseract/tesseract.min.js`, `tesseract/worker.min.js` | [tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0) | 7.0.0 |
| `tesseract/tesseract-core-*lstm.wasm.js` | [tesseract.js-core](https://github.com/naptha/tesseract.js-core) (Apache-2.0) | 7.0.0 |
| `pdfjs/pdf.min.mjs`, `pdfjs/pdf.worker.min.mjs` | [pdfjs-dist](https://github.com/mozilla/pdf.js) Legacy-Build (Apache-2.0) | 4.10.38 |
| `tesseract/deu.traineddata.gz` | [@tesseract.js-data/deu](https://www.npmjs.com/package/@tesseract.js-data/deu) `4.0.0_best_int` (Apache-2.0) | 1.0.0 |

Supabase und sql.js werden nur im Cloud-Modus geladen (wenn in `public/config.js` Supabase eingetragen ist).
Die Texterkennung (Tesseract) wird erst geladen, wenn jemand einen Kassenbon scannt – sie läuft komplett auf dem Gerät.
