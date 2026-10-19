# Data model

One SQLite file, `pyxis.db`, in the workspace. WAL and foreign keys are on. `synchronous` is `NORMAL`: a power cut can lose the last transactions but cannot corrupt the file. Core uses a 32 MB page cache and up to 256 MB of memory-mapped reads. On shutdown, and before main copies the workspace for a backup, restore or move, core checkpoints the WAL into `pyxis.db` and closes it. `0001_init.sql` creates the tables below. `PRAGMA user_version` is the migration marker. IDs are UUIDv7 text. Times are milliseconds. JSON columns are text with `json_valid`. Generated rows carry provenance: engine, model, template, version, and grounding.

`passages.rowid` is an integer. `passages_vec` stores that integer, because sqlite-vec primary keys are integers and must be bound as BigInt from JavaScript. Passage text is mirrored into `passages_fts`.

Migrations after the initial schema, applied in one transaction by `src/core/db/migrate.ts`:

| `user_version` | Change                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- |
| 2              | `chats.scope_json`                                                                      |
| 3              | `cards.passage_id`                                                                      |
| 4              | `plans.exam_at`, `plans.target` (default 0.75), `plans.style` (default `decide`)        |
| 5              | `messages.reaction` (`up`, `down`, or empty)                                            |
| 6              | `cards.suspended` (`0` or `1`). A suspended card stays out of the due queue             |
| 7              | `cards.seed_key` and `cards.removed`. A removed generated card is not created again     |
| 8              | Source `origin_url`/`fetched_at` and stale citation state in `item_passages`            |
| 9              | Stopped message state and chat subject                                                  |
| 10             | Saved chat context and source library visibility                                        |
| 11             | Reorderable subject position                                                            |
| 12             | Topic `tree_json` and dismissible jobs                                                  |
| 13             | `topics.archived_at`. A rebuild archives unmatched topics instead of deleting them      |
| 14             | `gaps.misconception` and `gaps.severity` (`severe` or `minor`), from the model analysis |
| 15             | `gaps.origin`, `gaps.comparison`, `gaps.merged_into` and the `gap_answers` table        |
| 16             | `sources.catalog_id` and `sources.catalog_version`, the free book a smartbook is        |
| 17             | Indexes for hot lookups and for every foreign-key child column                          |
| 18             | `cards.search_text`, the folded text the card browser searches                          |
| 19             | `messages.figures_json`, the images of the figures an answer drew                       |
| 20             | `plan_sources.role` (`material` or `past_paper`) and `plan_sources.paper_json`          |
| 21             | `messages.error`, `messages.passages_json` and the `engine_usage` table                 |

Migration 15 gives each distinct misconception its own gap. `origin` is `answers`, `flag` or `misconception`. `comparison` is `unchecked` while the gap could not be compared with its siblings. `merged_into` names the gap that absorbed a closed gap. `gap_answers` links one wrong answer (attempt id and question id) to the gap it counts for; it is used for ranking and closing. Its rows cascade with the gap and the attempt.

Migration 16 links a smartbook to the free PoliTost book it came from: its catalog id and the version it holds. Adding a book from the books list sets both. A book imported before 0.3 gets them the next time the list or the Sources page reads the catalog: by the package's SHA-256 when the catalog lists that package, otherwise by the `id` and semver `version` in the package's own `smartbook.json`. An update to a newer version adds the next `source_documents` version of the same source, rewrites `smartbooks.meta_json`, and keeps exercise ids (matched by the book's exercise id and kind). An exercise the new version dropped loses its `smartbook_id` but keeps its row, so flags and history on it still resolve. Lesson and quiz citations whose exact passage text is gone from the new version get `item_passages.stale = 1`.

Migration 17 indexes the latest review of a card (`card_reviews(card_id, reviewed_at)`), events by topic or item and kind, and every foreign-key child column that had no index, so a delete or a cascade finds its rows without reading the whole child table. `src/core/db/queryPlans.test.ts` fails if a hot query reads all of `card_reviews` or `learning_events` again.

Migration 18 adds `cards.search_text`: the card's front (a cloze as its text) and back, lower case, without accents or emphasis marks. The card browser fills it for every card where it is NULL before it searches, and the trigger `cards_search_stale` sets it back to NULL when the front or back changes. A new card and every card after the migration start at NULL.

Migration 19 stores the figures of an Ask answer. A model can ask for a figure as a fenced `pyxis-figure` block with a caption and matplotlib code. Core runs the code once in the Pyodide sandbox and keeps the PNG as a data URL in `messages.figures_json`, keyed by a hash of the code. The block stays in `body`; a block whose code failed is removed before the message is saved. A lesson keeps its figures the same way, in `figures` inside the item's `body_json`, so they are cached with the lesson and its rewrites.

Migration 20 lets a source be attached to a plan as a past exam (appello). `plan_sources.role` is `material` for everything that existed before and for every source the plan studies from, and `past_paper` for an old exam. A past paper is a role on the link, not a source kind, because the same PDF or photo goes through the same import, OCR and vision steps as any source, and because one file can be a past paper in one plan and study material in another. Every query that builds a plan from its sources (topics, rebuilds, syllabus checks, the tutor's scope, the plan view and plan file export) reads `role = 'material'` only, so a past paper never becomes a topic, a lesson or a citation. `paper_json` holds what the `paper.read` prompt read from the paper: its title, printed duration and total points, and per question the text, type (`open`, `choice`, `numeric` or `proof`), printed points, time in minutes, difficulty and a reference answer (the printed solution, or one the model wrote), plus the provider, model and prompt version of the reading. It is NULL while the paper has not been read; the `paper-read` job and its error say why. Photos of one exam are several sources: the first file's row holds the result, and each other file's row holds `{"partOf": <first source id>}` instead. Removing a paper, or removing its first file from the Library, removes all of its rows.

The past papers of a plan feed two things. The simulation builder summarises them (usual question count, duration, type and difficulty mix, a few example questions) and has the model write the exam after that summary. A practice quiz of the past questions is an ordinary `quiz` item with open answers whose body carries `pastPaper: 1`. Neither is part of a plan file: the exam text is the university's, so papers, and quizzes made from them, stay on this computer. Mastery gets no evidence from practising past questions, because their questions are not tied to a topic.

Migration 21 adds `messages.error`, the message key of the engine failure that cut a reply short (a stopped reply without it was stopped by the student), `messages.passages_json`, the passages a stopped reply was given as `{ passageId, index }` in P-number order, which Continue sends again unchanged, and `engine_usage`, one row per model call: time, provider, model, input and output tokens, prompt-cache reads and writes, and the chat and message or the job (with its kind) it was for. Those ids are plain text, not foreign keys, so the tokens of a deleted chat or a replaced reply still count in the week they were used.

Current version is 21. A restored backup is migrated on a staging copy before it replaces the workspace. Progress charts bucket events by the student's local midnight, including a week that crosses a daylight-saving change.

| Table            | A row is                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| profile          | The student's profile. The renderer writes it.                                          |
| settings         | One app setting, keyed by name.                                                         |
| engines          | A configured model provider.                                                            |
| feature_engines  | Which engine a feature uses.                                                            |
| subjects         | A school subject.                                                                       |
| sources          | An imported file or link. A link keeps `origin_url` and `fetched_at` of its saved copy. |
| source_documents | One extraction version of a source.                                                     |
| passages         | An immutable chunk of a document.                                                       |
| passages_fts     | The full-text index of passages.                                                        |
| passages_vec     | The embedding index of passages.                                                        |
| smartbooks       | Metadata for a PoliTost smartbook source.                                               |
| exercises        | An exercise from a smartbook or a model.                                                |
| plans            | A study plan. `exam_at`, `target`, `content_language` and `style` come from the wizard. |
| plan_sources     | A source attached to a plan, as study material or as a past exam.                       |
| topics           | A node in a plan's topic tree.                                                          |
| topic_passages   | Passages that support a topic.                                                          |
| path_nodes       | One step on a plan's path.                                                              |
| items            | A generated lesson, question, or explanation.                                           |
| item_passages    | Passages cited by an item. Deleting a passage is restricted.                            |
| cards            | A flashcard. `passage_id` is the source passage shown on the back.                      |
| card_reviews     | One rating of a card.                                                                   |
| attempts         | A quiz or exercise attempt.                                                             |
| attempt_answers  | One answer inside an attempt.                                                           |
| gaps             | An open or closed knowledge gap. A topic can have several, one per misconception.       |
| gap_items        | The drill quiz built for a gap.                                                         |
| gap_answers      | A wrong answer (attempt and question) that counts for a gap.                            |
| maps             | A concept map.                                                                          |
| chats            | A tutor conversation.                                                                   |
| messages         | One turn in a chat.                                                                     |
| message_passages | Passages cited by a message.                                                            |
| attachments      | A file attached to a message, stored as a blob hash.                                    |
| whiteboards      | A whiteboard scene.                                                                     |
| flags            | A student flag on a generated item.                                                     |
| learning_events  | An append-only study event. Mastery is computed from these, not stored.                 |
| jobs             | A long task: extraction, plan build, download.                                          |
| job_steps        | One named step of a job. A retry skips steps that already stored output.                |
| engine_usage     | The tokens of one model call, with the chat message or job it was for.                  |

## Saved content and history

Schema declarations are in `src/core/db/migrations/0001_init.sql`; later changes are in `migrate.ts`. JSON payloads hold typed domain content without a new column for each prompt revision. Card payloads hold full FSRS state. Map payloads hold collections, graph edits, pinned positions and undo state. Attempt payloads hold question snapshots, deadlines, answers and model-grading checkpoints, so reopening does not silently replace the question set.

A seeded card the student deletes is soft-deleted (`cards.removed = 1`, its `seed_key` stays), so a later generation run does not create it again. The Flashcards tab lists these under Removed and can restore them. A hand-made card has no `seed_key` and is deleted outright.

Cards come from the `cards.generate` prompt, one passage at a time, or from the student. Each card holds one fact, definition, formula or idea. Validation caps the front at 200 characters (240 for a cloze sentence) and the back at 300, and rejects display math (`$$`), blank-line paragraphs and step lists, so a worked exercise cannot become a card. Exercises are never seeded as cards. Up to 0.3.0 they were: the front was the exercise prompt cut at 400 characters and the `seed_key` was that same text. On the first start after that change, `retireExerciseCards` (`src/core/study/exerciseCards.ts`) sets `removed = 1` on those cards. It matches a card with no `prompt_template`, grounding `sources`, a `seed_key` equal to its front and equal to the prefix of an exercise that has an answer. Generated cards have a template and a `gen:` key, hand-made cards have no key, and a card whose front the student edited no longer matches, so none of them move. Review history stays, and Restore under Removed brings a card back. The pass runs once, marked by the settings key `cards.exercise-seeds-retired`, so a restored card is not removed again.

The student can also make cards from a tutor's answer or from selected lesson or source text (`src/core/study/cardsFromText.ts`). The `cards.text` prompt returns one to eight cards under the same limits and form rules (question, concept or cloze), each with the id of the passage that states its fact or null. Core stores nothing at that point: the student edits or drops cards in a review dialog, and `study.cardsSaveProposed` then inserts the kept ones into the chosen plan and topic with `prompt_template` `cards.text`, a `text:` seed key, grounding `sources` when a passage is linked and `general` when not. A front the topic already has (not removed) is skipped. The new cards have no review row, so they are due at once like any new card.

Subjects have a stable saved position. Source documents and passages retain extraction and locator information; the blob hash identifies original bytes. Deleting cited passages is constrained by references.

Deleting a chat or a plan also deletes the hidden sources it brought (`library = 0`: chat attachments, a plan file's copies of its originals) that nothing else uses, then the files no row names. Use includes IDs in JSON without a foreign key: any item body, map, topic tree, learning event, setting or exercise locator that mentions the source, one of its passages or one of its book's exercises keeps it. A plan file's smartbook copy goes with its book row, and quotes of a skipped original go once nothing cites them. Settings, Data, Free up space does the same for the whole workspace: hidden sources no plan or chat lists, removed library sources nothing cites, then every blob no source, attachment, document version, whiteboard or job that may still run names. That last group covers the extraction result of a finished import. A failed or cancelled job keeps its files, because Retry reads them again. It says how many bytes it freed. Flags have a target kind as well as an ID so a flagged exercise cannot accidentally suppress a card with the same ID.

`learning_events` is the input for derived mastery, activity and gap calculations. Active-time events count time rather than evidence of knowledge. Flagged exercise evidence is excluded by progress queries. Graph and heatmap buckets use local calendar boundaries. Gap closure's distinct-day rule uses local calendar days too (`study/gaps.ts`). Each gap writes one `gap_opened` and one `gap_closed` event; see [mastery](mastery.md). Core keeps each plan's events and card reviews in memory after the first read (`src/core/plans/evidenceCache.ts`). Temporary triggers on its connection drop a plan's copy when a row of `learning_events`, `card_reviews`, `cards`, `items`, `attempts` or `attempt_answers` for that plan changes, and every copy when `flags` changes. The same triggers send the `plans.evidence` broadcast, which marks the renderer's exam list, plan and Progress data out of date.

The session planner keeps the student's study hours in the `planner` settings row: `weeklyHours`, the usual hours a week or null until set, and `weeks`, the hours of single weeks keyed by the date of their Monday (`YYYY-MM-DD`). Saving drops weeks that are over. The plan itself is computed on every read and never stored; see [Oggi and the session planner](mastery.md#oggi-and-the-session-planner).

Plan files are a portability format, not a database dump. Version 2 includes study content and cited source excerpts, remaps IDs on import and optionally carries progress/original sources. With progress it also carries the gap rows, the attempts events name, the wrong answers each gap owns and its drill quiz. See [plan file](plan-file.md). Workspace backups preserve the study database and source blobs. They exclude provider keys, runtime/model caches, scratch files and the exports folder. Restore preserves runtime/model caches already downloaded in the destination workspace; a fresh workspace can download them again. Restore validates and migrates a staging copy before replacing the active workspace.

### Automatic backups

Automatic backups use the same archive format, so Restore accepts them unchanged. Main takes them while core keeps running, and only once core has reported ready: on a first launch `pyxis.db` exists for a moment before its tables do, and a copy then would fail. It opens `pyxis.db` through its own read-only connection and runs `VACUUM INTO`, which copies one committed state while core goes on writing in WAL mode. A transaction still open at that moment is left out. Blobs are immutable once published and only deleted after no row uses them, so the copy checks every blob the snapshot uses against the archive. If core deleted one after the snapshot (a deleted chat's attachment, or Free up space), the backup stops with `backup-changed` and runs again at the next check. A blob that core is still writing, and that the snapshot does not use, is left out.

The settings and the last result are main-process state in `userData/backups.json`, not a row in the `settings` table. The folder is a path on this computer, and a restore or a move must not roll back the record of the last backup.

A workspace with no source, plan, chat or whiteboard is not backed up automatically. On a new computer set up to restore, that empty copy would be the newest file in a synced folder. Back up now still copies it, because the student asked.

Each computer marks its automatic backups with an ID: eight hex digits made on its first backup, saved in `backups.json` as `backupId` and added to every file name, as in `pyxis-auto-backup-2026-10-13-210512-1a2b3c4d.zip`. The ID is in `backups.json` and not in the database, so a computer that restores another one's backup still gets its own. Retention keeps the newest three files with this computer's ID and deletes nothing else, so two computers sharing a synced folder never delete each other's backups. Files from Pyxis 0.3.1 and earlier have no ID. Retention never deletes them, since nothing proves which computer wrote them, and Restore accepts them as before. Delete all data with its backups box ticked removes this computer's backups and those without an ID, and keeps backups with another computer's ID.

## Restore safety

Restore validates and migrates a staging copy, keeps the original workspace until the new core is healthy, and recovers from an interrupted swap. The steps are in [architecture](architecture.md#restore-safety).
