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
