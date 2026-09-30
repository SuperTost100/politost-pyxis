# Mastery

`masteryFor` in `src/core/study/mastery.ts` is a time-decayed average per topic. Each event has a score from 0 to 1. Its weight is `0.5 ** (age / halfLife)`, and the half-life is 14 days. Mastery is the weighted average, clamped to 0..1. A topic with no events is omitted.

This is not the plan's shrunk prior (`a = 3` pseudo-observations). That formula is the upgrade if a single perfect quiz should not jump a topic to 1.

The path uses those scores with a cap. Until the simulation node is finished, each topic counts as at most 0.5, so a perfect quiz unlocks the next practice step and the final check stays locked. After the simulation, the same scores count in full. Finishing the simulation does not raise a topic.

Unlock thresholds in `pathState`:

- The next topic's learn step needs the previous topic at 0.5 or more.
- Practice, cards and gaps need that topic at 0.5 or more.
- The simulation needs every topic at 0.5 or more.
- The final check needs every topic at the plan's saved target or more. A target of 1 is treated as 0.99 (`reachableTarget`), because this average cannot return to 1 after a miss.

Only the current step can be marked done. A locked step throws `node-locked`.

A topic is idle when its newest event is older than 7 days (`idleTopics`).
