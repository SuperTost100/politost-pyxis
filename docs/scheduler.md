# Card scheduler

`src/core/study/schedule.ts` uses `ts-fsrs` with default parameters, target retention `0.9` and fuzz disabled. A new card is immediately due. Each review revives the stored FSRS card, calculates the selected next state and persists the complete result.

| Pyxis button | FSRS rating |
| ------------ | ----------- |
| Again        | Again       |
| Hard         | Hard        |
| Good         | Good        |
| Easy         | Good        |

Easy deliberately maps to Good, as specified in the build plan. A student's Easy self-rating therefore cannot accelerate the schedule more than a correct Good answer. The review history still records the button they pressed. Tests check that identical starting states reviewed with Good and Easy yield identical schedules.

`intervalDays` is FSRS `scheduled_days`. A card counts as mastered once that interval reaches 21 days. This is a progress classification, not a promise of permanent recall. Due dates may include short learning steps; they are not a fixed day ladder.

The JSON card state stores due date, stability, difficulty, elapsed/scheduled days, learning steps, repetitions, lapses, state and last review. `ease` remains as a compatibility field and holds the current difficulty after an FSRS review. A legacy row without full FSRS state starts from an empty FSRS card on its next review. Suspended and removed cards stay out of the due queue.

Changing retention or scheduler parameters changes future scheduling. Keep persisted state readable and update `schedule.test.ts` when making that change.
