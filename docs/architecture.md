# Architecture

Pyxis is an Electron app with a React renderer, a privileged main process and a Node utility process for core work.

```text
                         OS dialogs, safeStorage, downloads
                                      |
renderer -- preload bridge --------> main
    |                                 |
    | MessagePort                     | utilityProcess parentPort
    v                                 v
   core <------------------------ startup/keys/workspace handshakes
    |
    +-- SQLite + sqlite-vec + content-addressed blobs
    +-- durable jobs + source/model workers
    +-- cli-funnel -> selected model provider

isolated Python renderer -> fresh Pyodide worker -> MEMFS
sandboxed print renderer -> main printToPDF -> chosen save path
```

Main creates the default `userData/workspace`, records its path in `userData/config.json`, and starts core. Main owns the BrowserWindow, CSP, `safeStorage`, native dialogs, backup/restore coordination, workspace moves and `pyxis-blob:`/runtime protocols. The protocol handlers resolve the current workspace on every request, including after a move. A workspace move stops core, verifies a staged copy, commits the path, then starts the replacement core before removing the original.

Core owns `pyxis.db`, blob storage and domain handlers. `src/shared/ipc.ts` defines request, response and event shapes. Core parses inputs with Zod before dispatching. Errors use `{ code, messageKey, params, detail }`. `src/shared/bridge.ts` describes privileged main/preload operations separately.

Main transfers a fresh message port between core and renderer. React Query handles renderer request state and invalidation. Streams have cancellation; job updates arrive as events. If core exits, main restarts it and transfers a new port. In-flight requests reject with `core-restarted` so the renderer can show the failure and reconnect.

## Storage and jobs

SQLite uses WAL, foreign keys and numbered transactional migrations. Passages have an FTS index and optional local embeddings in sqlite-vec. Source bytes live in content-addressed blobs. Extraction creates immutable document versions; citations retain passage IDs and locator metadata. See [data model](data-model.md).

`src/core/jobs/runner.ts` stores jobs and named steps in SQLite. A successful step stores its output before the next step. Retry preserves completed steps; cancellation aborts the active work. Startup changes unfinished running work to interrupted so it can resume. Source imports, plan creation, generation and simulation grading register feature-specific step handlers. Some short operations are direct IPC requests.

Image imports use the selected vision engine when its model supports images, with the same provider disclosure as other generation. Otherwise they use local OCR, which reads English and Italian `tessdata_fast` files pinned to one tesseract-ocr commit (`src/core/sources/ocr-data.ts`). The files download only after the student's consent, as the `ocr-data-download` job (one step per language, so it shows progress, and it can be cancelled and retried). Every OCR run reads them back, checks size and SHA-256, and gives tesseract.js a private local folder of exactly those bytes, so the library's CDN default and its cache are never used. Without the data, a photo import, a chat photo, a scanned-PDF page and a HEIC fail by name (`ocr-data-missing`, or `ocr-data-integrity` for an altered file) before any row or page is queued. The requests are `sources.ocrDataState` and `sources.ocrData`. Failed vision extraction falls back to OCR, while cancellation or declined disclosure stops the job. Original HEIC/HEIF bytes stay in the blob store; decoded PNG pixels go to vision or OCR in a worker. The document records its extraction path, actual model and versioned prompt. Native file drops resolve real `File` objects in preload and receive the same bounded file grants as picker imports.

Long extraction and embedding work runs in workers, so IPC stays responsive. The embedding model loads once in a shared worker that idles out after a minute. A call made while it is busy gets its own worker.

### Import limits

Core checks a file's size before it allocates a buffer for it.

| Input                     | Limit                                                     |
| ------------------------- | --------------------------------------------------------- |
| Document import           | 256 MB                                                    |
| Photo import              | 40 MB                                                     |
| Chat attachment           | 15 MB, read in the extract worker with a two-minute limit |
| One ZIP entry             | 64 MiB inflated                                           |
| `.docx` or `.pptx`, total | 128 MiB inflated                                          |
| Smartbook, total          | 256 MiB inflated                                          |
| Folder scan               | 2,000 files                                               |
| Extract worker heap       | 2 GiB of V8 heap                                          |

The IPC server reads the size from `fstat` and refuses a file that grows past its cap during the read. A chat document is read in the extract worker (`mode: "extract"`, behind the same two-at-a-time gate as photo decodes, and cancellable) from the bytes core already read, and core stores it in one transaction as a chat-only source.

Office files and smartbooks open through `src/core/sources/zip-bounded.ts`. It reads the central directory only for locations, inflates just the entries it needs in small pushes, and counts the real output, so a lying header or overlapping entries cannot exceed the caps. mammoth only ever sees a stored archive that the reader rebuilt from the XML parts.

The heap limit does not cover buffers, WebAssembly or native decoders (pdf.js stream decoding, HEIC, OCR). Those stay bounded by the size caps and by cancellation. Folder scans hash files by streaming in the extract worker. The blur check and its hash run in the same worker.

### Photos sent to a vision model

A photo goes to a vision model as a fitted copy: at most 1.5 MB of raw bytes and 2,560 px on the long edge, turned upright from EXIF, with transparency flattened onto white, and re-encoded as JPEG when it had to shrink. That keeps eight new and four saved images inside the 5 MB per image and 32 MB per request limits Anthropic documents. The stored original is untouched.

A chat keeps the fitted copy and the original as two attachment rows. The original's type carries an `;original` suffix so a resend never sends both. An imported photo's document records the size sent and what it was resized from. WebP has no decoder here, so an oversized WebP goes through local OCR instead.

### Lessons, quizzes and concurrency

Long-topic lessons cover every passage in consecutive calls with at most 24,000 characters of source text per call. Citation numbers stay stable across parts. The combined lesson is cached only after all parts pass validation, so a failed rewrite preserves the previous lesson. Prepared model-written simulations retain questions without starting an attempt; an explicit Start starts the clock. Quiz deadlines are enforced in core against the saved answer draft.

Default limits are two CLI model jobs, four API model jobs, one demo job and `max(1, availableParallelism - 1)` local jobs.

Python runs in a separate sandboxed renderer/worker context with local Pyodide, SymPy and MEMFS. A fresh worker isolates each run. The configured timeout interrupts execution and a hard timeout terminates it. It cannot read the Electron workspace through Node. PDF export renders sanitized Markdown and KaTeX in a separate print window, waits for readiness, then asks Chromium for an A4 PDF.

## Build and tests

Electron Vite builds main, preload, core and renderer entries into `out/`. `electron-builder.yml` packages native libraries outside ASAR and chooses DMG/ZIP, NSIS or AppImage/deb. `scripts/test-electron.mjs` runs Vitest with Electron's Node ABI. Native Playwright tests launch temporary Electron profiles, rather than the owner's current workspace.

## Restore safety

Restore validates SQLite integrity and foreign-key references before and after migrations. Future schema versions and unexpected ZIP paths are rejected before live data moves. Only canonical hash-named blob files and their metadata accompany the database; restore verifies their hashes and metadata. Existing runtime/model caches are copied into staging and survive both commit and rollback. A fsynced sibling restore journal records the original and staged directory identities. Startup checks that journal before creating workspace folders.

The app keeps the original `.old` workspace until the restored core reports healthy readiness. The archive worker validates the promoted database, then commits and cleans up the swap, so this work stays off the main window thread. An interrupted uncommitted swap rolls back to that original. Commitment is recorded before deleting old data; a failed cleanup leaves the committed marker for the next startup and never selects a partly deleted original. A replaced or unexpected directory stops recovery with both copies preserved for inspection.
