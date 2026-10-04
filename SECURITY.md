# Security

## Report a problem

There is no public repository or reporting address yet. Send a private report to the project owner through the channel you already use. Once the owner creates the repository, use its private security reporting channel if enabled. Avoid publishing exploitable details in an issue.

Include the version shown in Settings → About, the operating system, reproduction steps and a minimal example made from invented content. Do not include API keys, provider authentication files, real source passages or your workspace database.

## Local storage

Electron stores app configuration under its OS-specific `userData` directory. Its default name is `politost-pyxis`; the exact workspace path is shown in Settings. `config.json` records a moved workspace. The workspace contains SQLite `pyxis.db`, content-addressed blobs, downloaded runtimes and local model files. Study data is not encrypted at rest by Pyxis. Use OS disk encryption if needed.

API keys are encrypted with Electron `safeStorage` and stored in `userData/keys.json`, outside the workspace. Main decrypts them for the core provider adapter; renderer queries cannot read the key file. Linux refuses key storage when only the plaintext `basic_text` backend is available. CLI-provider credentials belong to the CLI and its authentication system.

Workspace backups include the study database and source blobs. They omit API keys, downloaded runtime/model caches, scratch files and the exports folder. Restore keeps runtime/model caches already present on the destination computer. Plan exports omit progress unless selected, but include saved study content and cited source excerpts. Embedding original sources requires a separate export choice. Treat backups, PDFs, Anki decks and shared plans as private documents when their content is private.

## Network requests

| Action                                 | Destination and content                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model generation or grading            | Selected Claude Code/Codex CLI or Anthropic/OpenAI API. Prompts, selected passages and supported attachments leave the computer. The selected provider controls retention and charges.           |
| Import a URL or open a shared plan URL | The chosen HTTP/S site receives the request and normal connection metadata. Source-link extraction rejects private/local network addresses.                                                      |
| Download embeddings                    | Hugging Face serves a pinned multilingual-e5-small model after consent. Files are SHA-256 checked. Search inference runs locally.                                                                |
| Download Python runtime                | jsDelivr serves the pinned Pyodide runtime and wheels. Files are SHA-256 checked. Code runs in an isolated renderer worker.                                                                      |
| Check releases                         | GitHub's releases API, at most once per day when `package.json` has a supported GitHub repository URL. No workspace content is sent. With no repository configured, there is no release request. |
| Open an external link                  | The OS browser receives the selected URL.                                                                                                                                                        |

Pyxis has no account server or telemetry service. The crash-report switch currently saves a preference without submitting reports. Do not interpret it as consent for provider uploads; model requests use the engine selected for the feature.

## Boundaries

The renderer has context isolation, sandboxing and no Node integration. Shared IPC schemas validate requests before core handlers execute them. Main owns dialogs, OS key storage, protocol handlers and artifact writes. Print requests use a separate sandboxed window and sender checks. Python uses a fresh worker, bounded output, an interrupt timeout and restricted runtime requests.

These controls reduce accidental access; they do not make model answers trustworthy. Check generated citations and mathematical results, especially before using them in graded work. Never add source text, prompts or authentication material to diagnostic logs.

Restore checks database integrity, foreign keys and supported schema versions before swapping data. It retains the previous workspace until the replacement core is ready. A sibling journal supports recovery after interruption; mismatched directory identities stop recovery instead of deleting unrelated data. Keep any recovery copies until the owner has inspected them.
