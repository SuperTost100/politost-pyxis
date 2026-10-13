# Plan file

Pyxis exports a UTF-8 JSON document named `<title>.pyxis.json`. New exports use version 2. The importer still accepts version 1. The runtime definition is `src/shared/plan-file.ts`; regenerate the public JSON Schema with `npx tsx scripts/gen-plan-schema.ts`.

A version 2 file contains the plan settings, ordered topics and path nodes, cards, lessons, questions, exercises, map collections and the passages those objects cite. `topic` is an index into `topics`, or null for content that belongs to the whole plan. Topics also carry their summary tree and `passageIds`. A minimal file is:

```json
{
  "version": 2,
  "title": "Fisica 1",
  "topics": [{ "id": "topic-1", "title": "Moti", "position": 0 }],
  "nodes": [
    {
      "id": "node-1",
      "title": "Moti",
      "kind": "learn",
      "position": 2,
      "topic": 0
    }
  ],
  "cards": [{ "id": "card-1", "front": "$v$", "back": "Velocita", "topic": 0 }],
  "examAt": 90000,
  "target": 0.8,
  "language": "it",
  "style": "read"
}
```

`createdAt` is the export time. `author` is optional and present only when the exporter's profile has a display name and the profile-name export option is selected; the app never guesses one. An importing app shows both, with an imported tag, so students know the plan was not made for their exact course. Files without `author` stay valid.

Each passage carries its quoted `text`, SHA-256 `textSha`, source and document references, source-file SHA-256 `sourceSha`, version, locator, section and character offsets. The importer checks the text hash and source hash before writing. It creates excerpt sources when the original files are absent. Citations can therefore open the quoted material in a fresh workspace. An excerpt does not pretend to contain the original PDF or smartbook archive.

Each topic may carry `grounding` (`sources`, `mixed` or `general`) and `archived`. `general` marks a topic written by the model without source material; the importing app shows the draft notice for it, and a plan whose active topics are all `general` is imported as a draft. A rebuild from sources (PLAN-13) sets topics aside as `archived: true` rather than deleting them. Their path nodes and cards stay in the file, as do their events and gaps when progress is included. The importing app keeps them out of the active plan, path and mastery. Files from before either field existed stay valid: a missing `grounding` imports as unknown and a missing `archived` means active.

`educationLevel` is the plan's education level (`primary`, `lower-secondary`, `upper-secondary`, `technical`, `vocational`, `university` or `other`). The tutor answers at that level for chats scoped to the plan. A file without it takes the importing student's profile level at import time.

`items` stores the lesson or question body, its topic, passage references and reported provider/model. Lesson cache keys travel with the body. Numbered citations such as `[P1]` keep their order through `item_passages`. Older questions without an ID receive a deterministic ID scoped to their item and position before export or import. The app never supplies a missing answer. Question IDs, source exercise references and inline `:::exercise{id="..."}` markers receive new IDs on import. Smartbook chapter IDs and paragraph labels remain source locators, so they keep their original values.

`maps` contains each topic's map collection. Every entry carries a title, graph and passage references. Graph layout, labels, positions, pinned nodes, colors, edges and the previous undo snapshot travel with it. Import assigns new graph node IDs and rewrites parents, edges and source references.

Every import creates new IDs for the plan and its owned content. It remaps the known references rather than reusing IDs from another workspace. Importing the same file twice creates two independent plans. Invalid topic indexes, dangling passage references, mismatched document/source versions, invalid graphs, duplicate IDs or corrupted quoted text reject the file before database rows are written. Database inserts run in one transaction.

## Optional source files and progress

`sources` lists each source's ID, title, kind, SHA-256, byte count and MIME type. The app adds base64 `data` only when the student selects source embedding. Import checks the decoded byte count and SHA-256 before writing any embedded file. Without `data`, source references and quoted excerpts remain available. The original source hash stays in excerpt document metadata for later exports. The importer sets it from the file's source list, after checking an embedded file's bytes against that hash, and ignores any hash the document carries itself. A rebuild after a re-extraction uses it to tell the same original file from an unrelated replacement.

At import a student may skip a missing source. The source row and its document are not created. Its quoted passages stay as readable excerpts without a source, and its book exercises stay available in practice, quizzes and simulations: the importer stamps them with the new plan so they are found by chapter without a smartbook row.

Imported card reviews require one of the four supported ratings and a bounded scheduler state. FSRS dates must be valid canonical ISO dates, counts and intervals must be finite and nonnegative, and saved due/interval fields must agree. Invalid schedules reject the import before any rows are written. Valid older schedules without an FSRS payload remain supported.

Progress is absent by default. When selected, `progress` carries learning events and each card's latest scheduling review and suspension state. A `lesson_completed` event stores its path `nodeId` as an index into `nodes`; import turns that index into the new node ID. Known IDs in other event payloads are remapped, including attempt and gap IDs (see Gap state). A payload reference to something the file does not carry, such as the card of a rating that was later deleted, is dropped on export while the event and its score stay. Import still rejects a dangling reference. Answer drafts, quiz picks, model grading jobs and simulation result bodies never travel as content. A shared plan does not include engine credentials, workspace settings or model caches.

### Gap state

A progress export also carries the knowledge-gap state, in four optional arrays. They are written only with `progress`.

- `gaps`: one row per gap, with `topic` (an index), `openedAt`, `closedAt`, `origin` (`answers`, `flag` or `misconception`), `misconception`, `severity`, `comparison` (`unchecked` or null) and `mergedInto`. A topic can have several gaps. An open gap that exists only because of a content flag is left out, because flags do not travel.
- `attempts`: the submitted attempts that progress events or gap answers name, each with its `item`, `startedAt` and `submittedAt` (an open attempt never travels). `item` is a quiz, diagnostic or simulation in the file, or null when the attempt's quiz was deleted. Answers and picks are not carried. An imported simulation attempt has no saved score or results and is omitted from exam history.
- `gapAnswers`: `{ gap, attempt, question }`, the wrong answers that count for a gap. A row is dropped on export when its attempt's quiz is not in the file.
- `gapItems`: `{ gap, item }`, the drill quiz built for a gap; the item is a quiz or diagnostic.

A finished review's questions travel as a `quiz` item, and only with progress, so that attempts and an adopted question's `gapId` have something to point at. A review with no submitted attempt, and the review's session queue, never travel. Without progress a file also leaves out every gap drill quiz, because its explanation is written from the student's wrong answers; ordinary generated quizzes stay.

Import gives every gap and attempt a new ID and remaps `mergedInto`, the gap answers, the drill links, the `attemptId` and `gapId` in event payloads, and the `gapId` of an adopted question. The file carries exactly one `gap_opened` event per gap and one `gap_closed` event per closed gap, with the new IDs, so a later sync adds none. The exporter writes them from the gap rows, so a legacy gap with no events still gets both. A `gap_opened` event has `gapId` and `origin`. A `gap_closed` event has `gapId` and a `reason` (`answers`, `flag` or `merged`); a merged close carries `into`, which is the row's `mergedInto`, and no other close does. Each event repeats its row's topic and time. The importer checks everything before writing. It rejects a reference to a gap, attempt, quiz or question the file does not contain; an attempt or drill that points at a lesson or simulation where a quiz is required; an open attempt; a duplicate answer link or gap event; a gap without its opened event, or a closed gap without its closed event; an event that disagrees with its row; a gap closed before it opened; an attempt submitted before it started; and a merge of an open gap, into another topic's gap, into a missing gap, or in a loop. Chains are checked in linear time. The arrays are limited to 100,000 rows each.

This is an additive extension, not a new version, because nothing that reads version 2 has to change. A file without `gaps` stays valid. Its gap events and the attempt and gap IDs in its payloads point into the exporter's database, so the importer drops them, and the gaps are replayed from the answers with one event each. Version 1 files get the same treatment. An older app that imports a file with gap state ignores the extra arrays. A version bump would make that older app refuse the whole file instead.

Version 1 carries topics, path nodes, cards, plan settings and optional progress or embedded sources. It has no portable lesson, question, map or citation content. Missing settings use no exam date, a target of 0.75, no content language and style `decide`. A stored target outside 0.5 to 1 is clamped on export. Path gating treats a target of 1 as 0.99, as defined by `reachableTarget`.

## Validation limits

The schema bounds titles, IDs, quoted text, collection sizes and embedded files. One source can contain at most 200 MiB. Each arbitrary JSON body is limited to 24 nested levels, 100,000 visited values, 10,000 entries per array, 200 keys per object and 1,000,000 characters per string. Non-finite numbers and prototype-related keys are refused. The importer also checks known lesson, introduction, quiz, diagnostic and simulation body fields, including question answer types and option indexes. Extra bounded metadata remains intact. JSON Schema describes the file shape; body checks, hash checks, reference checks, graph checks and JSON traversal limits run in the importer.

The shared-plan screen accepts a local file or an HTTP/HTTPS URL. The main process fetches links with a 30-second timeout and a 320 MiB response limit. It follows at most five redirects, validates each public destination and pins the connection to the checked address. Whole-workspace backup and restore use a separate ZIP format and staged database validation; see `src/core/share/backup.ts`.

Before writing a shared plan, the import review shows its content counts and missing originals. Each missing original can use a matching library copy, a verified local file, retained excerpts or Skip. Skip removes the original from the source list and keeps its cited quotes readable. Generated quiz questions retain their own provider and model attribution, including quizzes completed with several engines after retries.
