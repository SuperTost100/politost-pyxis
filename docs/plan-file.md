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

`examAt`, `target`, `language` and `style` travel with the file. An older file without them imports with no exam date, a target of 0.75, no language, and style `decide`. `topic` on a node or a card is an index into `topics`, or null when the step is the introduction, the diagnostic, the simulation or the final check. Import creates a new plan id and new topic ids, so importing the same file twice yields two plans. The shared-plan screen reads a file in the window, or asks the main process for an http or https link, then calls `plans.import`.

The file does not carry passages, lessons or citations. Those stay in the workspace that owns the sources. A backup of the whole workspace is a separate zip: a vacuumed `pyxis.db` plus the `blobs/` tree. See `src/core/share/backup.ts`.
