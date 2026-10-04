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

Each passage carries its quoted `text`, SHA-256 `textSha`, source and document references, source-file SHA-256 `sourceSha`, version, locator, section and character offsets. The importer checks the text hash and source hash before writing. It creates excerpt sources when the original files are absent. Citations can therefore open the quoted material in a fresh workspace. An excerpt does not pretend to contain the original PDF or smartbook archive.

`items` stores the lesson or question body, its topic, passage references and reported provider/model. Lesson cache keys travel with the body. Numbered citations such as `[P1]` keep their order through `item_passages`. Older questions without an ID receive a deterministic ID scoped to their item and position before export or import. The app never supplies a missing answer. Question IDs, source exercise references and inline `:::exercise{id="..."}` markers receive new IDs on import. Smartbook chapter IDs and paragraph labels remain source locators, so they keep their original values.

`maps` contains each topic's map collection. Every entry carries a title, graph and passage references. Graph layout, labels, positions, pinned nodes, colors, edges and the previous undo snapshot travel with it. Import assigns new graph node IDs and rewrites parents, edges and source references.

Every import creates new IDs for the plan and its owned content. It remaps the known references rather than reusing IDs from another workspace. Importing the same file twice creates two independent plans. Invalid topic indexes, dangling passage references, mismatched document/source versions, invalid graphs, duplicate IDs or corrupted quoted text reject the file before database rows are written. Database inserts run in one transaction.

## Optional source files and progress

`sources` lists each source's ID, title, kind, SHA-256, byte count and MIME type. The app adds base64 `data` only when the student selects source embedding. Import checks the decoded byte count and SHA-256 before writing any embedded file. Without `data`, source references and quoted excerpts remain available. The original source hash stays in excerpt document metadata for later exports.

Imported card reviews require one of the four supported ratings and a bounded scheduler state. FSRS dates must be valid canonical ISO dates, counts and intervals must be finite and nonnegative, and saved due/interval fields must agree. Invalid schedules reject the import before any rows are written. Valid older schedules without an FSRS payload remain supported.

Progress is absent by default. When selected, `progress` carries learning events and each card's latest scheduling review and suspension state. A `lesson_completed` event stores its path `nodeId` as an index into `nodes`; import turns that index into the new node ID. Known IDs in other event payloads are remapped. Answer drafts, quiz picks, model grading jobs and simulation result bodies never travel as content. A shared plan does not include engine credentials, workspace settings or model caches.

Version 1 carries topics, path nodes, cards, plan settings and optional progress or embedded sources. It has no portable lesson, question, map or citation content. Missing settings use no exam date, a target of 0.75, no content language and style `decide`. A stored target outside 0.5 to 1 is clamped on export. Path gating treats a target of 1 as 0.99, as defined by `reachableTarget`.

## Validation limits

The schema bounds titles, IDs, quoted text, collection sizes and embedded files. One source can contain at most 200 MiB. Each arbitrary JSON body is limited to 24 nested levels, 100,000 visited values, 10,000 entries per array, 200 keys per object and 1,000,000 characters per string. Non-finite numbers and prototype-related keys are refused. The importer also checks known lesson, introduction, quiz, diagnostic and simulation body fields, including question answer types and option indexes. Extra bounded metadata remains intact. JSON Schema describes the file shape; body checks, hash checks, reference checks, graph checks and JSON traversal limits run in the importer.

The shared-plan screen accepts a local file or an HTTP/HTTPS URL. The main process fetches links with a 30-second timeout and a 320 MiB response limit. It follows at most five redirects, validates each public destination and pins the connection to the checked address. Whole-workspace backup and restore use a separate ZIP format and staged database validation; see `src/core/share/backup.ts`.

Before writing a shared plan, the import review shows its content counts and missing originals. Each missing original can use a matching library copy, a verified local file, retained excerpts or Skip. Skip removes the original from the source list and keeps its cited quotes readable. Generated quiz questions retain their own provider and model attribution, including quizzes completed with several engines after retries.
