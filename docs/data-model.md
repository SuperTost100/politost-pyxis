# Data model

One SQLite file, `pyxis.db`, in the workspace. WAL and foreign keys are on. `0001_init.sql` creates the tables below. `PRAGMA user_version` is the migration marker. IDs are UUIDv7 text. Times are milliseconds. JSON columns are text with `json_valid`. Generated rows carry provenance: engine, model, template, version, and grounding.

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

Migration 15 gives each distinct misconception its own gap. `origin` is `answers`, `flag` or `misconception`. `comparison` is `unchecked` while the gap could not be compared with its siblings. `merged_into` names the gap that absorbed a closed gap. `gap_answers` links one wrong answer (attempt id and question id) to the gap it counts for; it is used for ranking and closing. Its rows cascade with the gap and the attempt.

Current version is 15. A restored backup is migrated on a staging copy before it replaces the workspace. Progress charts bucket events by the student's local midnight, including a week that crosses a daylight-saving change.

| Table            | A row is                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| profile          | The student's profile. The renderer writes it.                                          |
| settings         | One app setting, keyed by name.                                                         |
| engines          | A configured model provider.                                                            |
| feature_engines  | Which engine a feature uses.                                                            |
| subjects         | A school subject.                                                                       |
| sources          | An imported file or link.                                                               |
| source_documents | One extraction version of a source.                                                     |
| passages         | An immutable chunk of a document.                                                       |
| passages_fts     | The full-text index of passages.                                                        |
| passages_vec     | The embedding index of passages.                                                        |
| smartbooks       | Metadata for a PoliTost smartbook source.                                               |
| exercises        | An exercise from a smartbook or a model.                                                |
| plans            | A study plan. `exam_at`, `target`, `content_language` and `style` come from the wizard. |
| plan_sources     | A source attached to a plan.                                                            |
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

## Saved content and history

Schema declarations are in `src/core/db/migrations/0001_init.sql`; later changes are in `migrate.ts`. JSON payloads hold typed domain content without a new column for each prompt revision. Card payloads hold full FSRS state. Map payloads hold collections, graph edits, pinned positions and undo state. Attempt payloads hold question snapshots, deadlines, answers and model-grading checkpoints, so reopening does not silently replace the question set.

Subjects have a stable saved position. Source documents and passages retain extraction and locator information; the blob hash identifies original bytes. Deleting cited passages is constrained by references. Flags have a target kind as well as an ID so a flagged exercise cannot accidentally suppress a card with the same ID.

`learning_events` is the input for derived mastery, activity and gap calculations. Active-time events count time rather than evidence of knowledge. Flagged exercise evidence is excluded by progress queries. Graph and heatmap buckets use local calendar boundaries. Gap closure's distinct-day rule uses local calendar days too (`study/gaps.ts`). Each gap writes one `gap_opened` and one `gap_closed` event; see [mastery](mastery.md).

Plan files are a portability format, not a database dump. Version 2 includes study content and cited source excerpts, remaps IDs on import and optionally carries progress/original sources. With progress it also carries the gap rows, the attempts events name, the wrong answers each gap owns and its drill quiz. See [plan file](plan-file.md). Workspace backups preserve the study database and source blobs. They exclude provider keys, runtime/model caches, scratch files and the exports folder. Restore preserves runtime/model caches already downloaded in the destination workspace; a fresh workspace can download them again. Restore validates and migrates a staging copy before replacing the active workspace.

## Restore safety

Restore validates and migrates a staging copy, keeps the original workspace until the new core is healthy, and recovers from an interrupted swap. The steps are in [architecture](architecture.md#restore-safety).
