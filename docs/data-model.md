# Data model

One SQLite file, `pyxis.db`, in the workspace. WAL and foreign keys are on. `0001_init.sql` creates the tables below. `PRAGMA user_version` is the migration marker. IDs are UUIDv7 text. Times are milliseconds. JSON columns are text with `json_valid`. Generated rows carry provenance: engine, model, template, version, and grounding.

`passages.rowid` is an integer. `passages_vec` stores that integer, because sqlite-vec primary keys are integers and must be bound as BigInt from JavaScript. Passage text is mirrored into `passages_fts`.

Migrations after the initial schema, applied in one transaction by `src/core/db/migrate.ts`:

| `user_version` | Change |
| --- | --- |
| 2 | `chats.scope_json` |
| 3 | `cards.passage_id` |
| 4 | `plans.exam_at`, `plans.target` (default 0.75), `plans.style` (default `decide`) |
| 5 | `messages.reaction` (`up`, `down`, or empty) |
| 6 | `cards.suspended` (`0` or `1`). A suspended card stays out of the due queue |

Current version is 6. A restored backup is migrated on a staging copy before it replaces the workspace. Progress charts bucket events by the student's local midnight, including a week that crosses a daylight-saving change.

| Table            | A row is                                                                 |
| ---------------- | ------------------------------------------------------------------------ |
| profile          | The student's profile. The renderer writes it.                           |
| settings         | One app setting, keyed by name.                                          |
| engines          | A configured model provider.                                             |
| feature_engines  | Which engine a feature uses.                                             |
| subjects         | A school subject.                                                        |
| sources          | An imported file or link.                                                |
| source_documents | One extraction version of a source.                                      |
| passages         | An immutable chunk of a document.                                        |
| passages_fts     | The full-text index of passages.                                         |
| passages_vec     | The embedding index of passages.                                         |
| smartbooks       | Metadata for a PoliTost smartbook source.                                |
| exercises        | An exercise from a smartbook or a model.                                 |
| plans            | A study plan. `exam_at`, `target`, `content_language` and `style` come from the wizard. |
| plan_sources     | A source attached to a plan.                                             |
| topics           | A node in a plan's topic tree.                                           |
| topic_passages   | Passages that support a topic.                                           |
| path_nodes       | One step on a plan's path.                                               |
| items            | A generated lesson, question, or explanation.                            |
| item_passages    | Passages cited by an item. Deleting a passage is restricted.             |
| cards            | A flashcard. `passage_id` is the source passage shown on the back.       |
| card_reviews     | One rating of a card.                                                    |
| attempts         | A quiz or exercise attempt.                                              |
| attempt_answers  | One answer inside an attempt.                                            |
| gaps             | An open or closed knowledge gap.                                         |
| gap_items        | Items attached to a gap.                                                 |
| maps             | A concept map.                                                           |
| chats            | A tutor conversation.                                                    |
| messages         | One turn in a chat.                                                      |
| message_passages | Passages cited by a message.                                             |
| attachments      | A file attached to a message, stored as a blob hash.                     |
| whiteboards      | A whiteboard scene.                                                      |
| flags            | A student flag on a generated item.                                      |
| learning_events  | An append-only study event. Mastery is computed from these, not stored.  |
| jobs             | A long task: extraction, plan build, download.                           |
| job_steps        | One named step of a job. A retry skips steps that already stored output. |
