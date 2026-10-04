# Contributing

Use Node.js 26 and npm. Install the platform's C++ toolchain and Python before installing native dependencies.

```bash
npm ci
npm run dev
npm run typecheck
npm test
npm run test:e2e
npm run dist -- --publish never
```

`npm test` runs Vitest under Electron's Node because `better-sqlite3` is built for Electron's ABI. Pass a file to narrow the run, for example `npm test -- src/core/maps/graph.test.ts`. Avoid rebuilding native modules for ordinary Node while running Electron tests.

`npm run build` creates `out/` and regenerates dependency notices. `npm run notices` refreshes license inventory without a build. `npm run shoot` creates development screenshots in `.shots/`; the exhaustive theme, language and width audit is `npx playwright test tests/e2e/ui-audit.spec.ts` after building.

Native end-to-end tests launch isolated Electron apps with temporary workspaces. Recorded model replies cover normal CI runs. Live-provider tests require explicit `PYXIS_LIVE_*` switches and an authenticated provider; do not enable them in CI. Python/SymPy and real embedding inference checks need their pinned local runtime fixtures and report a skip when absent. Read the skip report before describing a run as full validation. Linux UI tests need Xvfb or another display.

## Changes and prompts

Keep the shared IPC contract, Zod validation and renderer types in sync. Route model calls through `src/core/engine/generate.ts`, and keep provider-specific code inside `funnel.ts`. See [engines](docs/engines.md) before adding a feature key.

Prompts live alongside their feature with template and version constants. Change the version when wording or the expected response changes. Include that version in generation provenance and cache keys so saved lessons cannot masquerade as newly generated material. Use a recorded response to check schema repair, cancellation and retry behavior.

Use the existing design tokens and components. Keep English and Italian copy in sync. Check both themes, keyboard operation and the nearby layout before finishing a UI change.

Commit messages should name the area and the change, for example `fix: preserve quiz answers on retry`. Keep fixes reviewable and explain a deliberate limitation. Do not commit API keys, user workspaces, `.tmp/`, `.reviews/`, `out/` or `dist/`. Screenshots committed under `docs/screenshots/` must use fixture material.

The workflow in `.github/workflows/ci.yml` checks and packages four targets. It has not run on GitHub while the repository has no remote. See [release checklist](docs/releasing.md) for checksums, provenance and installed-app checks.
