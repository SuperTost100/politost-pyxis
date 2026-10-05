# PoliTost Pyxis

Electron desktop study app. Use Node.js 26 and npm. Core owns persistence and jobs; renderer calls the validated contract in `src/shared`. Follow `CONTRIBUTING.md` and `docs/architecture.md`.

## Checks

- `npm ci` installs Electron and builds native dependencies for its ABI.
- `npm run test:fixtures && npm run build` prepares pinned Python, OCR and embedding fixtures and the workers.
- `npm run typecheck` checks core and renderer.
- `PYXIS_TEST_E5=.tmp/e5 npm test -- --maxWorkers=2` runs unit checks under Electron's Node. Narrow the file list while developing.
- `PYXIS_E2E_HIDDEN=1 npx playwright test --workers=1` runs native checks without showing windows. Linux needs `xvfb-run -a` before `npx`.

Do not rebuild native dependencies for ordinary Node. Do not enable live-provider tests or copy user workspaces, credentials or crash dumps into reports. Use fixture material. Report explicit skips and platform limits. Preserve both English and Italian copy and both themes when changing UI.

## Cursor Cloud

`.cursor/environment.json` builds a Debian environment with Node 26, native build tools, GitHub CLI and Xvfb. Installation prepares dependencies, fixtures and workers. No application starts automatically. For Linux native checks run `xvfb-run -a npx playwright test --workers=1`; keep Electron's sandbox enabled. If the host denies namespace sandboxing, inspect the scoped AppArmor setup in `.github/workflows/ci.yml` rather than adding `--no-sandbox`.

Create a feature branch and a pull request against `main`. Include the resulting behavior and validation evidence. Use GitHub checks to diagnose CI failures, fix the cause and rerun affected checks. CI builds all four platforms and verifies the packaged app. Resolve review comments before merging; do not merge failing checks or publish a release as part of an ordinary development task. Cursor account access, repository permissions, Bugbot and automations are configured in Cursor's dashboard, not by committing secrets here.
