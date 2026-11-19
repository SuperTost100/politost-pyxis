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

- Each feature needs a tier: `chat`, `map` and `cards` fast, `lesson`, `vision`, `grading` and `default` mid, `plan` strong. `cards` covers flashcard generation from a topic's sources (`cardsFromBook.ts`) and from selected text (`cardsFromText.ts`); lessons, quizzes and exercises stay on `lesson`. Vision only considers models that read images (`capabilities.ts`). A feature key missing from the file counts as mid.
- Model patterns are regular expressions per tier, cheapest sufficient first. Claude: haiku fast, sonnet mid, opus then fable strong. Codex and OpenAI: luna, mini and nano fast, terra mid, sol then astra strong. Antigravity: Gemini Flash fast, Gemini Pro mid and strong (Claude sonnet and opus as fallbacks). Cursor Agent: Gemini Flash, luna, Composer, then mini/nano fast; Claude sonnet, terra, then Gemini Pro mid; Claude opus then sol strong. Cursor's `-thinking` variants and Fable (listed there without zero data retention) never match. Within a pattern the highest version the provider lists wins. A tier with no match steps to the neighbouring tier, and the last resort is the first model the provider lists.
- Effort follows the tier, see [Reasoning effort](#reasoning-effort).
- A provider is ready when it is installed, signed in and not disabled. API providers count only with a stored key that the provider accepts. CLIs win. A local model the student turned on comes next, and API providers are used only when neither is ready, because they bill per token.
- With two or more ready providers each tier has a preference order (fast: Antigravity, Codex, Cursor, Claude Code; mid: Claude Code, Cursor, Antigravity, Codex; strong: Claude Code, Codex, Cursor, Antigravity). Features then move from the busiest provider to the idlest while that narrows the gap. A feature's load is its weight times its tier cost, so frequent chat on a cheap model and rare plans on a strong model each weigh what they cost. Every ready CLI gets at least one feature.
- Once the student has put their tools in order, nothing is shared out, see [The student's order](#the-students-order).

Defaults for common mixes, as `src/core/engine/auto.test.ts` checks them against CLI Funnel 0.4 model lists:

| Ready CLIs                | Chat and maps                                   | Flashcards          | Lessons       | Default       | Photos             | Plans       | Grading       |
| ------------------------- | ----------------------------------------------- | ------------------- | ------------- | ------------- | ------------------ | ----------- | ------------- |
| Claude Code + Codex       | Codex luna                                      | Codex luna          | Claude sonnet | Claude sonnet | Claude sonnet      | Claude opus | Codex terra   |
| Claude Code + Antigravity | Gemini Flash                                    | Gemini Flash        | Claude sonnet | Claude sonnet | Claude sonnet      | Claude opus | Gemini Pro    |
| Claude Code + Cursor      | Cursor Gemini Flash                             | Cursor Gemini Flash | Claude sonnet | Claude sonnet | Claude sonnet      | Claude opus | Cursor sonnet |
| Codex + Antigravity       | Gemini Flash                                    | Gemini Flash        | Codex terra   | Codex terra   | Codex terra        | Codex sol   | Gemini Pro    |
| Cursor + Antigravity      | Gemini Flash                                    | Gemini Flash        | Cursor sonnet | Cursor sonnet | OCR (no image CLI) | Cursor opus | Gemini Pro    |
| All four                  | Gemini Flash (chat), Cursor Gemini Flash (maps) | Gemini Flash        | Codex terra   | Claude sonnet | Claude sonnet      | Claude opus | Cursor sonnet |

### The student's order

Settings, AI tools lists the tools the student is signed in to, and the student can put them in order: by dragging a row, with the keyboard on its grip, or from the row's menu. The order is the `engines.order` row of the `settings` table (`readOrder()` in `src/core/engine/choice.ts`), a list of CLI provider ids, first to last. `engines.choice` returns it beside `allowed`, and `engines.reorder` saves it; `null` gives the order up.

- Without an order (`null`, the state of every workspace until the student moves a tool), `planAuto()` shares the work as described above.
- With one, `planAuto(ready, features, order)` gives every feature to the first tool of the list that is ready and can do it. A feature the first tool cannot do goes to the next one: photos skip Cursor and Gemini, which read no pictures. A ready tool the list does not name, such as one connected since, comes after the listed ones. The model and the effort still follow the feature's tier.
- The list names subscription CLIs only. The local model and the API keys keep their place after them, and a pool with no listed tool in it (only API keys, say) is planned as if there were no list.
- A tool the student turned off (`engines.allowed`, "Don't use" in the tool's menu) is never planned and never answers instead of another, wherever it is in the list.
- A task pinned to a model in Advanced stays where it is. The page says how many tasks are pinned, because the order alone no longer explains where they go.

An automatic row in `feature_engines` carries `"auto": true` in its JSON. A row without it is pinned. `engines.setFeature` pins, and `engines.autoConfigure` with `reset` returns features to automatic. Only automatic rows are rewritten. When no engine is ready they are removed, which brings back `engine-missing`. If every ready engine fails to list models, the current rows stay.

CLI Funnel has no sign-out for Antigravity, so `engines.overview` reports `capabilities.signOut` false for it, the engine screen explains how to sign out in the program itself, and `engines.logout` refuses it with `engines.signOutUnsupported`.

`engines.autoConfigure` (`{ reset?, features? }` returning `{ ready, features }`) recomputes on demand. Core also runs it at startup, after sign-in, sign-out, update and removal, when a key is added or removed, when the student changes the order or turns a tool off, and when `engines.overview` sees a changed engine set (at most every 30 seconds). `selectionFor` drops the `auto` flag, so callers see the same shape as before.

Feature keys are `default`, `chat`, `plan`, `lesson`, `grading`, `map`, `vision` and `cards`. Providers are `claude`, `codex`, Cursor `agent`, `antigravity`, `anthropic-api` and `openai-api`. A CLI provider is disabled unless its CLI Funnel adapter lists `none` in `capabilities.access`. CLI Funnel 0.4 runs Cursor Agent in ask mode from its own workspace, whose `.cursor/cli.json` denies shell, file reads and writes, web fetches and MCP tools. It runs Antigravity with a pre-tool hook that denies every tool. Cursor's grep and glob tools still run, but only inside that empty workspace. Ollama is offered only as the local model, see [Local models](#local-models). Other CLI Funnel providers, such as `gemini-api`, are not offered. API keys are encrypted in `userData/keys.json`; core receives decrypted values through a main-process handshake. The database stores model selections, not keys.

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

When the check finds no fitting model, setup shows nothing, and Settings, AI tools has a closed section under Advanced that says why: no usable GPU, too little graphics memory, too little RAM, too little disk space, or a GPU that could not be read.

### Download and check

1. The suggestion card says which model, its size and that it runs on this computer. With Ollama missing (no server answers at `OLLAMA_HOST` or `127.0.0.1:11434`) it links to the installer and offers Check again.
2. Download asks Ollama to pull the model (`engines.localPull`, which also records the student's acknowledgement for Ollama). Progress arrives as the `engine.local` broadcast: Ollama's per-layer bytes summed against at least the size in the table. Cancel (`engines.localCancel`) stops it; Ollama keeps the finished part and resumes it next time.
3. Pyxis then checks the model (`checkLocalModel()`, prompt version `LOCAL_CHECK_VERSION`). One written answer is timed from its first token, so loading the model does not count, and must reach 10 tokens per second. One quiz question must match its schema on the first try, without the repair turns `generate()` allows. The first answer may take 3 minutes to start, the structured one 2.
4. When both pass, the local model is on. Otherwise it stays off and Settings shows the speed or the failed format. Run the check again (`engines.localCheck`) repeats it, for example after closing other programs.

The settings row `local-model` stores the model, whether the student has it on (`engines.localEnable`) and the last check. Turning it off, or a failed check, removes every task choice that uses Ollama.

### Gating

- The automatic choice takes the checked model only, while it is on, its check passed with the current `LOCAL_CHECK_VERSION` and Ollama lists it. Other models in the student's Ollama are never chosen. Without a ready CLI the local model takes every task, photos included.
- A local model never builds plans or grades unless it passed the structured-output check: `planAuto()` leaves `plan` and `grading` without it, and `engines.setFeature` refuses to pin it there (`engines.local.noStructured`).
- Under Advanced, a task can be pinned to the local model once it is on.
- Ollama keeps a chat's conversation as history in core, like the API providers.
- The line at the foot of Settings, AI tools says what leaves the computer (`disclosureText()` in `src/renderer/src/features/settings/disclosure.ts`). With only the local model it says nothing leaves; with a mix it names the tasks that stay on the computer and those that go to a vendor. The launch notice lists only cloud engines the student has not confirmed, so Ollama never appears in it: the download consent covers it.

The unit tests run every hardware parser on captured command output and the check and download against a fake Ollama server (`src/core/engine/fake-ollama.ts`). No test talks to a real Ollama or the network.

## Reasoning effort

Every task runs at a reasoning effort that fits it, whether Pyxis or the student picked the model. `taskEffort()` in `src/shared/effort.ts` reads the level from `resources/model-tiers.json`:

| Task                                 | Effort   |
| ------------------------------------ | -------- |
| Chat (Ask), maps and flashcards      | `low`    |
| Lessons, quizzes and drills, photos  | `medium` |
| Grading of exercises and simulations | `medium` |
| The default engine                   | `medium` |
| Plans                                | `high`   |

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

In Settings, AI tools, under Advanced, each task has an effort picker next to its model. "Automatic" is the default and shows the level it resolves to.

## Switching engines on a usage limit

When the engine Pyxis chose for a task hits a usage limit, is signed out (a refused key counts for API providers), is no longer installed or says the student's subscription doesn't include the model, `generate()` asks again on another engine. The replacement is what `planAuto()` would choose for the same task without the failed engine, among the engines the last automatic choice could use: with the student's order that is the next tool of their list. Core then broadcasts `engine.fallback` and the window shows one line saying which engine answered.

- Only automatic selections switch. `selectionFor` sets `chosenFor` (the task) on the selections it returns from an automatic row, so a task the student pinned keeps its engine and model and shows the error. Turning tools off or putting them in order does not pin a model: the rows stay automatic.
- `chosenFor` is plain data, so it survives in a background job's saved parameters, and a job's calls (an exam build, a quiz check) switch like any other automatic call. `generate()` strips it before the selection reaches CLI Funnel.
- A task moves only for a failure the next engine would not share. `fallbackReason()` in `src/core/engine/errors.ts` names four: `limit`, `signed-out`, `not-installed` and `model`. A lost connection, a reply that cannot be used or a crash of the CLI is shown as it is.
- When the engine the task moved to is out as well, the task goes on to the next one, and so on down the list. Each engine that fails this way is marked and left out of the next step, so the walk ends with the last ready engine, whose error is then shown (`ENGINE_STEPS` bounds it at 6). After a refused model the task tries up to `MODEL_STEPS` (3) more models, because a plan that refuses one model often refuses its neighbours, then shows the refusal.
- When a refusal names the kind of model to use instead (Cursor: "Buy credits or switch to a Grok model to continue"), the automatic choice keeps to that engine's models of that kind for the same 24 hours, if it lists any.
- Later automatic calls skip the failed engine and go straight to the replacement, without a notice. A sign-out keeps it out until a scan finds it signed in again or its API key changes. A missing program keeps it out until a scan that began after the failed call finds it installed; core reads its detection again at once, since CLI Funnel caches it for a minute. A refused model keeps only that model out, for 24 hours: core runs the automatic choice again at once, so the tasks that used it move to another model and Settings shows the new one, while the engine's other models stay in use. A refused Prova marks its model the same way. While a model is out, the engine's row reads "Pronto, con limiti" and names the refused model, and the next Prova uses another model. The replacement for a refused model may be the same engine on another model, and the notice then names that model by its readable name. Refused models live in core's memory only (`src/core/engine/bench.ts`), so a restart tries them again. A refused sign-in is kept in the `settings` table (`engine-signed-out:<provider>`, see `src/core/engine/choice.ts`) and outlasts a restart until the engine is signed in again.
- A stopped turn never switches, and a turn with a picture switches only to an engine that can see it.
- CLI Funnel already retries an API request twice on 429 and 5xx before any output. A limit is recognised from the `limit` CLI Funnel attaches to the error, and otherwise from the same classification that maps errors to `engines.errors.quota`, `not-logged-in`, `refused` and `model-not-included`. The last one matches the wording vendors use when a plan leaves a model out, such as Cursor's "is not included in your weekly usage". Credits that ran out ("out of credits", "insufficient credits", "buy credits") stop every model on the account, so they count as a usage limit.
- A lesson that falls back to the book text after an engine failure carries the failure's message key as `fallbackReason`, and the lesson page shows it with a link to the engine settings.

### How long a usage limit lasts

A usage limit keeps the engine out until it resets, and the reset is kept in the `settings` table (`engine-limited:<provider>`, the time in milliseconds), so a restart does not try that engine first again. `configureSignOuts()` reads the kept limits at launch and forgets the ones whose time has passed. The limit is marked whenever a call or a Prova meets it, also when no other engine can answer and for a model the student pinned, so Settings can say the tool is out of requests and when they are back (`limitedUntil` in `engines.overview`). A call to the engine that answers, having begun after the limit was marked, clears it.

"Until it resets" is the time the tool itself gives, where it gives one:

| Tool     | What ends the wait                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude   | The reset time Claude Code reports with the window it hit: the five-hour window or a weekly one.                                                                                                             |
| ChatGPT  | The reset time of the full window in Codex's rate-limit snapshot. A bare "usage limit exceeded" has none, so its usage report is asked.                                                                      |
| Gemini   | Antigravity reports no limit during a run, so its usage report (`/usage`) is asked. It gives a time, the one its first model group is back, once every group is full, and until then the wait is 30 minutes. |
| Cursor   | Cursor Agent reports no reset time and has no usage report, so Pyxis tries it again after 30 minutes (`DEFAULT_LIMIT_MS`).                                                                                   |
| API keys | The provider's `retry-after` or rate-limit reset header, else 30 minutes.                                                                                                                                    |

When a failure names no time, `engines.limitChanged` asks CLI Funnel's `rateLimits()` for the tool's usage report once, in the background, and moves the wait to the reset it gives. If the report fails, names no limit or the tool has none, the 30 minutes stand.

### A job whose tool ran out of requests

An automatic task goes on with the next tool by itself, as above, and the student is told once: the finished job's row in Attività says "Gemini ha finito le richieste, quindi ha risposto Claude" and one line in the window says it too. A job stops and asks only when nothing moves it on: the task is set to a model by hand, or every tool of the list is out. Such a job fails with `quota [<tool>]: …` (the tool in brackets, see `jobErrorEngine()`), and while that tool is out of requests Attività shows it under "C'è bisogno di te" as one row for all the jobs that ran out on that tool (`out-of-requests` in `jobGroups.ts`, drawn by `OutOfRequestsCard` in `JobsPanel.tsx`). The row reads the tools through `engines.overview` (`limitedUntil`) and offers:

- **Continua con \<tool\>**, the first connected tool of the student's order, other than the one that ran out, that is in use and has requests left (`nextTool()` in `outOfRequests.ts`). `jobs.retryWith` records the tool for the job (`chooseJobEngine()` in `selection.ts`) and retries it from the step it stopped at. `generate()` then sends every call of that job to the tool, on the model its tier gives for the task (`selectionOn()`), and the finished job carries the same note as an automatic move, without the window's line, since the student just chose it. A task set by hand has no tier recorded, so it takes the tool's mid-tier model. The choice is kept in core's memory: after a restart an interrupted job runs as it was saved.
- **Aspetta \<when\>** (until a time today, tomorrow, or a day), when the tool's reset time is known. `jobs.wait` holds the failed job until `limitedUntil()` of that tool (`hold()` in the runner, kept in the settings table as `job-wait:<jobId>` with the time and the tool, so a restart goes on with it) and retries it by itself at that time. The hold follows its tool's limit (`onLimitChange()` in `bench.ts`, `retime()` in the runner): when the tool's usage report gives a better time than the first guess, or another failure moves it, the job waits until the new time, and when a call or a Prova that answers clears the limit, the job is retried at once. The row moves to "In corso" with the time and a Stop button that gives the wait up (`jobs.wait` with `wait: false`), after which the row asks again. A retry, a Chiudi or a dismissal ends the wait too.
- **Strumenti AI**, in place of the first choice, when no other tool can take the job.
- **Chiudi**, which gives the job up, as on any stopped job.

The row follows the tool: when its requests are back (the time passes, or a call or a Prova that answers clears the limit), the job is an ordinary failed one with Riprova, and the row stops saying the tool is out.

## What a chat searches

Pyxis decides where a question looks and files the chat under a subject; the composer has no subject, source or mode control. Each turn searches one of these, in order (`answer()` in `src/core/chat/turn.ts`):

| The chat has                                                          | The turn searches                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Files or an exam chosen for it (opened from an exam, a lesson, a map) | Those files, plus its subject's files when it has a subject      |
| A subject                                                             | The subject's Library files and the files its exams study        |
| Neither                                                               | The student's whole material: the Library and every exam's files |

The chat's attachments always come along. A subject with nothing relevant on a question widens the search to the whole material; the reply is then stored with grounding `mixed` (read as `wider`) and its line says the chat's subject had nothing. An exam chat without files and without a subject searches nothing, and an empty Library is not searched, so those replies make no claim about the student's material. A reply that cites nothing is stored as `general`, with a note in `messages.passages_json` (`{ found, where }`) that tells apart a search that found nothing relevant (the line says where Pyxis looked: the Library, or the files the chat is limited to) from one that found passages the answer did not cite. A reply that cites a file outside the chat's subject is stored as `mixed` too, even when the search did not have to widen.

### The subject Pyxis picks

A chat with no subject, which the student has not set either, gets one from its first search of the whole material that finds something. The rule works on the search's own scores, so it needs no model call (`pickSubject()` in `src/core/chat/subject.ts`):

1. Count only the passages that pass the search's relevance bar, the same one `covered` is made of: a lexical match that holds at least 40% of the question's words, or a vector at L2 distance 0.6 or less.
2. Give each passage the subject of its file: the Library subject, or else the subject of the exams that study it when they all have one subject. A file with neither counts in the total and for no subject.
3. The subject with the most passages wins when it has at least 2 and at least two thirds of all of them. So 4 against 2 picks, 3 against 2 picks nothing, a single relevant passage picks nothing, and passages mostly from files without a subject pick nothing.

The subject is stored with the reply only when the reply is saved whole: a turn that fails or is stopped leaves the chat as it was. `scope_json` then records `subjectBy: "pyxis"`. The student can change the subject from the chip in the chat's header at any time, or choose the whole Library, which sets `subjectBy: "student"`; Pyxis never changes a subject the student set. On a new chat's first page the chip offers the same choice before anything is sent, and the first question carries it. A chat saved with a subject before `subjectBy` existed counts as the student's.

An older chat whose sources were picked by hand keeps answering from them, and its chip shows how many. Choosing a subject or the whole Library from the chip replaces them; the chat's attachments stay.

### The way of answering

Pyxis solves and explains when the student asks for an answer, and guides one step at a time when the student asks for help understanding, asks to be guided, shows their own attempt, or answers a guided step without asking for the solution. `answerWay()` in `src/core/chat/way.ts` decides it from the question's words and the way the previous reply took, so it is tested without a model. A request for the solution wins over a request for help, but a solve verb that only names the task ("guidami a risolvere questo integrale", "walk me through how to solve it") or a refused solution ("non darmi la soluzione") is not a request for the solution.

The way picks the template: `chat.socratic` for a guided step, `chat.solver` for a solved answer (with the math checks and figures), and `chat.general` for a solved answer when nothing was searched. The template's text goes in the context block of the message, not in the system prompt, so a change of way never changes the system prompt (see [Chat sessions](#chat-sessions-and-prompt-caching)). The reply stores its template in `messages.prompt_template`, which is how the chat knows which way it went after a reload. Under the last reply one action asks the same question again the other way ("Guidami passo passo" or "Dammi la soluzione"), which is `chats.regenerate` with `way`. Regenerate and Continue keep the way of the reply they replace.

## Chat sessions and prompt caching

A chat on Claude Code, Codex, Cursor Agent or Antigravity is one session in that tool, so one Pyxis chat is one chat in the student's Claude, ChatGPT, Cursor or Gemini history. Core stores the session in `chat_sessions` (one open row per chat: the tool's session id, the provider, the folder it was keyed by, the model and effort of the last turn, the hash of the context block the session last received, and how many characters went into it) and continues it by id. `src/core/chat/sessions.ts` reads and writes the rows, `turn.ts` builds the messages and `funnel.ts` runs the turn. `chats.read` returns how many sessions the chat opened (`sessions`, every row counts, the ended ones included), which is 1 for a chat that stayed on one tool.

| Tool                      | How a session is continued                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Claude Code, Codex        | A live CLI process while the chat is open, else a new process that resumes by id (`--resume`, `thread/resume`) |
| Cursor Agent, Antigravity | A new process for every turn that resumes by id (`--resume`, `--conversation`)                                 |
| Anthropic and OpenAI API  | The conversation history in core's memory, sent with `sessionId`, lost when the app quits                      |
| Ollama                    | The same history in memory                                                                                     |

A resume needs the same folder the session started in, because Claude Code, Cursor Agent and Antigravity key their sessions by it. Pyxis runs every tool in the workspace's `scratch` folder, and a row remembers it. A turn that finds a different folder starts a new session.

### What a turn sends

The chat's system prompt (`chat.system`) is the same for the whole chat. What changes from turn to turn sits in a context block that opens the message: the language, the exam and subject, the profile lines, whether to end with follow-ups, the pinned context, and how to answer with the figure kinds that can be drawn. A session is sent the block only when its hash differs from the one the session last received, so a chat that gets a subject after its first reply, or flips between solving and guiding, tells its session once and goes on. The parts of a prompt that stay the same come first, so a provider's prompt cache keeps the start.

- **Continuing a session.** The message is the context block when it changed, then what the session missed, then this question's passages (numbered from P1 again) and the question.
- **A new session.** The message is the context block, the earlier conversation and the question. The earlier conversation is every message of the chat, newest first and whole, up to 200,000 characters (`HANDOVER_CHARS`). The smallest window among the tools' models today is 200,000 tokens (Claude Haiku), and 200,000 characters are about 55,000 tokens, a quarter of it, which leaves room for the system prompt, twelve passages, the question and a long answer. A local model has a 16,384-token window, of which the system prompt, the passages and the answer take most, so it gets 12,000 characters. Messages that do not fit are replaced by one line that counts them. The budget follows the engine that answers: an automatic choice that moves to another engine inside `generate()` gets the conversation built again for it (`promptFor`).

Cursor Agent and Antigravity receive `system` as a block at the start of the prompt, so a turn in a session they hold leaves it out: the first prompt of the session carried it.

### When a new session starts

Only when:

- the turn runs on another tool than the stored session's (the student changed the engine, the automatic choice moved on after a limit, or "Answer again with the strongest model" is another tool). Core ends the old row with the reason `tool` and opens a new one;
- the tool no longer holds the stored session. Claude Code says "No conversation found", Codex "no rollout found" and Antigravity "was not found", and `funnel.ts` then sends the same turn again with the whole prompt. The old row ends with `gone`. Cursor Agent answers a resume of a chat it lost as a new chat under the same id, with that id in every event, so the stream says nothing. Core reads Cursor's own folder instead (`~/.cursor/chats/<workspace>/<id>`, `cursorSessionLost()`): the chat is gone when the folder holds other chats and none is this one, and the whole prompt is sent before any call is made. A folder that is missing or empty, as another layout would be, counts as held. Any tool that reports another session id than the one it was given is treated the same way, and the turn is sent again with the whole prompt;
- the session of Cursor Agent or Antigravity passed 400,000 characters (`UNCOMPACTED_SESSION_CHARS`, about 100,000 tokens). Claude Code and Codex compact a long session on their own, so theirs has no bound. For the other two Pyxis has not seen what happens at the limit, so it starts over with the conversation handed across, with the reason `long`.

A change of model or effort on the same tool continues the session. This was run on all four tools in one session each (Claude Haiku 5.5 to Haiku 4.5, Codex Luna to Terra, Cursor Grok 4.5 to Grok 4.7, Gemini Flash to Gemini 4 Argon): each answered with a word it had been given before the change. The closing of a live process never ends a session. The process closes when the chat is left or deleted, after 10 minutes without a question (`CONVERSATION_IDLE_MS`), when the student changes an engine choice or the app quits, and the next turn resumes by id.

### After a stop or a failure

The session goes on after a turn the student stopped or that failed. What the tool keeps of such a turn differs, as found by stopping a long answer and asking each tool what it holds:

| Tool         | After a stopped turn                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| Claude Code  | The question, and a stub in place of the reply. The text that arrived is lost |
| Codex        | The question. The text that arrived is lost                                   |
| Cursor Agent | Nothing: the turn is missing from the session, the question too               |
| Antigravity  | The question and the start of the reply                                       |

So the next message says what the student saw: when the last reply of the chat is a stopped one, it carries the question and the text that arrived (at most 6,000 characters), and a question that got no text at all is named too. The notice appears once, with the turn after the stop. A regenerated reply tells the model the question is asked again and the earlier answer is discarded. When the new answer then fails or is stopped, the earlier one stays on screen, so the session's `note` tells it the next time that the student still sees the earlier answer. Continue sends the saved text, as before.

A turn that ends without an answer still counts toward the session's size, by what the tool kept of it: the question for Claude Code and Codex, the question and the start of the reply for Antigravity, nothing for Cursor Agent. A message is stored at its turn's start and its reply one millisecond later, and a turn never starts earlier than the last message of its chat, so two turns in one millisecond or a clock that steps back keep their order.

A session is stored the moment the tool names it, so a first turn the student stops leaves a session to continue, for Claude Code, Codex and Antigravity. Cursor Agent loses a stopped turn, so its session is stored only when a turn ends. If a stored session turns out to be lost, the gone rule above applies.

### Other conversations

API providers and Ollama keep their conversation in core's memory. It ends when the chat is left or deleted, has been idle for 10 minutes, carried more than 150,000 characters, when a stopped or failed turn leaves it in an unknown state, or when an API key changes. The next turn starts a new conversation with the whole context. Runs outside a chat, such as lessons and plans, close their CLI process as soon as they end. A repair of a structured answer continues the first answer's session on Claude Code and Codex and sends the whole prompt again on the other tools.

Chat turns ask for prompt caching (`cache: true`) on providers that take it, today the Anthropic API. It marks the system prompt and the newest turn, so the next question reads everything before it from the cache. OpenAI, and the CLIs, cache a prompt with the same start on their own.

## Replies in Ask

- **Answer again with the strongest model.** The reply's menu sends `chats.regenerate` with `engine: "strong"`. That turn runs on the plan task's engine, which uses the strong tier, at `high` effort or the nearest level its model lists (`strongestSelection()` in `src/core/engine/selection.ts`). The new reply replaces the old one only once it is saved.
- **A reply cut short.** When the student stops a reply, or the engine fails mid-answer (a dropped connection, a usage limit, a stream that closed early, which CLI Funnel 0.5.0 reports as `stream-truncated`), the text that arrived is saved as a stopped reply, with the failure's message key in `messages.error` when an engine failure cut it (a reply the student stopped has none). A stopped reply also records every passage it was given, with its P-number, in `messages.passages_json`. Both show Continue under the reply, which sends `chats.regenerate` with `resume: true`: the prompt carries those same passages in the same numbering, without a new retrieval, and the saved text, and asks the model to go on from where it stops. The new reply is the saved text plus what it adds, so the citations in the saved part still point to the passages they named. If Continue fails again, the longer text is kept the same way. If it adds nothing, the reply stays as it was. A regenerated reply that fails keeps the earlier reply.
- **The math check runs after the reply is saved.** The reply is saved once its figures are drawn (they change the stored text) and returns with `checking: true`. The `chat.checks` call then runs in core on that text, tied to the message, and appends its claims to the stored body. Core broadcasts `chats.checks` when it ends, with or without badges. Stop in that chat stops a running check, Regenerate and Continue drop the check of the reply they replace, and deleting the chat stops it. A check that fails or times out (20 s) leaves the reply without badges, as before.

## Token usage

`generate()` reports the tokens of every call that returns, schema repairs included, and core writes one `engine_usage` row per call. The row names the chat and message for a chat turn and its math check, and the job and its kind for a call inside a job step (an `AsyncLocalStorage` scope in `src/core/engine/usage.ts`). Calls that report no tokens are not stored. A turn the student stopped is stored when the tool reports tokens for it: Claude Code and Codex do, Cursor Agent and Antigravity report none for a cancelled turn. Codex's figure for a stopped turn repeated the previous turn's in one of two stops we ran, so a stopped Codex turn can be over-counted. `inputTokens` includes the tokens read from and written to the prompt cache.

Settings, AI engines shows the tokens each engine sent and received since Monday (`engines.usage`), with the share of input tokens the prompt cache served. Ask shows the chat's total in its top bar (`usage` in `chats.read`), with the breakdown for screen readers and on hover. The number of sessions a chat opened is in `chat_sessions` and `chats.read`.

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

## Engine and model names on screen

Students never see an engine id or a model id. `useEngineNames()` (`src/renderer/src/lib/useEngineNames.ts`) gives every screen the same label as the model picker, such as "Cursor Agent · Codex 5.3": the engine's display name, then the model's name as the CLI lists it. Core answers `engines.names` from the model lists it already read (`src/core/engine/efforts.ts`), so asking starts no CLI. A model core has not listed yet, such as one on an old quiz result, is shown with `readableModel()` (`src/shared/model-names.ts`), which turns `claude-sonnet-4-6` into "Claude Sonnet 4.6".
