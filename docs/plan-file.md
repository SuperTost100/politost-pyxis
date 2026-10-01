# Plan file

Version 1 is a JSON document, checked by `planFileSchema` in `src/shared/plan-file.ts`. The app saves it as `<title>.pyxis.json`.

```json
{
  "version": 1,
  "title": "Fisica 1",
  "topics": [{ "title": "1. Moti", "position": 0 }],
  "nodes": [{ "title": "1. Moti", "kind": "learn", "position": 2, "topic": 0 }],
  "cards": [{ "front": "fronte", "back": "retro", "topic": 0 }],
  "examAt": 90,
  "target": 0.8,
  "language": "en",
  "style": "read"
}
```

`examAt`, `target`, `language` and `style` travel with the file. An older file without them imports with no exam date, a target of 0.75, no language, and style `decide`. `progress` is absent unless the student ticks it. Each event stores `kind`, a topic index or null, `payload`, and `at`. Only a `lesson_completed` payload stores `nodeId` as an index into `nodes`. Import writes the new path node id. An old id on that event is dropped. A number stored in the database is dropped on export, so it is not read as an index. Other events keep `nodeId` as stored. `sources` lists each source by title, hash, and size. `data` is present only when the student ticks the source files. Import writes an embedded file into the workspace and checks the hash. A reference without `data` stays in the file and does not create a source. `topic` on a node or a card is an index into `topics`, or null when the step is the introduction, the diagnostic, the simulation or the final check. Import creates a new plan id and new topic ids, so importing the same file twice yields two plans. The shared-plan screen reads a file in the window, or asks the main process for an http or https link, then calls `plans.import`.

A stored target outside 0.5–1 is clamped to the nearest bound on export. On the path, a target of 1 opens at 0.99 (`reachableTarget` in `src/shared/plan-file.ts`).

A node or a card whose topic index is not null and falls outside `topics` is refused with `plan-file`. The import rolls back, so a bad file leaves no plan.

A shared link must be http or https. The fetch follows no redirects, aborts after 15 seconds, and stops reading past 1,000,000 bytes.

The file does not carry passages, lessons or citations. Those stay in the workspace that owns the sources. A backup of the whole workspace is a separate zip: a vacuumed `pyxis.db` plus the `blobs/` tree. Restore checks that the staged database already has `user_version` of at least 1 and the tables `plans`, `profile` and `path_nodes`, then runs migrations on that copy. A zip whose declared uncompressed size is over 2 GiB is refused. There is no compressed-size cap, so a backup this app can write still restores. A header that lies about uncompressed size can still expand. If the check or the migration fails, the zip is refused and the live workspace stays. See `src/core/share/backup.ts`.
