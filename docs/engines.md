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

The result carries text, provider, model and token usage: input and output tokens, plus the input tokens the provider read from or wrote to its prompt cache (`cacheReadTokens`, `cacheWriteTokens`). Structured requests convert the Zod schema to JSON Schema, disallow unknown object properties and parse the response again with Zod. Invalid output triggers at most two repair turns. Claude Code, Codex and the API providers keep the first turn's conversation, so a repair sends them only the validation error and the invalid answer. Cursor Agent and Antigravity keep none and get the whole prompt again. Final failure becomes `invalid-output`. `onDelta` streams text; `signal` cancels a turn. Supported image attachments have explicit media types and data.

`selectionFor(db, feature)` reads `feature_engines`. An unset feature uses `default`. With no `default` row it throws `engine-missing`. It also works out the reasoning effort, see below. The engine screen discovers available models and tests the selected one.

## Automatic choice

Pyxis picks the engine, model and effort for each feature itself. `planAuto()` in `src/core/engine/auto.ts` is a pure function of the ready providers and the models each one lists. It never calls a model, so it costs no usage. The tiers, weights and model patterns live in `resources/model-tiers.json`.

- Each feature needs a tier: `chat` and `map` fast, `lesson`, `vision` and `default` mid, `grading` and `plan` strong. Vision only considers models that read images (`capabilities.ts`). A feature key missing from the file counts as mid.
- Model patterns are regular expressions per tier, cheapest sufficient first. Claude: haiku fast, sonnet mid, opus then fable strong. Codex and OpenAI: luna, mini and nano fast, terra mid, sol then astra strong. Antigravity: Gemini Flash fast, Gemini Pro mid and strong (Claude sonnet and opus as fallbacks). Cursor Agent: Gemini Flash, luna, Composer, then mini/nano fast; Claude sonnet, terra, then Gemini Pro mid; Claude opus then sol strong. Cursor's `-thinking` variants and Fable (listed there without zero data retention) never match. Within a pattern the highest version the provider lists wins. A tier with no match steps to the neighbouring tier, and the last resort is the first model the provider lists.
- Effort follows the tier, see [Reasoning effort](#reasoning-effort).
- A provider is ready when it is installed, signed in and not disabled. API providers count only with a stored key that the provider accepts. CLIs win. A local model the student turned on comes next, and API providers are used only when neither is ready, because they bill per token.
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

Feature keys are `default`, `chat`, `plan`, `lesson`, `grading`, `map` and `vision`. Providers are `claude`, `codex`, Cursor `agent`, `antigravity`, `anthropic-api` and `openai-api`. A CLI provider is disabled unless its CLI Funnel adapter lists `none` in `capabilities.access`. CLI Funnel 0.4 runs Cursor Agent in ask mode from its own workspace, whose `.cursor/cli.json` denies shell, file reads and writes, web fetches and MCP tools. It runs Antigravity with a pre-tool hook that denies every tool. Cursor's grep and glob tools still run, but only inside that empty workspace. Ollama is offered only as the local model, see [Local models](#local-models). Other CLI Funnel providers, such as `gemini-api`, are not offered. API keys are encrypted in `userData/keys.json`; core receives decrypted values through a main-process handshake. The database stores model selections, not keys.

## Local models

A student without a subscription can run a model on their own computer through [Ollama](https://ollama.com). Pyxis does not bundle Ollama; it links to its installer. It offers a local model only after a hardware check says the computer runs one well enough for Pyxis's tasks at a usable speed.

### Hardware check

`src/core/engine/hardware.ts` reads RAM, GPUs with their memory, and free disk space. It needs no administrator rights and gives every command a time limit. The GPU query runs once per launch, the first time Settings or setup asks (`engines.local`), never at startup. Free space is read again each time.

| System  | GPU and memory                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All     | `nvidia-smi --query-gpu=name,memory.total` when the NVIDIA driver is there (not on macOS). RAM from `os.totalmem()`                                          |
| macOS   | `sysctl -n machdep.cpu.brand_string`. Apple Silicon shares the whole RAM with the GPU. Intel Macs fall back to `system_profiler SPDisplaysDataType -json`    |
| Windows | PowerShell, `Get-CimInstance Win32_VideoController` plus the driver's `HardwareInformation.qwMemorySize` in the registry, because `AdapterRAM` stops at 4 GB |
| Linux   | `/sys/class/drm/cardN/device`: the PCI vendor, and `mem_info_vram_total` from the amdgpu driver                                                              |

Free space is measured where Ollama keeps models: `OLLAMA_MODELS`, else `~/.ollama/models`, or the nearest folder above it that exists.

### Model per hardware class

`adviseLocal()` in `src/core/engine/local.ts` picks the largest model from the `local` section of `resources/model-tiers.json` that fits. A model runs on an NVIDIA or AMD card's own memory, or on Apple Silicon's unified memory. Intel graphics, any GPU in an Intel Mac and computers without a GPU get no suggestion, because the model would run on the processor and be too slow. Memory counts as a size when it reports at least 90% of it, since the system reserves some.

| Model        | Download | NVIDIA or AMD card | Apple Silicon memory |
| ------------ | -------- | ------------------ | -------------------- |
| `gemma3:27b` | 17 GB    | 20 GB              | 32 GB                |
| `gemma3:12b` | 8.1 GB   | 12 GB              | 16 GB                |
| `gemma3:4b`  | 3.3 GB   | 6 GB               | 8 GB                 |

The computer also needs 8 GB of RAM, and the disk needs the download plus 2 GB. With too little free space a smaller model that fits is suggested; when none fits, Settings says how much space the suggested one needs. A model Ollama already has needs no space. Gemma 3 was chosen because it has no thinking phase that slows each answer, reads images and writes Italian well. Every turn on Ollama sets the context to the table's `contextWindow` (16,384 tokens) through `num_ctx`, because Ollama's default of a few thousand tokens silently cuts the start of a long lesson prompt. Ollama keeps the model loaded for 10 minutes after a turn, as long as a chat's conversation.

When the check finds no fitting model, setup shows nothing, and Settings, Engines has a closed section that says why: no usable GPU, too little graphics memory, too little RAM, too little disk space, or a GPU that could not be read.

### Download and check

1. The suggestion card says which model, its size and that it runs on this computer. With Ollama missing (no server answers at `OLLAMA_HOST` or `127.0.0.1:11434`) it links to the installer and offers Check again.
2. Download asks Ollama to pull the model (`engines.localPull`, which also records the student's acknowledgement for Ollama). Progress arrives as the `engine.local` broadcast: Ollama's per-layer bytes summed against at least the size in the table. Cancel (`engines.localCancel`) stops it; Ollama keeps the finished part and resumes it next time.
3. Pyxis then checks the model (`checkLocalModel()`, prompt version `LOCAL_CHECK_VERSION`). One written answer is timed from its first token, so loading the model does not count, and must reach 10 tokens per second. One quiz question must match its schema on the first try, without the repair turns `generate()` allows. The first answer may take 3 minutes to start, the structured one 2.
4. When both pass, the local model is on. Otherwise it stays off and Settings shows the speed or the failed format. Run the check again (`engines.localCheck`) repeats it, for example after closing other programs.

The settings row `local-model` stores the model, whether the student has it on (`engines.localEnable`) and the last check. Turning it off, or a failed check, removes every task choice that uses Ollama.

### Gating

- The automatic choice takes the checked model only, while it is on, its check passed with the current `LOCAL_CHECK_VERSION` and Ollama lists it. Other models in the student's Ollama are never chosen. Without a ready CLI the local model takes every task, photos included.
- A local model never builds plans or grades unless it passed the structured-output check: `planAuto()` leaves `plan` and `grading` without it, and `engines.setFeature` refuses to pin it there (`engines.local.noStructured`).
- In Advanced, a task can be pinned to the local model once it is on.
- Ollama keeps a chat's conversation as history in core, like the API providers.
- The line at the top of Settings, Engines says what leaves the computer (`disclosureText()` in `src/renderer/src/features/settings/disclosure.ts`). With only the local model it says nothing leaves; with a mix it names the tasks that stay on the computer and those that go to a vendor. The launch notice lists only cloud engines the student has not confirmed, so Ollama never appears in it: the download consent covers it.

The unit tests run every hardware parser on captured command output and the check and download against a fake Ollama server (`src/core/engine/fake-ollama.ts`). No test talks to a real Ollama or the network.

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
4. A model that lists no effort runs without one. API providers (`anthropic-api`, `openai-api`) follow the same rules: CLI Funnel lists the levels each API model takes and sends the chosen one to the vendor.

`selectionFor` is synchronous, so it reads the model lists that `engines.models` and `engines.autoConfigure` last fetched (`src/core/engine/efforts.ts`). Until a list has been read, a pinned row keeps the effort stored in it, and an automatic row sends only the level Pyxis worked out for the task, never the student's pick. `engines.test` sends the nearest level the model lists once its list is known. Core runs `autoConfigure` at startup, so the lists are normally there before the first task.

The student's pick lives in the same JSON as the engine:

- A pinned row (no `auto`) stores it as `effort`.
- An automatic row keeps it as `effortChoice` beside the `effort` Pyxis works out. `autoConfigure` carries `effortChoice` over to the new model and uses it while the model lists it.
- `engines.setEffort` sets it, or clears it when no `effort` is given. It refuses a level the model does not list. `engines.setFeature` replaces the whole row, so the engine screen passes the current pick along when it changes a model.
- A pick the model does not list stays stored but is ignored, and the engine screen says so. It applies again when a model that lists it comes back.
- Handing one task back to Pyxis keeps its pick. Resetting every task drops them.

In Settings, Engines, with Advanced options on, each task has an effort picker next to its model. "Automatic" is the default and shows the level it resolves to.

## Switching engines on a usage limit

When the engine Pyxis chose for a task hits a usage limit, is signed out (a refused key counts for API providers) or says the student's subscription doesn't include the model, `generate()` asks once more on another engine. The replacement is what `planAuto()` would choose for the same task without the failed engine, among the engines the last automatic choice could use. Core then broadcasts `engine.fallback` and the window shows one line saying which engine answered.

- Only automatic selections switch. `selectionFor` marks the selections it returns from an automatic row, so a task the student pinned keeps its engine and shows the error.
- A background job that saved its selection when it was queued keeps that engine.
- The retry happens once. If the second engine fails too, its error is shown.
- Later automatic calls skip the failed engine and go straight to the replacement, without a notice. A usage limit keeps it out until the reset time CLI Funnel reports (`resetAt`, else `retryAfterMs`), or 30 minutes when it reports neither. A sign-out keeps it out until a scan finds it signed in again or its API key changes. A refused model keeps only that model out, for 24 hours: core runs the automatic choice again at once, so the tasks that used it move to another model and Settings shows the new one, while the engine's other models stay in use. The replacement for a refused model may be the same engine on another model, and the notice then names that model. This lives in core's memory only (`src/core/engine/bench.ts`), so a restart tries every engine again.
- A stopped turn never switches, and a turn with a picture switches only to an engine that can see it.
- CLI Funnel already retries an API request twice on 429 and 5xx before any output. A limit is recognised from the `limit` CLI Funnel attaches to the error, and otherwise from the same classification that maps errors to `engines.errors.quota`, `not-logged-in`, `refused` and `model-not-included`. The last one matches the wording vendors use when a plan leaves a model out, such as Cursor's "is not included in your weekly usage". Credits that ran out ("out of credits", "insufficient credits", "buy credits") stop every model on the account, so they count as a usage limit.
- A lesson that falls back to the book text after an engine failure carries the failure's message key as `fallbackReason`, and the lesson page shows it with a link to the engine settings.

## Chat conversations and prompt caching

Each chat keeps one conversation with its engine while the student stays in it. The first question sends the whole context: the system prompt (tutor template, profile, plan line, subject), then the pinned context and the earlier turns, then this question's passages and the question. The parts that stay the same come first so a provider's prompt cache keeps the start of the prompt. Later questions send only the new question and its passages, numbered from P1 again.

| Engine                    | How the conversation is kept                                           |
| ------------------------- | ---------------------------------------------------------------------- |
| Claude Code, Codex        | A live CLI process (`createFunnel({ sessions: { keepAlive: true } })`) |
| Anthropic and OpenAI API  | The conversation history in core's memory, sent with `sessionId`       |
| Cursor Agent, Antigravity | None. Every question starts a new process and gets the whole context   |

Chat turns ask for prompt caching (`cache: true`) on providers that take it, today the Anthropic API. It marks the system prompt and the newest turn, so the next question reads everything before it from the cache. OpenAI caches long prompts with the same start on its own.

The conversation ends, and a live process with it, when:

- the student leaves the chat (`chats.leave`), deletes it or clears its pinned context;
- no question came for 10 minutes;
- the chat's engine, effort or system prompt changed, or the student changed any engine choice;
- a turn was stopped or failed, or a reply is regenerated;
- a second question ran beside a turn still in progress, so the conversation would miss that exchange;
- an API key changed (core also drops every stored API history then);
- the conversation carried more than 150,000 characters;
- the app quits.

The next question then starts a new conversation with the whole context. Runs outside a chat, such as lessons and plans, close their CLI process as soon as they end.

## Replies in Ask

- **Answer again with the strongest model.** The reply's menu sends `chats.regenerate` with `engine: "strong"`. That turn runs on the plan task's engine, which uses the strong tier, at `high` effort or the nearest level its model lists (`strongestSelection()` in `src/core/engine/selection.ts`). The new reply replaces the old one only once it is saved.
- **A reply cut short.** When the engine fails mid-answer (a dropped connection, a usage limit, a stream that closed early, which CLI Funnel 0.5.0 reports as `stream-truncated`), the text that arrived is saved as a stopped reply with the failure's message key in `messages.error`. A stopped reply also records every passage it was given, with its P-number, in `messages.passages_json`. Continue sends `chats.regenerate` with `resume: true`: the prompt carries those same passages in the same numbering, without a new retrieval, and the saved text, and asks the model to go on from where it stops. The new reply is the saved text plus what it adds, so the citations in the saved part still point to the passages they named. If Continue fails again, the longer text is kept the same way. If it adds nothing, the reply stays as it was. A regenerated reply that fails keeps the earlier reply.
- **The math check runs after the reply is saved.** The reply is saved once its figures are drawn (they change the stored text) and returns with `checking: true`. The `chat.checks` call then runs in core on that text, tied to the message, and appends its claims to the stored body. Core broadcasts `chats.checks` when it ends, with or without badges. Stop in that chat stops a running check, Regenerate and Continue drop the check of the reply they replace, and deleting the chat stops it. A check that fails or times out (20 s) leaves the reply without badges, as before.

## Token usage

`generate()` reports the tokens of every call that returns, schema repairs included, and core writes one `engine_usage` row per call. The row names the chat and message for a chat turn and its math check, and the job and its kind for a call inside a job step (an `AsyncLocalStorage` scope in `src/core/engine/usage.ts`). Calls that report no tokens are not stored. `inputTokens` includes the tokens read from and written to the prompt cache.

Settings, AI engines shows the tokens each engine sent and received since Monday (`engines.usage`), with the share of input tokens the prompt cache served. Ask shows the chat's total in its top bar (`usage` in `chats.read`), with the breakdown for screen readers and on hover.

## Startup and provider detection

Core posts `core-ready` before it looks for any engine. The student's login-shell PATH, where nvm or Homebrew put the CLIs, is read in the background with `$SHELL -ilc` once per launch (`src/core/engine/shell-path.ts`), and CLI Funnel's own blocking lookup is turned off with `CLI_FUNNEL_NO_SHELL_PATH=1`. Detection waits for that PATH; nothing else does.

Main sends the stored API keys right after `core-ready`, and that starts the one provider scan of the launch. Callers that ask for `engines.overview` while a scan runs share it. New keys replace only the API providers, so the funnel keeps the CLI detection and model lists it cached (CLI Funnel caches them for a minute).

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
