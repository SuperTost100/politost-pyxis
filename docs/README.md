# Pyxis documentation

These pages are for people who change Pyxis or want to know exactly what it does. If you only want to use the app, the [project README](../README.md) covers installation, first launch and privacy.

## How it works

- [Architecture](architecture.md). The main, core and renderer processes, what each one may touch, how jobs survive a restart, and the size limits on imported files.
- [Data model](data-model.md). Every SQLite table, the migration history, and what a backup contains.
- [Engines](engines.md). How model calls go through one adapter, how structured output is validated and repaired, and how to add a feature key.

## Study logic

- [Mastery and recommendations](mastery.md). The mastery formula with worked numbers, the path gates, knowledge gaps, and the score that picks the next step.
- [Card scheduler](scheduler.md). FSRS settings and how the four rating buttons map to FSRS ratings.

## Files Pyxis reads and writes

- [Plan file](plan-file.md). The `.pyxis.json` format for shared plans, what it carries with and without progress, and the import checks. The JSON Schema is [plan-file.schema.json](plan-file.schema.json).
- [Security](../SECURITY.md). Where each file is stored, every network request, and how to report a problem.

## Interface

- [Design system](design-system/README.md). Tokens, typography, components, the logo and the Ant Design mapping.

## Building and releasing

- [Contributing](../CONTRIBUTING.md). Setup, tests, prompt versioning and pull requests.
- [Release checks](releasing.md). The four CI targets, provenance, the manual release loop and the update channel.
- [Local validation, v0.1.0](local-validation.md). The record of checks run on the first macOS build.
- [Third-party notices](notices.md). How the license inventory is generated and its known gaps. The full text is [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
