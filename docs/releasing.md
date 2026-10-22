# Release checks

Releases come from https://github.com/SuperTost100/politost-pyxis. CI checks and packages pull requests and pushes to `main`, and another branch can start it manually. Packaging never publishes anything. A release is a manual step after the checks below pass.

The package homepage points to the repository. Linux maintainer metadata uses the owner SuperTost100 and their GitHub noreply address.

## Build targets

`.github/workflows/ci.yml` uses a four-target matrix: macOS arm64 on `macos-15`, macOS x64 on `macos-15-intel`, Windows x64 on `windows-2025`, and Linux x64 on `ubuntu-24.04`. Each target has separate test, packaging and route-audit jobs; the audit is split by language, and pull requests skip the macOS x64 audit. Shared setup is in `.github/actions/prepare`, which caches the pinned fixtures and still verifies their SHA-256. Linux CI installs Xvfb and a runner-local AppArmor profile scoped to the Electron test executable. This permits Chromium's namespace sandbox without adding `--no-sandbox` to the app. The profile addresses the [upstream Ubuntu restriction](https://github.com/electron/electron/issues/41066).

These labels follow the [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Each target explicitly installs Electron from the lockfile, verifies pinned Python/OCR/embedding fixtures, builds the workers, checks types, runs unit and recorded native UI tests, and builds installers with `--publish never`. Route audits use a fresh application process per theme/language/width. The arm64 Mac job also audits largest text.

Installers and their SHA-256 checksums are uploaded as separate per-target artifacts. On macOS the packaging job converts each disk image to ULMO before it collects them (see [Installer size](#installer-size)). The `checksums` job then merges the four `SHA256SUMS` files into one, under GitHub's asset names, and uploads it as the `release-checksums` artifact. A follow-up job generates [build provenance through actions/attest](https://github.com/actions/attest) for runs on `main` only, pushes and manual runs alike. Pull requests and manual runs from other branches get no attestation. Public repositories support attestations on current GitHub plans; private repositories need Enterprise Cloud. Uploading an Actions artifact does not create a public release.

On Windows, CI keeps crash dumps on the ephemeral runner and prints only exception and module metadata; the dumps are never uploaded. Crashpad collection requires the explicit E2E seam and `PYXIS_CRASH_DIR`, and uploads are disabled.

Recorded import and release-loop checks run first to expose core failures early. After packaging, each target checks its packaged executable. `scripts/packaged-fuses.mjs` fails unless the binary has the Electron fuses that `build/after-pack.cjs` sets: RunAsNode, `NODE_OPTIONS` and `--inspect` off, embedded asar integrity validation and load-app-only-from-asar on. Playwright attaches through `--inspect`, so the script then turns that one fuse back on in the unpacked copy; the installers are built by then and keep it off. The executable then runs these specs (`PYXIS_DIST_APP`):

- `window.spec.ts`: the recorded release loop, the window CSP check (no string `eval`, no remote images), and a check that the packaged app reports the same `app.getGPUFeatureStatus()` as Electron's own build.
- `ocr-data.spec.ts` and `scanned-pdf.spec.ts`: the OCR data download and Tesseract reading photos and scanned PDFs.
- `sources.spec.ts`: a 600-page PDF import and the real e5 indexing check, which loads `@huggingface/transformers` from the packaged `node_modules`.

These load the files the packaging rules thin out, so a rule that drops a needed file fails here. macOS also verifies the bundle signature before the fuse change, and verifies the converted disk image and the app mounted from it. Linux grants the packaged executable its own scoped namespace-sandbox profile. Only packages that pass these checks are collected for attestation.

Inspect all four results before publishing. Validate YAML with `actionlint` when installed. Actions are pinned to full commit SHAs resolved from their upstream release tags. Review new action versions before updating those pins.

## Owner release loop

For desktop checks while using the computer, run `PYXIS_E2E_HIDDEN=1 npm run test:e2e -- --workers=1`. The test window stays hidden and macOS activation is disabled; offscreen rendering keeps frames and timers running without an OS window. Playwright still captures screenshots and sends keyboard input to the renderer. This mode checks application keyboard behavior, while OS window activation and native-dialog behavior require visible checks. Packaged test launches additionally require `PYXIS_E2E=1`; ordinary installs ignore the hidden flag. Use disposable, healthy profiles, since workspace recovery can still show its error dialog.

1. Run `npm run typecheck`, `npm test` and `npm run test:e2e`. Review skips and supply pinned runtime fixtures for Python/SymPy and real local embeddings.
2. Run `npm run dist -- --publish never` on the release machine. Verify the app's native modules and downloaded-runtime license notices.
3. Install the result into a fresh profile. Complete onboarding, import a smartbook, create a plan with a real engine, read a lesson, take a quiz, review cards, chat with citations, run a simulation and inspect progress.
4. Export and reopen a plan, open an Anki deck in Anki, then back up and restore the workspace. Confirm OS key storage works; keep keys out of backups and diagnostics.
5. Inspect screenshots for every route in both themes/languages, keyboard behavior and axe results. Run the required full-repository reviews and fix their findings before sign-off.
6. Record platform coverage, skipped checks, unresolved choices and review outcomes in the resources build log. Do not call an untested OS installer verified.
7. Publish only reviewed artifacts with checksums and provenance. Verify provenance with `gh attestation verify FILE --repo SuperTost100/politost-pyxis --source-ref refs/heads/main`. Without `--source-ref`, a build from any branch of the repository passes.

## Version and release notes

1. Run `npm version X.Y.Z --no-git-tag-version --ignore-scripts`. It changes `package.json` and `package-lock.json` without reinstalling.
2. Run `npm run notices`. It writes the version into `src/renderer/src/generated/build-info.json` (Settings, About) and the first line of `docs/THIRD-PARTY-NOTICES.txt`. `npm run build` runs it too, but commit the result with the bump.
3. Add the release to `CHANGELOG.md` in English and Italian, in plain words for students. The GitHub release uses the same text; the in-app update notice links to that page.

Tag and publish only after the owner release loop above.

## Update channel

`package.json` names the GitHub repository under `repository`. Main reads that packaged metadata to query GitHub's latest stable release. The update check is cached for 24 hours. A manual check (the Settings button or Help → Check for updates) skips the cache, but main sends at most one such request a minute. When a newer release exists, Settings → Updates and the update notice offer Download and install next to the release page. Nothing downloads or installs until the student presses it; [SECURITY.md](../SECURITY.md#network-requests) describes the checks and the hand-over on each system.

The in-app download reads the release's asset list, so every stable release must keep these assets:

| Asset                                                        | Used by                                           |
| ------------------------------------------------------------ | ------------------------------------------------- |
| `PoliTost.Pyxis-<version>-arm64-mac.zip` and its `.blockmap` | macOS, Apple Silicon                              |
| `PoliTost.Pyxis-<version>-mac.zip` and its `.blockmap`       | macOS, Intel                                      |
| `PoliTost.Pyxis-<version>-arm64.dmg`                         | macOS, Apple Silicon, when the release has no zip |
| `PoliTost.Pyxis-<version>.dmg`                               | macOS, Intel, when the release has no zip         |
| `PoliTost.Pyxis.Setup.<version>.exe`                         | Windows x64                                       |
| `PoliTost.Pyxis-<version>.AppImage`                          | Linux x64 running as an AppImage                  |
| `politost-pyxis_<version>_amd64.deb`                         | Linux x64 installed from the .deb                 |
| `SHA256SUMS`                                                 | every download                                    |

GitHub turns the spaces in electron-builder's file names into dots. Upload one `SHA256SUMS` for the whole release, in `sha256sum` format, with a line for each installer under its dotted asset name. Use the file from CI's `release-checksums` artifact. `scripts/release-sums.mjs` writes it from the per-target files, and fails if a listed file's hash differs, if an uploaded file has no line, or if one of the installers above is missing. A release with no `SHA256SUMS`, or with no line for a student's installer, makes the in-app download refuse and point to the release page.

### Differential updates

An AppImage and a Mac zip update by downloading only the blocks that changed. `src/main/update-diff.ts` compares the blockmap electron-builder writes for the old file with the new one's, copies the blocks the old file has, and fetches each run of changed blocks with one HTTP Range request. GitHub's release-asset host honors a single `bytes=a-b` range after the redirect and answers 501 to a suffix range (`bytes=-4`) or several ranges in one request, so Pyxis sends one explicit range per request. The rebuilt file must match `SHA256SUMS`; anything else falls back to the whole file.

- AppImage: the old file is the running `$APPIMAGE`. electron-builder appends the blockmap (raw deflate) and its length (4 bytes, big-endian) to the AppImage, so Pyxis reads the new one with two Range requests to the end of the new file. This needs `appImage` builds with electron-builder's embedded blockmap, which it writes by default.
- Mac: Pyxis downloads the zip, not the disk image, and keeps the last verified zip and its blockmap in `userData/update-base`, one per architecture. On its first update a Mac has no kept zip yet, so it downloads the whole zip. A Mac release therefore needs its zips and their `.blockmap` files, and a `SHA256SUMS` line for each zip; without a zip line, Pyxis falls back to the disk image.
- Windows and the .deb always download the whole installer. Windows uses a solid NSIS archive (#184), where one changed file changes most blocks.

Measured with the real release blockmaps, from 0.3.0 to 0.3.1: the AppImage fetches 38.2 of 171.4 MiB (22%) in 10 requests, the Apple Silicon zip 30.4 of 158.7 MiB (19%) in 27, and the Intel zip 30.6 of 166.0 MiB (18%) in 28, plus the zip's blockmap (about 0.2 MiB).

Use stable semantic-version tags that compare correctly to the installed `package.json` version. A fork without a repository URL makes no request, and Settings reports that the release channel is unpublished. Don't invent a placeholder owner or repository to hide that state.

## Installer size

Six things keep the installers small. Each applies per platform and architecture, so check a change against all four CI packaging jobs.

| Rule                                                                               | Where                                  | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only libraries that main, core, the workers or the preload load are `dependencies` | `package.json`                         | electron-builder packs the production tree. Renderer libraries and the content-core parser are `devDependencies` because Vite bundles them into `out/`.                                                                                                                                                                                                                                                                                                                           |
| Exclusion globs for `node_modules`                                                 | `files` in `electron-builder.yml`      | Drops what no process loads. See the list below. In `node_modules` only exclusion patterns count; a later pattern cannot bring a file back.                                                                                                                                                                                                                                                                                                                                       |
| Native and Electron files the target does not load                                 | `build/after-pack.cjs`                 | `pruneUnpacked` keeps `onnxruntime-node/bin/napi-v3/<platform>/<arch>` and `better-sqlite3/prebuilds/<platform>-<arch>.node`, and removes the CUDA, TensorRT and DirectML providers and Linux's unused `libonnxruntime.so.1.x.y`. On macOS `dropSwiftShader` removes `libvk_swiftshader.dylib` and `vk_swiftshader_icd.json`. Both run before macOS signing and fail the build if an expected file is missing.                                                                    |
| `sharp` is a stub                                                                  | `package.json` and `vendor/sharp-stub` | transformers imports `sharp` at load time but uses it only for image pipelines, and Pyxis embeds text only. The stub exports a function that throws, so no libvips ships. On Linux the real libvips stayed inside `app.asar`, where the unpacked `sharp` binding could not load it, and local search could not start. The stub is a root dependency so that the override can name it as `$sharp`; npm resolves a `file:` path in `overrides` from the package that depends on it. |
| `electronLanguages`                                                                | `electron-builder.yml`                 | Keeps `en-US` and `it` (on macOS `en` and `it`). Chromium falls back to `en-US`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Compression                                                                        | `electron-builder.yml` and `ci.yml`    | The deb payload uses xz `-9`, the Windows installer a solid LZMA archive, and CI converts the Mac disk images to ULMO (LZMA). The AppImage keeps gzip; see below.                                                                                                                                                                                                                                                                                                                 |

The `node_modules` exclusions drop:

- source maps, declaration files, Markdown other than license and notice files, and `test`, `docs` and `example` folders;
- onnxruntime-web and the packages only it depends on (protobufjs, flatbuffers, guid-typescript, long, platform), and every transformers bundle except `dist/transformers.node.mjs`, which the ESM embed worker loads, plus its `src/`;
- tesseract.js-core's `*.wasm.js` browser builds and its `-lstm` cores, and zlibjs, which only tesseract.js' browser code imports;
- pdf.js' legacy build, `cmaps`, `standard_fonts`, `image_decoders`, `web`, minified and sandbox builds, and `@napi-rs/canvas`;
- unused libheif builds, zod's TypeScript sources, better-sqlite3's C sources, and the build leftovers in `@mixmark-io/domino/.yarn` and `css-what/src`.

tesseract.js 7.0.0 hands its Node worker a boolean `lstmOnly`, and `getCore` compares it with OEM numbers, so the `-lstm` cores never load. `package.json` pins tesseract.js to that exact version. Before you update it, run `node --test scripts/after-pack.test.mjs` with the pinned tessdata in place: it starts a real Tesseract worker and fails if the new version loads a file that does not ship.

The asar header still lists the files that `pruneUnpacked` deleted from `app.asar.unpacked`, so `asar extract` reports them as missing. Nothing reads them at run time.

Left in on purpose, with the reason:

- The three non-LSTM tesseract.js-core builds (about 10 MB). tesseract.js picks one at run time from the CPU's SIMD support.
- SwiftShader on Linux and Windows. VMs and CI machines without a GPU fall back to it. Windows also keeps `dxcompiler.dll` and `dxil.dll`.

The Windows archive is solid because Pyxis installs updates from the full installer and has no use for electron-updater's per-file blocks, so there is no `.exe.blockmap`. The AppImage runtime unpacks the squashfs image on every start, so its compression costs launch time each time. Measured on 2026-10-17 with the same app files, first window after a fresh mount:

| AppImage squashfs                             | Size    | First window |
| --------------------------------------------- | ------- | ------------ |
| gzip, 128 KiB blocks (current)                | 146 MiB | 1.6 s        |
| zstd level 15                                 | 133 MiB | 1.3 s        |
| xz, 128 KiB blocks                            | 125 MiB | 4.7 s        |
| xz, 1 MiB blocks (`appImage.compression: xz`) | 115 MiB | 5.3 s        |

electron-builder writes zstd only with its static-runtime AppImage toolset, which is still in beta.

`node --test scripts/after-pack.test.mjs` checks the pruning rules for macOS arm64 and x64, Windows x64 and Linux x64 against a fake tree, the SwiftShader removal, and each `node_modules` rule through electron-builder's own file matcher. CI runs it with the notice and checksum tests.

## macOS packaging

`npm run dist` builds in a private temporary directory outside synced folders, then copies the completed artifacts into `dist/`. This avoids File Provider adding Finder metadata to the app bundle before the DMG is sealed. Verify the app mounted from the DMG with `codesign --verify --deep --strict`; an unpacked bundle copied into a synced folder can acquire metadata after packaging.

electron-builder writes UDZO disk images, and its configuration does not accept ULMO. CI's macOS packaging jobs run `hdiutil convert -format ULMO` on each `.dmg`, check it with `hdiutil verify`, mount it to check the app's signature, and rebuild the `.blockmap` before collecting checksums. A local `npm run dist` still writes UDZO.

The macOS after-pack hook signs a private metadata-free copy with the checked-in entitlements, then verifies the complete bundle before copying it back. It uses argument arrays for `ditto` and `codesign`. This ad-hoc signature permits local execution but does not replace Developer ID signing or notarization.
