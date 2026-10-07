# Card scheduler

`src/core/study/schedule.ts` uses `ts-fsrs` with default parameters, target retention `0.9` and fuzz disabled. A new card is immediately due. Each review revives the stored FSRS card, calculates the selected next state and persists the complete result.

| Button (English) | Button (Italian) | Rating in code | FSRS rating |
| ---------------- | ---------------- | -------------- | ----------- |
| Impossible       | Impossibile      | `again`        | Again       |
| Hard             | Difficile        | `hard`         | Hard        |
| Easy             | Facile           | `good`         | Good        |
| Very easy        | Molto facile     | `easy`         | Easy        |

The labels differ from the FSRS names on purpose. FSRS is tuned around Good, so the everyday button is the one students read as Easy, and Very easy is kept for cards they could answer without thinking. Watch the names when you read `schedule.ts`: `good` is the Easy button. Tests check that the four ratings from one starting state give four different due dates.

`intervalDays` is FSRS `scheduled_days`. A card counts as mastered when it is in the FSRS `Review` state and its stability is 21 days or more. Learning is `Learning`, `Relearning`, or `Review` below that line. A legacy row with no FSRS state falls back to its interval for this count. The counters are a progress classification, not a promise of permanent recall. Due dates may include short learning steps; they are not a fixed day ladder.

The JSON card state stores due date, stability, difficulty, elapsed/scheduled days, learning steps, repetitions, lapses, state and last review. `ease` remains as a compatibility field and holds the current difficulty after an FSRS review. A legacy row without full FSRS state starts from an empty FSRS card on its next review. Suspended and removed cards stay out of the due queue.

Changing retention or scheduler parameters changes future scheduling. Keep persisted state readable and update `schedule.test.ts` when making that change.
