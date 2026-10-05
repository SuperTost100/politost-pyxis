# Release checks

The public repository is https://github.com/SuperTost100/politost-pyxis. Hosted checks start on push; their results must be inspected before claiming other-platform packages verified. Packaging never publishes automatically.

The package homepage points to the repository. Linux maintainer metadata uses the authenticated owner SuperTost100 and their GitHub noreply address.

## Build targets

`.github/workflows/ci.yml` uses a four-target matrix: macOS arm64 on `macos-15`, macOS x64 on `macos-15-intel`, Windows x64 on `windows-2025`, and Linux x64 on `ubuntu-24.04`. Linux CI installs Xvfb and a runner-local AppArmor profile scoped to the Electron test executable. This permits Chromium's namespace sandbox without adding `--no-sandbox` to the app. The profile addresses the [upstream Ubuntu restriction](https://github.com/electron/electron/issues/41066).

These labels follow the [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Each target explicitly installs Electron from the lockfile, verifies pinned Python/OCR/embedding fixtures, builds the workers, checks types, runs unit and recorded native UI tests, and builds installers with `--publish never`. Route audits use a fresh application process per theme/language/width. The arm64 Mac job also audits largest text.

Installers and their SHA-256 checksums are uploaded as separate per-target artifacts. A follow-up job on push/manual runs generates [build provenance through actions/attest](https://github.com/actions/attest). Pull requests have read-only permissions and do not request attestations. Public repositories support attestations on current GitHub plans; private repositories need Enterprise Cloud. Uploading an Actions artifact does not create a public release.

A manual dispatch with `windows_trace=true` runs the recorded Windows OCR/release checks without units, route audits, packaging or attestations. It is diagnostic coverage, not a release gate.

Recorded import and release-loop checks run first to expose core failures early. After packaging, each target repeats the recorded release loop against its packaged executable. macOS also verifies the bundle signature; Linux grants that executable its own scoped namespace-sandbox profile. Only packages that pass this check are collected for attestation.

When the remote exists, run the workflow and inspect all four results before publishing. Validate YAML with `actionlint` when installed. Actions are pinned to full commit SHAs resolved from their upstream release tags. Review new action versions before updating those pins.

## Owner release loop

For desktop checks while using the computer, run `PYXIS_E2E_HIDDEN=1 npm run test:e2e -- --workers=1`. The test window stays hidden and macOS activation is disabled; offscreen rendering keeps frames and timers running without an OS window. Playwright still captures screenshots and sends keyboard input to the renderer. This mode checks application keyboard behavior, while OS window activation and native-dialog behavior require visible checks. Packaged test launches additionally require `PYXIS_E2E=1`; ordinary installs ignore the hidden flag. Use disposable, healthy profiles, since workspace recovery can still show its error dialog.

1. Run `npm run typecheck`, `npm test` and `npm run test:e2e`. Review skips and supply pinned runtime fixtures for Python/SymPy and real local embeddings.
2. Run `npm run dist -- --publish never` on the release machine. Verify the app's native modules and downloaded-runtime license notices.
3. Install the result into a fresh profile. Complete onboarding, import a smartbook, create a plan with a real engine, read a lesson, take a quiz, review cards, chat with citations, run a simulation and inspect progress.
4. Export and reopen a plan, open an Anki deck in Anki, then back up and restore the workspace. Confirm OS key storage works; keep keys out of backups and diagnostics.
5. Inspect screenshots for every route in both themes/languages, keyboard behavior and axe results. Run the required full-repository reviews and fix their findings before sign-off.
6. Record platform coverage, skipped checks, unresolved choices and review outcomes in the resources build log. Do not call an untested OS installer verified.
7. Publish only reviewed artifacts with checksums and provenance. For a created repository, verify provenance with `gh attestation verify FILE --repo OWNER/REPO`.

## Update channel

After creating the repository, add its exact GitHub HTTPS URL to `package.json` under `repository`, then rebuild. Main reads that packaged metadata to query GitHub's latest stable release. The update check is cached for 24 hours, including manual checks, and opens the release page for manual installation. It never installs an update automatically.

Use stable semantic-version tags that compare correctly to the installed `package.json` version. Until a repository URL is configured, Settings reports that the release channel is unpublished and makes no request. Do not invent a placeholder owner or repository to hide that state.

## Restore safety

Restore validates SQLite integrity and foreign-key references before and after migrations. Future schema versions and unexpected ZIP paths are rejected before live data moves. Only canonical hash-named blob files and their metadata accompany the database; restore verifies their hashes and metadata. Existing runtime/model caches are copied into staging and survive both commit and rollback. A fsynced sibling restore journal records the original and staged directory identities. Startup checks that journal before creating workspace folders.

The app keeps the original `.old` workspace until the restored core reports healthy readiness. The archive worker validates the promoted database and commits and cleans up the swap, keeping this work off the main window thread. An interrupted uncommitted swap rolls back to that original. Commitment is recorded before deleting old data; a failed cleanup leaves the committed marker for the next startup and never selects a partly deleted original. A replaced or unexpected directory stops recovery with both copies preserved for inspection.

`npm run dist` builds in a private temporary directory outside synced folders, then copies the completed artifacts into `dist/`. This avoids File Provider adding Finder metadata to the app bundle before the DMG is sealed. Verify the app mounted from the DMG with `codesign --verify --deep --strict`; an unpacked bundle copied into a synced folder can acquire metadata after packaging.

The macOS after-pack hook signs a private metadata-free copy with the checked-in entitlements, then verifies the complete bundle before copying it back. It uses argument arrays for `ditto` and `codesign`. This ad-hoc signature permits local execution but does not replace Developer ID signing or notarization.
