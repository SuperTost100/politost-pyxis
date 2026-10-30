# Agent lessons: a prototype and a comparison

Recommendation: keep the fixed lesson pipeline as the default and do not switch lessons to an agent. On three chapters of the free Fisica 1 book the agent loop finished sooner (321 to 451 s against 486 to 713 s) and every one of its 145 citations pointed at a passage it had read, but it showed the first section later (266 to 388 s against 186 to 275 s) and it read almost the whole chapter anyway, which is what the pipeline already sends. Keep the loop for flows where nobody knows in advance what to read, and if you want cited lessons, add the citation check to the pipeline instead. [Recommendation](#recommendation) has the details and the work each path needs.

The prototype is in `src/core/study/agentLesson.ts`. A developer build started with `PYXIS_AGENT_LESSON=1` writes lessons with it; an installed app ignores the switch, and nothing changes without it.

## The question

Pyxis writes a lesson as a fixed pipeline (`src/core/study/openLesson.ts`, prompt `lesson.write`): core takes the topic's passages in reading order, splits them into parts of at most 24,000 characters, and asks the model to teach each part. The alternative is an agent: the model gets read-only study tools over the student's sources, decides what to read, and cites what it read. On 2026-10-27 Tost asked for one flow built the agent way so the two can be compared. This note covers how the model gets tools without tying Pyxis to one provider, what the prototype does, and the measured comparison.

## How the model gets study tools

Pyxis calls every model through cli-funnel 0.6.1 with access `none`. The tools may read only the student's sources in the workspace, and the model must never get the filesystem, a shell or the network. Three ways to give it tools were weighed.

### What each provider allows

These come from the capabilities cli-funnel 0.6.1 reports in code and from its source (`node_modules/cli-funnel/dist`), checked on devbox on 2026-10-30.

|                                       | Claude Code                                        | Codex                                                                  | Cursor Agent          | Antigravity           | API providers, Ollama |
| ------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- | --------------------- | --------------------- | --------------------- |
| Text only (`none`)                    | yes                                                | yes                                                                    | yes                   | yes                   | always                |
| HTTP MCP server, lowest access        | `supervised`                                       | `supervised`                                                           | `auto`                | `full`                | no MCP                |
| What that access also gives the model | read tools, and any approval Pyxis forgets to deny | commands on Codex's known-safe list, such as `cat`, run without asking | shell commands        | everything            | nothing               |
| Native function calling (`tools`)     | refused                                            | refused                                                                | refused               | refused               | yes                   |
| Keeps the conversation between turns  | live process                                       | live process                                                           | new process each turn | new process each turn | history in Pyxis      |

cli-funnel refuses an HTTP MCP server at `none` for every CLI ("An HTTP MCP server" needs `supervised` or higher), and a stdio server needs `full`. Leaving `none` also loads the user's own CLI settings again: the cli-funnel docs measure about 21,800 input tokens per Claude Code call before stripping them and about 400 after.

### The three options

1. **Text protocol (chosen).** The model replies with a ` ```pyxis-tool ` block holding JSON tool calls; core runs them and sends the results back in the same conversation. It works at `none` on all eight providers, and core runs every tool, so the model never touches the machine. The cost is one model call per round of reading. Claude Code and Codex keep the session, so a round sends only the results; Cursor Agent and Antigravity get the whole transcript again each round.
2. **MCP server in core.** Portable in principle, but no CLI accepts an MCP server at `none`. Each level that accepts one also lets the model read files or run commands, which breaks the rule above, and Antigravity needs `full`. It would also put a local HTTP server with a token inside core.
3. **Native tool calling.** Clean and fast, but only the API providers and Ollama take `tools`; the four CLIs, which most students use, refuse them. It is worth adding later as a second transport for those providers, behind the same tool executor.

The text protocol is the only option that keeps Pyxis independent of the provider without giving any CLI more than `none`.

## What the prototype does

`agentLesson()` in `src/core/study/agentLesson.ts` runs the loop; `writeAgentLesson()` adds the cache and the book fallback the pipeline has. The study handler picks it only when core was started unpackaged with `PYXIS_AGENT_LESSON=1`.

- **Opening turn.** The topic title and an outline of its passages: each section of the source (a book paragraph, named by its first heading) with the labels `P1`, `P2`, ... and the first words of each passage. Passage ids never reach the model.
- **Tools.** `list_sections`, `read_section`, `search` (full-text search over the plan's sources, never other sources) and `read` (up to 4 labels a tool has shown). The rules are in `resources/prompts/lesson.agent.md`, appended to the pipeline's `lesson.write` rules with its "do not cite" sentence replaced by the shared citation rule.
- **Refusals.** A malformed block, an unknown tool, bad arguments, a label never shown, an unknown section and calls past 4 per reply are refused with the reason, and a refused call still uses up the budget.
- **Limits.** 16 tool calls, 8 model calls and 10 minutes per lesson, and 24,000 characters of results per round. A passage that does not fit in a round is named, not sent. When the next reply is the last one allowed, the results say so; a tool request there ends the loop with `agent-limit`, and the time limit ends it with `agent-timeout`. Either one gives the book text, as a failed pipeline lesson does.
- **Citations.** The model may cite a label only after a tool returned its full text. `citeLesson()` renumbers those labels to the lesson's own `[P1]`, `[P2]` in order of first use and removes any other label with its space. The saved lesson's `passageIds` are the cited passages, so the lesson page's chips open them. The same function runs on the streamed draft, and tool requests never reach the page.
- **Storage.** Saved like a model lesson with its own cache key and `prompt_template = lesson.agent`, so the pipeline's cache never returns it and it never shadows a pipeline lesson.

`src/core/study/agentLesson.test.ts` covers the loop with fake engines: calls run and their results continue the conversation, search stays inside the plan, each kind of bad request is refused, the call, turn and time caps stop the loop, a student's Stop is not reported as a timeout, unread labels are dropped, and the handler keeps the pipeline unless the switch is on.

## Comparison

### Setup

- **Material.** Fisica 1 1.1.0 from books.politost.it (SHA-256 checked against the catalog), imported into an in-memory database: chapters 1, 4 and 5.
- **Engine.** Cursor Agent with Grok 4.7, effort `medium`, for both approaches. Codex was the first choice, but its login on devbox fails ("refresh token was already used", HTTP 401). Cursor's GPT-5.6 Terra is out of this week's included usage, and Claude was left alone because of its spend limit.
- **Runs.** One lesson per topic and approach, six in all, one at a time, with figures off. The harness is `src/core/study/agentLesson.live.test.ts`, skipped unless `PYXIS_LIVE_LESSON_COMPARE=1`.
- **First section** is measured as the lesson page shows it: the moment the second `##` heading appears in the streamed text.

### Results

| Topic                                         | Approach | First section | Total | Model calls | Tool calls | Input tokens | Output tokens | `##` sections | Lesson size | Citations         |
| --------------------------------------------- | -------- | ------------- | ----- | ----------- | ---------- | ------------ | ------------- | ------------- | ----------- | ----------------- |
| 1. Misure e vettori (21 passages, 27k chars)  | pipeline | 254 s         | 486 s | 2           | none       | 110k         | 29k           | 5             | 24.1k chars | none              |
|                                               | agent    | 266 s         | 321 s | 3           | 4          | 86k          | 20k           | 5             | 17.6k chars | 41 to 21 passages |
| 4. Lavoro ed energia (41 passages, 51k chars) | pipeline | 186 s         | 713 s | 3           | none       | 180k         | 43k           | 5             | 29.3k chars | none              |
|                                               | agent    | 337 s         | 393 s | 4           | 7          | 138k         | 25k           | 6             | 19.1k chars | 56 to 35 passages |
| 5. Momento angolare (33 passages, 42k chars)  | pipeline | 275 s         | 656 s | 2           | none       | 118k         | 38k           | 6             | 27.5k chars | none              |
|                                               | agent    | 388 s         | 451 s | 3           | 8          | 90k          | 22k           | 5             | 19.5k chars | 48 to 28 passages |

### Citation accuracy

I read every cited sentence or formula next to the passage it cites.

| Topic | Citations | Passage supports it | Partly | Wrong |
| ----- | --------- | ------------------- | ------ | ----- |
| 1     | 41        | 38                  | 3      | 0     |
| 4     | 56        | 55                  | 1      | 0     |
| 5     | 48        | 48                  | 0      | 0     |

The partial ones cite the right section for a paragraph whose last sentence comes from the next passage, for example $|\dot{\hat\lambda}| = |\dot\theta|$ cited to the Poisson-formula passage when it is in the one before. No citation named a passage the model had not read, so `citeLesson` dropped nothing. In chapter 5, 10 citations sit at the start of the paragraph after a display formula, so on screen the chip follows the formula it supports but reads as if it opened the next sentence.

The pipeline lessons have no inline citations, because `lesson.write` has told the model not to cite since lessons moved to smart text. Their sources footer lists every passage of the topic, so their citation accuracy cannot be compared sentence by sentence.

### What the numbers show

- **The agent read nearly everything.** In chapters 1 and 5 it read every section in order, and in chapter 4 it read most of the chapter and ran one search. On topics up to about 50,000 characters the tools add a round trip without changing what the model reads.
- **The first section came later with the agent** in all three topics, by 12 to 151 s, because the model reads for one or two rounds before it writes, while the pipeline starts writing in its first call.
- **The agent finished sooner** by 165 to 320 s and wrote shorter lessons (17.6k to 19.5k characters against 24.1k to 29.3k). The pipeline writes one part per call in sequence, and each part gets its share of the six sections, so long topics take longer and grow.
- **Input tokens were lower for the agent** even on Cursor, which resends the transcript each round, because the pipeline's later parts each carry up to 24,000 characters of material plus the system prompt.

## Recommendation

Keep the pipeline as the default lesson writer. It works the same on every engine with no protocol for the model to follow, and it shows the first section sooner, which is what the student waits for. The agent's advantages here came from writing in one call and from citing, and both can be had without an agent.

What each path would take:

- **Cited pipeline lessons, if you want citations back.** Label the passages in the pipeline's material `P1`, `P2`, ..., replace the "do not cite" sentence with the shared citation rule, and run `citeLesson()` on the result. That is a prompt version bump, a small change in `openLesson.ts` and its tests. Whether lessons should cite again is a product choice: they stopped citing on purpose when smart text arrived.
- **Shorter and faster long-topic lessons.** The agent's total time suggests sending a long topic in one call where the model's context allows it, instead of several parts. That is a separate change to `lessonParts`, to be measured on the same three chapters.
- **The agent loop where the reading is not known in advance.** Ask over a whole library, a gap drill that pulls from several topics, or "explain this from my sources" are cases where `search` and `read` earn their round trip. The tool executor, the text protocol, the citation check and the limits in `agentLesson.ts` carry over. For production it would still need the turn and tool counts in usage reporting, a progress line while the model reads, citations placed in the sentence that introduces a formula, and a native tool-calling transport for the API providers.
- **Switching lessons to the agent** would need the first section to come sooner. One way is to send the first section's passages in the opening turn so the model can start writing at once; without that, students waited up to 2.5 minutes longer for something to read in these runs.

## Limits of this comparison

- One run per topic and approach on one engine and one model, so a single slow call moves a row by a minute. The timings are from Cursor Agent, which starts a new process each call; Claude Code and Codex keep a session, which would make the agent's rounds cheaper.
- Figures were off for both approaches, and the lessons' teaching quality was not graded beyond reading them.
- In the Cursor runs three pipeline parts began with the engine's own narration ("Leggo prima la guida di scrittura, poi preparo..."), and in chapter 1 it joined the first `##` heading to that sentence. The agent lessons did not show it. This is a pipeline issue on Cursor Agent and is not changed here.
- Regenerating one section of an agent lesson is not wired: the section rewrite reads the pipeline's lesson.
