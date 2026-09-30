# Architecture

Pyxis is one Electron app with three processes.

```
renderer  -- MessagePort -->  core (utilityProcess)
main      -- parentPort  -->  core
```

Main owns the window, the content security policy, `safeStorage`, and the `pyxis-blob:` protocol. It does not touch the database. On startup it creates `userData/workspace`, records the path in `userData/config.json`, and forks core with that path.

Core owns `pyxis.db`, the blob files, and the job runner. The renderer and core share one `MessageChannelMain`. Main keeps neither end. If core exits, main starts it again and sends a new port. Requests that were in flight reject with `core-restarted`, and the window shows a notice only in that case.

`src/shared/ipc.ts` is the contract. Core checks every input with zod. Errors cross the port as `{ code, messageKey, params, detail }`.

Tests run with `ELECTRON_RUN_AS_NODE=1` so `better-sqlite3` is the Electron build (`postinstall` rebuilds it). Node's module ABI does not match Electron 44.
