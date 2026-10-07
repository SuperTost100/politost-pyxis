# Local v0.1.0 validation

This is the record of checks run on the first macOS build. Later releases attach their own `VALIDATION.md`, `SHA256SUMS` and `PROVENANCE.json` to the [GitHub release](https://github.com/SuperTost100/politost-pyxis/releases); v0.1.1 was the first to pass hosted CI on all four targets.

2026-10-05, macOS arm64. Both typechecks pass; 759 unit tests in 129 files pass, zero skips; 5 notice-generator tests pass. Effective recorded native result is 55 passed and three explicitly opt-in live checks. The hidden-window harness failure passed its focused correction rerun.

The route/dialog audit covers 920 normal and 920 largest-text combinations with no outstanding axe, page-error, untranslated-key or horizontal-overflow failure. Failed attempts and focused retries were retained locally; screenshot review covers both themes/languages. Actual Anki 26.09.3 imported and rendered basic math and cloze cards in an offscreen disposable profile.

The local installed real-engine loop passed in 91.451 seconds with reported model claude-sonnet-5, including onboarding, smartbook import, plan, lesson, quiz, cards, simulation, progress, export, backup, restore and cited chat. All 89 installed build files matched tested output. Strict ad-hoc signature verification and bundled Electron license hash checks passed.

The uploaded macOS installer is that verified local artifact. GitHub repository/update and Linux maintainer metadata were configured afterwards in source. The uploaded installer therefore predates repository metadata and needs manual updates; the next hosted build includes the configured update channel. Developer ID signing/notarization and hosted other-platform validation are not claimed for this local artifact.

Hosted CI starts on pull requests and pushes to `main`. Inspect its results before distributing other-platform packages. Test fixtures that need downloaded runtimes/models must be supplied and skips reviewed. Two old dependency notices retain explicitly labeled metadata only; see notices.md.

The first hosted run exposed portability defects in workspace directory identity, Windows key-store flushing and native embedding worker restart. Those were corrected after review. The rebuilt macOS arm64 tree passes both typechecks and all 761 unit tests in 129 files with zero skips. The hidden native workspace move/recovery check also passes. The inode-pinning test applies to POSIX and is explicitly skipped on Windows. Cross-platform acceptance still depends on the next hosted run.
