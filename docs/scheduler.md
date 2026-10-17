# Card scheduler

`src/core/study/schedule.ts` uses `ts-fsrs` with default parameters, target retention `0.9` and fuzz disabled. A new card is immediately due. Each review revives the stored FSRS card, calculates the selected next state and persists the complete result.

| Button (English) | Button (Italian) | Key | Rating in code | FSRS rating |
| ---------------- | ---------------- | --- | -------------- | ----------- |
| Again            | Da rivedere      | 1   | `again`        | Again       |
| Hard             | Difficile        | 2   | `hard`         | Hard        |
| Good             | Bene             | 3   | `good`         | Good        |
| Easy             | Facile           | 4   | `easy`         | Easy        |

The labels follow the FSRS names. Bene (Good) is the primary button, the everyday "I remembered it" answer. The buttons show the label only: no key number and no next review time. Keys 1 to 4 still rate, and the shortcuts dialog lists them. The page tells the student about the next review after the rating, not on the buttons. Tests check that the four ratings from one starting state give four different due dates.

`intervalDays` is FSRS `scheduled_days`. A card counts as mastered when it is in the FSRS `Review` state and its stability is 21 days or more. Learning is `Learning`, `Relearning`, or `Review` below that line. A legacy row with no FSRS state falls back to its interval for this count. The counters are a progress classification, not a promise of permanent recall. Due dates may include short learning steps; they are not a fixed day ladder.

The JSON card state stores due date, stability, difficulty, elapsed/scheduled days, learning steps, repetitions, lapses, state and last review. `ease` remains as a compatibility field and holds the current difficulty after an FSRS review. A legacy row without full FSRS state starts from an empty FSRS card on its next review. Suspended and removed cards stay out of the due queue.

Changing retention or scheduler parameters changes future scheduling. Keep persisted state readable and update `schedule.test.ts` when making that change.

## Card browser

The Flashcards tab (`/exams/cards`) reads the same stored state. A card with no review is new, one whose latest review has `dueAt` at or before now is due, and any other card shows its next review date. Editing a card changes only its front and back, so its `card_reviews` rows and schedule stay as they were. Deleting a card Pyxis wrote sets `removed`, and Restore clears it. A hand-made card is deleted for good, so the browser asks first. Cards of an archived topic are not listed.

## Anki packages

The Flashcards tab has **Import from Anki** and **Export to Anki**. Core code is `src/core/study/ankiImport.ts` (import) and `src/core/share/anki.ts` (export).

**Import** reads an `.apkg` (a ZIP) and adds cards to one topic the student picks. It reads `collection.anki21b` (zstd, the default export of recent Anki, decoded with `node:zlib`), `collection.anki21` or `collection.anki2`. The `collection.anki2` that sits beside an `.anki21b` is a stub, so it is never used. The collection is unpacked into its own temporary folder, opened read-only and deleted afterwards. Media files are never read.

| Anki                                                                | Pyxis                                                                                                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Cloze note, card `cN`                                               | One card whose only deletion is `{{c1::...}}`. The other deletions of the note show their text. Back Extra becomes the back. |
| Standard note with two or more fields                               | Field 1 is the front and field 2 the back. A second card (the reverse) swaps them.                                           |
| One-field type, a third card, image occlusion, over 4000 characters | Skipped and counted as not supported.                                                                                        |
| Front or back with no text left (pictures, sound only)              | Skipped and counted as empty.                                                                                                |
| Suspended card                                                      | Suspended card.                                                                                                              |
| Same front and back already in the topic                            | Left out and counted as a duplicate.                                                                                         |

Fields become plain text with bold, italic, code, lists and `$...$` math. Every other tag is removed and no HTML is stored.

**History.** The review log (`revlog`, buttons 1 to 4 for Again, Hard, Good, Easy) is replayed through the FSRS scheduler in time order, so each card gets its `card_reviews` rows and a state calculated by Pyxis. Anki's own interval and due date are not copied. Manual reschedules (ease 0) and entries dated before 2000 or in the future are ignored, and at most the last 500 reviews of a card are replayed. Imported reviews are not learning events, so they do not appear in the activity chart; the cards feed mastery like any reviewed card.

**Limits.** At most 50,000 notes, 100,000 cards and 192 MB of collection after inflating, and the ZIP is read with the bounded reader in `sources/zip-bounded.ts`. A file that is not a package, a package over the limits, and an `.anki21b` on a build with no zstd are refused with a message.

**Export** writes the legacy schema (`collection.anki2`, version 11) with a Basic and a Cloze note type and one deck, for the plan or for one topic. With history it also writes each card's latest state (type, queue, due day, interval, FSRS stability and difficulty in the card `data`) and one `revlog` row per rating. A Pyxis cloze card with several deletions becomes several Anki cards; its history goes to the first one.
