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

Main creates the default `userData/workspace`, records its path in `userData/config.json`, and starts core. It writes `config.json` through a flushed temporary file, so a power cut leaves the old path or the new one. A `config.json` that exists but can't be read stops at the "can't find its data folder" dialog instead of opening the default workspace, which could hide a moved one. Main owns the BrowserWindow, CSP, `safeStorage`, native dialogs, backup/restore coordination, workspace moves and `pyxis-blob:`/runtime protocols. The protocol handlers resolve the current workspace on every request, including after a move. A workspace move stops core, verifies a staged copy, commits the path, then starts the replacement core before removing the original. Automatic backups run in a worker thread while core keeps running; a manual backup, restore, move or wipe stops a running one first. See [automatic backups](data-model.md#automatic-backups).

The application menu is built in `src/main/menu.ts` for every platform and build; development builds add reload and developer tools. Menu text lives in main, in Italian and English. The renderer reports its interface language through `setMenuLanguage`, and main rebuilds the menu when it changes. A menu pick sends one command from the list in `src/shared/menu.ts` to the renderer, and the preload drops anything not on that list. `MenuCommands` in the renderer runs the command through the router, but only if `menu-guard.ts` allows it: not during onboarding, with a dialog open, while a page holds a lock (`useMenuLock` in `menu-state.ts`, used by quizzes, simulations, the plan wizard and setup), or while focus is in a text field whose text would be lost. The Ask composer is exempt because it keeps a draft per chat. Help > Keyboard shortcuts opens a dialog that is the one list of every shortcut; add a key to a page and to that list together. A new page for the Go menu is one entry in `goPages` plus its labels.

A `.pyxis` plan file that the system opens with Pyxis, or a second launch passes, is queued in main (`open-file` on macOS, the file argument and `second-instance` elsewhere). Main checks its name, type and size and reads it only when the renderer calls `openedPlan.take`; the renderer never passes a path. `OpenedPlans` in the renderer also takes a file dropped on the window, and sends both to the shared-plan page under the same guard as menu commands. See `src/main/plan-open.ts` and "Opening and importing" in `plan-file.md`.

Core owns `pyxis.db`, blob storage and domain handlers. `src/shared/ipc.ts` defines request, response and event shapes. Core parses inputs with Zod before dispatching. Errors use `{ code, messageKey, params, detail }`. `src/shared/bridge.ts` describes privileged main/preload operations separately.

Main transfers a fresh message port between core and renderer. React Query handles renderer request state and invalidation. The exam list, plan and Progress queries stay fresh for 30 s; a job update or the `plans.evidence` broadcast marks them stale sooner. Streams have cancellation; job updates arrive as events. If core exits, main restarts it and transfers a new port. In-flight requests reject with `core-restarted` so the renderer can show the failure and reconnect.

## Storage and jobs

SQLite uses WAL with `synchronous = NORMAL`, foreign keys and numbered transactional migrations. Main stops core by message, and core checkpoints the WAL and closes the database before it exits. Passages have an FTS index and optional local embeddings in sqlite-vec. Source bytes live in content-addressed blobs. Extraction creates immutable document versions; citations retain passage IDs and locator metadata. See [data model](data-model.md).

`src/core/jobs/runner.ts` stores jobs and named steps in SQLite. A successful step stores its output before the next step. Retry preserves completed steps; cancellation aborts the active work. Startup changes unfinished running work to interrupted so it can resume. Imports, indexing and the OCR and search-model downloads resume on their own when their next step is local work (`resumeLocal`), once per step, so a step that keeps ending the process waits for the student. A step that calls a model, such as a photo's vision read, waits for Resume. An import resumed in its index step leaves its source ready while the vectors are redone. Source imports, plan creation, generation and simulation grading register feature-specific step handlers. Some short operations are direct IPC requests.

Image imports use the selected vision engine when its model supports images, with the same provider acknowledgement as other generation (confirmed at setup, in Settings or once at launch; a task never waits for it, and automatic selection skips an engine that is not acknowledged). Otherwise they use local OCR, which reads English and Italian `tessdata_fast` files pinned to one tesseract-ocr commit (`src/core/sources/ocr-data.ts`). The files download only after the student's consent, as the `ocr-data-download` job (one step per language, so it shows progress, and it can be cancelled and retried). Every OCR run reads them back, checks size and SHA-256, and gives tesseract.js a private local folder of exactly those bytes, so the library's CDN default and its cache are never used. Without the data, a photo import, a chat photo, a scanned-PDF page and a HEIC fail by name (`ocr-data-missing`, or `ocr-data-integrity` for an altered file) before any row or page is queued. The requests are `sources.ocrDataState` and `sources.ocrData`. Failed vision extraction falls back to OCR, while cancellation or declined disclosure stops the job. Original HEIC/HEIF bytes stay in the blob store; decoded PNG pixels go to vision or OCR in a worker. The document records its extraction path, actual model and versioned prompt. Native file drops resolve real `File` objects in preload and receive the same bounded file grants as picker imports.

A PowerPoint import adds each slide's speaker notes, found through the slide's relationships, to that slide's passage after the label `Speaker notes:`. A PDF locked with a password stops as `pdf-password-required` (or `pdf-password-wrong`). The student's answer goes to core with `sources.unlockPdf`, which keeps it in memory for the one read of that import and never in the job's input, so a retry or a resume after a restart asks again. A source saved from a link can be fetched again with `sources.refresh`: a changed page becomes the next extraction version of the same source, as a re-extract or a book update does, and older passages keep the copy they were read from.

Long extraction and embedding work runs in workers, so IPC stays responsive. The embedding model loads once in one embedding worker, which serves calls in order and releases the model after a minute without work. A search goes before waiting indexing batches. The worker thread stays up for the life of core, and a cancel stops inside it, because ONNX Runtime can abort the process when its thread is terminated or replaced (#58).

### Import limits

Core checks a file's size before it allocates a buffer for it. An import job reads its file in the extract worker, two at a time across all jobs; the next step stores the passages under the hash the file was queued with, without reading the file into core again.

| Input                     | Limit                                                     |
| ------------------------- | --------------------------------------------------------- |
| Document import           | 256 MB                                                    |
| Photo import              | 40 MB                                                     |
| Chat attachment           | 15 MB, read in the extract worker with a two-minute limit |
| One ZIP entry             | 64 MiB inflated                                           |
| `.docx` or `.pptx`, total | 128 MiB inflated                                          |
| Smartbook, total          | 256 MiB inflated                                          |
| Folder scan               | 2,000 files, 12 levels deep, 20,000 entries read          |
| Extract worker heap       | 2 GiB of V8 heap                                          |

The IPC server reads the size from `fstat` and refuses a file that grows past its cap during the read. A chat document is read in the extract worker (`mode: "extract"`, behind the same two-at-a-time gate as photo decodes, and cancellable) from the bytes core already read, and core stores it in one transaction as a chat-only source.

Office files and smartbooks open through `src/core/sources/zip-bounded.ts`. It reads the central directory only for locations, inflates just the entries it needs in small pushes, and counts the real output, so a lying header or overlapping entries cannot exceed the caps. mammoth only ever sees a stored archive that the reader rebuilt from the XML parts.

The heap limit does not cover buffers, WebAssembly or native decoders (pdf.js stream decoding, HEIC, OCR). Those stay bounded by the size caps and by cancellation. Folder scans hash files by streaming in the extract worker. The blur check and its hash run in the same worker.

### Photos sent to a vision model

A photo goes to a vision model as a fitted copy: at most 1.5 MB of raw bytes and 2,560 px on the long edge, turned upright from EXIF, with transparency flattened onto white, and re-encoded as JPEG when it had to shrink. That keeps eight new and four saved images inside the 5 MB per image and 32 MB per request limits Anthropic documents. The stored original is untouched.

A chat keeps the fitted copy and the original as two attachment rows. The original's type carries an `;original` suffix so a resend never sends both. An imported photo's document records the size sent and what it was resized from. WebP has no decoder here, so an oversized WebP goes through local OCR instead.

### Lessons, quizzes and concurrency

Long-topic lessons cover every passage in consecutive calls with at most 24,000 characters of source text per call. Citation numbers stay stable across parts. The combined lesson is cached only after all parts pass validation, so a failed rewrite preserves the previous lesson. Prepared model-written simulations retain questions without starting an attempt; an explicit Start starts the clock. A plan with past exams (`src/core/study/pastPapers.ts`) reads each one with a `paper-read` job, and the simulation builder then copies their question count, types and difficulty; the simulation setup lets the student choose the standard format instead. Quiz deadlines are enforced in core against the saved answer draft. A timed quiz takes no answers or checks until every question is written, and its clock starts at the first save after that. A graded attempt, its evidence and its path step carry the time its answers froze, at submit or at time-up, not the time grading finished.

Default limits are two CLI model jobs, four API model jobs, one demo job and `max(1, availableParallelism - 1)` local jobs.

Python runs in a separate sandboxed renderer/worker context with local Pyodide, SymPy and MEMFS. A fresh worker isolates each run. The configured timeout interrupts execution and a hard timeout terminates it. It cannot read the Electron workspace through Node. Grading uses the same SymPy worker as the Ask checks (`check_grade` in `src/sandbox/symbolic.py`). For a math answer it compares the student's final answer with the reference (expressions, equations, solution sets and intervals) and finds the first step of a worked solution that does not follow from the one before. Core sends the verdict to the grading model as `mathCheck`, and credits a fill-in blank that is the same mathematics as an accepted answer. Grading waits at most 12 s for the check, and without the downloaded runtime, or when SymPy cannot read the text, it grades as before. Lessons and Ask answers can ask for a figure as matplotlib code in a `pyxis-figure` block, when the runtime is downloaded. Core runs each figure's code there once, with an 8-second limit and at most 4,000 characters, and stores the PNG with the lesson or message; a figure that fails is removed and the rest is saved. PDF export renders sanitized Markdown and KaTeX in a separate print window, waits for readiness, then asks Chromium for an A4 PDF. A concept map's PDF also carries the SVG that `maps.export` draws in core. The print page shows it as an image on a first page sized to the drawing, then the outline follows on A4.

## Build and tests

Electron Vite builds main, preload, core and renderer entries into `out/`. `electron-builder.yml` packages native libraries outside ASAR and chooses DMG/ZIP, NSIS or AppImage/deb. `scripts/test-electron.mjs` runs Vitest with Electron's Node ABI. Native Playwright tests launch temporary Electron profiles, rather than the owner's current workspace.

## Restore safety

Restore validates SQLite integrity and foreign-key references before and after migrations. Future schema versions and unexpected ZIP paths are rejected before live data moves. Only canonical hash-named blob files and their metadata accompany the database; restore verifies their hashes and metadata. Existing runtime/model caches are copied into staging and survive both commit and rollback. A fsynced sibling restore journal records the original and staged directory identities. Startup checks that journal before creating workspace folders.

The app keeps the original `.old` workspace until the restored core reports healthy readiness. The archive worker validates the promoted database, then commits and cleans up the swap, so this work stays off the main window thread. A commit that fails (a full disk, or a journal file Windows keeps locked) is tried twice more. After that, main stops core and tries once more, since a stopped core has let go of its files. If that fails too, main rolls back to the original at once, and Settings says the data from before the restore is back. If core won't stop or the rollback fails, core stays stopped, no backup, restore, move or wipe can start, and Settings asks the student to reopen Pyxis so startup recovery can finish. Core never keeps running on a promoted copy that the next launch would roll back and delete. An interrupted uncommitted swap rolls back to that original. Commitment is recorded before deleting old data; a failed cleanup leaves the committed marker for the next startup and never selects a partly deleted original. A replaced or unexpected directory stops recovery with both copies preserved for inspection.
