# Engines

Model calls go through `generate()` in `src/core/engine/generate.ts`. `src/core/engine/funnel.ts` is the only adapter that imports `cli-funnel`. It runs providers with `access: "none"` and an isolated scratch working directory.

```ts
const result = await generate({
  prompt,
  system,
  selection: selectionFor(db, "lesson"),
  schema: lessonSchema,
  signal,
});
```

The result carries text, provider, model and input-token usage. Structured requests convert the Zod schema to JSON Schema, disallow unknown object properties and parse the response again with Zod. Invalid output triggers at most two repair turns. Final failure becomes `invalid-output`. `onDelta` streams text; `signal` cancels a turn. Supported image attachments have explicit media types and data.

`selectionFor(db, feature)` reads `feature_engines`. An unset feature uses `default`. With no `default` row it throws `engine-missing`. It also works out the reasoning effort, see below. The engine screen discovers available models and tests the selected one.

## Automatic choice

Pyxis picks the engine, model and effort for each feature itself. `planAuto()` in `src/core/engine/auto.ts` is a pure function of the ready providers and the models each one lists. It never calls a model, so it costs no usage. The tiers, weights and model patterns live in `resources/model-tiers.json`.

- Each feature needs a tier: `chat` and `map` fast, `lesson`, `vision` and `default` mid, `grading` and `plan` strong. Vision only considers models that read images (`capabilities.ts`). A feature key missing from the file counts as mid.
- Model patterns are regular expressions per tier, cheapest sufficient first. Claude: haiku fast, sonnet mid, opus then fable strong. Codex and OpenAI: luna, mini and nano fast, terra mid, sol then astra strong. Antigravity: Gemini Flash fast, Gemini Pro mid and strong (Claude sonnet and opus as fallbacks). Cursor Agent: Gemini Flash, luna, Composer, then mini/nano fast; Claude sonnet, terra, then Gemini Pro mid; Claude opus then sol strong. Cursor's `-thinking` variants and Fable (listed there without zero data retention) never match. Within a pattern the highest version the provider lists wins. A tier with no match steps to the neighbouring tier, and the last resort is the first model the provider lists.
- Effort follows the tier, see [Reasoning effort](#reasoning-effort).
- A provider is ready when it is installed, signed in and not disabled. API providers count only with a stored key that the provider accepts. CLIs win: API providers are used only when no CLI is ready, because they bill per token.
- With two or more ready providers each tier has a preference order (fast: Antigravity, Codex, Cursor, Claude Code; mid: Claude Code, Cursor, Antigravity, Codex; strong: Claude Code, Codex, Cursor, Antigravity). Features then move from the busiest provider to the idlest while that narrows the gap. A feature's load is its weight times its tier cost, so frequent chat on a cheap model and rare plans on a strong model each weigh what they cost. Every ready CLI gets at least one feature.

Defaults for common mixes, as `src/core/engine/auto.test.ts` checks them against CLI Funnel 0.4 model lists:

| Ready CLIs                | Chat and maps       | Lessons and default                              | Photos             | Plans       | Grading     |
| ------------------------- | ------------------- | ------------------------------------------------ | ------------------ | ----------- | ----------- |
| Claude Code + Codex       | Codex luna          | Claude sonnet                                    | Claude sonnet      | Claude opus | Codex sol   |
| Claude Code + Antigravity | Gemini Flash        | Claude sonnet                                    | Claude sonnet      | Claude opus | Gemini Pro  |
| Claude Code + Cursor      | Cursor Gemini Flash | Claude sonnet                                    | Claude sonnet      | Claude opus | Cursor opus |
| Codex + Antigravity       | Gemini Flash        | Gemini Pro (lessons), Codex terra (default)      | Codex terra        | Codex sol   | Codex sol   |
| Cursor + Antigravity      | Gemini Flash        | Cursor sonnet                                    | OCR (no image CLI) | Cursor opus | Gemini Pro  |
| All four                  | Gemini Flash        | Cursor sonnet (lessons), Claude sonnet (default) | Claude sonnet      | Claude opus | Codex sol   |

An automatic row in `feature_engines` carries `"auto": true` in its JSON. A row without it is pinned. `engines.setFeature` pins, and `engines.autoConfigure` with `reset` returns features to automatic. Only automatic rows are rewritten. When no engine is ready they are removed, which brings back `engine-missing`. If every ready engine fails to list models, the current rows stay.

CLI Funnel has no sign-out for Antigravity, so `engines.overview` reports `capabilities.signOut` false for it, the engine screen explains how to sign out in the program itself, and `engines.logout` refuses it with `engines.signOutUnsupported`.

`engines.autoConfigure` (`{ reset?, features? }` returning `{ ready, features }`) recomputes on demand. Core also runs it at startup, after sign-in, sign-out, update and removal, when a key is added or removed, and when `engines.overview` sees a changed engine set (at most every 30 seconds). `selectionFor` drops the `auto` flag, so callers see the same shape as before.

Feature keys are `default`, `chat`, `plan`, `lesson`, `grading`, `map` and `vision`. Providers are `claude`, `codex`, Cursor `agent`, `antigravity`, `anthropic-api` and `openai-api`. A CLI provider is disabled unless its CLI Funnel adapter lists `none` in `capabilities.access`. CLI Funnel 0.4 runs Cursor Agent in ask mode from its own workspace, whose `.cursor/cli.json` denies shell, file reads and writes, web fetches and MCP tools. It runs Antigravity with a pre-tool hook that denies every tool. Cursor's grep and glob tools still run, but only inside that empty workspace. Other CLI Funnel providers, such as `gemini-api` and `ollama`, are not offered. API keys are encrypted in `userData/keys.json`; core receives decrypted values through a main-process handshake. The database stores model selections, not keys.

## Reasoning effort

Every task runs at a reasoning effort that fits it, whether Pyxis or the student picked the model. `taskEffort()` in `src/shared/effort.ts` reads the level from `resources/model-tiers.json`:

| Task                                        | Effort   |
| ------------------------------------------- | -------- |
| Chat (Ask) and maps                         | `low`    |
| Lessons, quizzes, cards and drills, photos  | `medium` |
| The default engine                          | `medium` |
| Plans, grading of exercises and simulations | `high`   |

`selectionFor` resolves the effort on every call, so a row saved before this existed gets its level without a migration.

1. If the student picked a level for the task and the model lists it, that level wins.
2. Otherwise the task's level, when the model lists it.
3. Otherwise the nearest level the model lists. `nearestEffort()` looks lower first for `low` and `medium`, and higher first for `high`, then the other way. `none` is never chosen, and neither is a level the scale does not know.
4. A model that lists no effort runs without one. API providers (`anthropic-api`, `openai-api`) never get an effort, because CLI Funnel does not pass one to them.

`selectionFor` is synchronous, so it reads the model lists that `engines.models` and `engines.autoConfigure` last fetched (`src/core/engine/efforts.ts`). Until a list has been read, a pinned row keeps the effort stored in it, and an automatic row sends only the level Pyxis worked out for the task, never the student's pick. `engines.test` sends the nearest level the model lists once its list is known. Core runs `autoConfigure` at startup, so the lists are normally there before the first task.

The student's pick lives in the same JSON as the engine:

- A pinned row (no `auto`) stores it as `effort`.
- An automatic row keeps it as `effortChoice` beside the `effort` Pyxis works out. `autoConfigure` carries `effortChoice` over to the new model and uses it while the model lists it.
- `engines.setEffort` sets it, or clears it when no `effort` is given. It refuses a level the model does not list. `engines.setFeature` replaces the whole row, so the engine screen passes the current pick along when it changes a model.
- A pick the model does not list stays stored but is ignored, and the engine screen says so. It applies again when a model that lists it comes back.
- Handing one task back to Pyxis keeps its pick. Resetting every task drops them.

In Settings, Engines, with Advanced options on, each task has an effort picker next to its model. "Automatic" is the default and shows the level it resolves to.

## Templates and schemas

Feature modules own their prompt templates, version constants and Zod output schemas. Lessons include their prompt version in cache identity. Generated content saves provider/model/template/version/grounding provenance. Maps request validated operations rather than evaluating arbitrary patch code; simulation grading saves the actual grading model with checkpoints.

A model call that fails reaches the screen through `generate()`, which turns the failure into an `IpcError` with an `engines.errors.*` message key (signed out, usage limit, not available, invalid choice, CLI error) and the engine's own text as detail. Ask, lessons, quizzes, cards, grading and plans all show that message, and the notice has a Details control. A background job keeps the bare code as its error. Only failures of the engine itself are mapped: CLI Funnel's errors and a lost connection. A reply that cannot be used (`invalid-output`), a cancelled call, any other `IpcError` and a bug in Pyxis pass through unchanged, so each feature keeps its own message for those.

Model capability hints come from `resources/model-capabilities.json`; unknown capabilities show a warning. Hints cannot guarantee runtime access or valid output. Authentication failures map to `engines.errors.refused`; quota, usage or spend limits map to `engines.errors.quota`. The limit CLI Funnel attaches to a failed run decides first; error text is read only for a stated HTTP status (`HTTP 401`, `OpenAI 429: ...`) or whole words, never for bare digits. Settings, Test stops after 90 seconds with `engines.errors.timeout`. The automatic choice compares model versions without the snapshot date, and keeps the current choices when the first scan after a working one finds no signed-in engine, since a sign-in probe that times out reads as signed out. Keep error detail free of credentials and source passages.

GPT image hints use a conservative list checked against the [official vision guide](https://developers.openai.com/api/docs/guides/images-vision) on 2026-10-04, including dated snapshots. Text-only, audio and unknown model IDs do not receive photo attachments; they use local OCR. A provider whose CLI Funnel adapter reports `capabilities.images` false (Cursor Agent and Antigravity) gets no photos either, whatever its model ids look like: the automatic choice never gives it the photo task, and a chat on it reads photos as text. New supported models need an explicit catalog entry. The context-size hints are metadata and are not used to budget requests.

To add a feature key:

1. Add it to the feature list in `engine/handlers.ts`, shared IPC validation/types and engine-setting labels in both languages.
2. Give it a tier and weight in `resources/model-tiers.json` and add it to `autoFeatures` in `engine/auto.ts`.
3. Call `selectionFor(db, key)` in the feature and send all turns through `generate()`.
4. Define and validate a schema for structured output. Save prompt version and actual result model in provenance.
5. Add recorded checks for success, repair, rejection and cancellation. Use a durable job when the operation needs restart/retry checkpoints.

CLI-provider login belongs to the installed CLI. API usage is billed by the chosen provider. Do not claim offline model generation just because the database and search index are local.
