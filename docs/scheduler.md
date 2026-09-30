# Card scheduler

Pyxis schedules cards with a fixed ladder in `src/core/study/schedule.ts`. It is not FSRS. Ease starts at 2.5 and stays between 1.3 and 3.0. A new card is due immediately (`intervalDays` 0).

| Rating | First review | Later reviews |
| --- | --- | --- |
| Again | due again now, ease minus 0.20 | 1 day, ease minus 0.20 |
| Hard | 1 day, ease minus 0.15 | round(interval × 1.2) days, at least 1, ease minus 0.15 |
| Good | 1 day | round(interval × ease) days, at least 1 |
| Easy | 2 days, ease plus 0.15 | round(interval × ease × 1.3) days, at least 1, ease plus 0.15 |

The plan's FSRS mapping (Easy treated as Good, a 21-day line, a target retention) is the upgrade path: replace `review()` with `ts-fsrs` and keep the same four ratings. Tests in `schedule.test.ts` pin the intervals above.
