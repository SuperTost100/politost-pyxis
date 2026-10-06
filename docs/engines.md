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

`selectionFor(db, feature)` reads `feature_engines`. An unset feature uses `default`; an unset default currently falls back to provider `claude`, model `claude-sonnet-5`. This is a fallback ID, not a guarantee that the account can access it. The engine screen discovers available models and tests the selected one.

Feature keys are `default`, `chat`, `plan`, `lesson`, `grading`, `map` and `vision`. Providers are `claude`, `codex`, Cursor `agent`, `antigravity`, `anthropic-api` and `openai-api`. A CLI provider is disabled unless its CLI Funnel adapter lists `none` in `capabilities.access`. CLI Funnel 0.3 runs Cursor Agent in ask mode from its own workspace, whose `.cursor/cli.json` denies shell, file reads and writes, web fetches and MCP tools. It runs Antigravity with a pre-tool hook that denies every tool. Cursor's grep and glob tools still run, but only inside that empty workspace. Other CLI Funnel providers, such as `gemini-api` and `ollama`, are not offered. API keys are encrypted in `userData/keys.json`; core receives decrypted values through a main-process handshake. The database stores model selections, not keys.

## Templates and schemas

Feature modules own their prompt templates, version constants and Zod output schemas. Lessons include their prompt version in cache identity. Generated content saves provider/model/template/version/grounding provenance. Maps request validated operations rather than evaluating arbitrary patch code; simulation grading saves the actual grading model with checkpoints.

Model capability hints come from `resources/model-capabilities.json`; unknown capabilities show a warning. Hints cannot guarantee runtime access or valid output. Authentication failures map to `engines.errors.refused`; quota, usage or spend limits map to `engines.errors.quota`. Keep error detail free of credentials and source passages.

GPT image hints use a conservative list checked against the [official vision guide](https://developers.openai.com/api/docs/guides/images-vision) on 2026-10-04, including dated snapshots. Text-only, audio and unknown model IDs do not receive photo attachments; they use local OCR. New supported models need an explicit catalog entry. The context-size hints are metadata and are not used to budget requests.

To add a feature key:

1. Add it to the feature list in `engine/handlers.ts`, shared IPC validation/types and engine-setting labels in both languages.
2. Call `selectionFor(db, key)` in the feature and send all turns through `generate()`.
3. Define and validate a schema for structured output. Save prompt version and actual result model in provenance.
4. Add recorded checks for success, repair, rejection and cancellation. Use a durable job when the operation needs restart/retry checkpoints.

CLI-provider login belongs to the installed CLI. API usage is billed by the chosen provider. Do not claim offline model generation just because the database and search index are local.
