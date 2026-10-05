# Card scheduler

`src/core/study/schedule.ts` uses `ts-fsrs` with default parameters, target retention `0.9` and fuzz disabled. A new card is immediately due. Each review revives the stored FSRS card, calculates the selected next state and persists the complete result.

| Pyxis button | FSRS rating |
| ------------ | ----------- |
| Again        | Again       |
| Hard         | Hard        |
| Good         | Good        |
| Easy         | Easy        |

The buttons are labelled Impossible, Hard, Easy and Very easy. Easy follows FSRS Good, the middle button the algorithm is tuned for, and Very easy follows FSRS Easy, as specified in section 4.4.1. In the code the four ratings are named `again`, `hard`, `good` and `easy`, so `good` is the button labelled Easy and `easy` is Very easy. Tests check that the four ratings from one starting state give four different due dates.

`intervalDays` is FSRS `scheduled_days`. A card counts as mastered when it is in the FSRS `Review` state and its stability is 21 days or more. Learning is `Learning`, `Relearning`, or `Review` below that line. A legacy row with no FSRS state falls back to its interval for this count. The counters are a progress classification, not a promise of permanent recall. Due dates may include short learning steps; they are not a fixed day ladder.

The JSON card state stores due date, stability, difficulty, elapsed/scheduled days, learning steps, repetitions, lapses, state and last review. `ease` remains as a compatibility field and holds the current difficulty after an FSRS review. A legacy row without full FSRS state starts from an empty FSRS card on its next review. Suspended and removed cards stay out of the due queue.

Changing retention or scheduler parameters changes future scheduling. Keep persisted state readable and update `schedule.test.ts` when making that change.
