# Engines

Every model call goes through `generate()` in `src/core/engine/generate.ts`. The only module that imports `cli-funnel` is `src/core/engine/funnel.ts`.

`generate({ prompt, system, selection, schema, signal })` runs one turn. When `schema` is set, the call asks for JSON and parses it. A failed parse can be repaired with the original prompt, the bad answer and the validation issues. `signal` aborts the turn.

`selectionFor(db, feature)` reads `feature_engines`. An empty table falls back to Claude, model `claude-sonnet-4-6`. A missing feature row uses the `default` row. Known features include `default`, `chat`, `plan`, `lesson`, `grading`, `map` and `vision`.

Providers: `claude`, `codex`, `agent`, `antigravity`, `anthropic-api`, `openai-api`. Cursor Agent and Antigravity stay disabled. API keys are ciphertext in `userData/keys.json`, not in the workspace database.

HTTP 401 becomes `engines.errors.refused`. HTTP 429, a spend limit, a usage limit or a quota becomes `engines.errors.quota`.
