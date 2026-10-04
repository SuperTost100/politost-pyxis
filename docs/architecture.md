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

Default limits are two CLI model jobs, four API model jobs, one demo job and `max(1, availableParallelism - 1)` local jobs. Long extraction and embedding work runs in workers to keep IPC responsive.

Python runs in a separate sandboxed renderer/worker context with local Pyodide, SymPy and MEMFS. A fresh worker isolates each run. The configured timeout interrupts execution and a hard timeout terminates it. It cannot read the Electron workspace through Node. PDF export renders sanitized Markdown and KaTeX in a separate print window, waits for readiness, then asks Chromium for an A4 PDF.

## Build and tests

Electron Vite builds main, preload, core and renderer entries into `out/`. `electron-builder.yml` packages native libraries outside ASAR and chooses DMG/ZIP, NSIS or AppImage/deb. `scripts/test-electron.mjs` runs Vitest with Electron's Node ABI. Native Playwright tests launch temporary Electron profiles, rather than the owner's current workspace.

## Restore safety

Restore validates SQLite integrity and foreign-key references before and after migrations. Future schema versions and unexpected ZIP paths are rejected before live data moves. Only canonical hash-named blob files and their metadata accompany the database; restore verifies their hashes and metadata. Existing runtime/model caches are copied into staging and survive both commit and rollback. A fsynced sibling restore journal records the original and staged directory identities. Startup checks that journal before creating workspace folders.

The app keeps the original `.old` workspace until the restored core reports healthy readiness. An interrupted uncommitted swap rolls back to that original. Commitment is recorded before deleting old data; a failed cleanup leaves the committed marker for the next startup and never selects a partly deleted original. A replaced or unexpected directory stops recovery with both copies preserved for inspection.
