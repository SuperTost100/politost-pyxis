# Mastery and recommendations

`src/core/study/mastery.ts` derives topic mastery from scored learning events. Scores are clamped to `0..1`; event age has a 14-day half-life. The prior is three observations with score zero.

```text
weight_i = type_weight_i * 0.5 ^ (age_days_i / 14)
mastery  = sum(weight_i * score_i) / (3 + sum(weight_i))
```

One perfect fresh answer gives `1 / 4 = 0.25`. Three perfect fresh answers give `3 / 6 = 0.5`. Six perfect fresh answers give `6 / 9 ≈ 0.667`. After 14 days with no new evidence, their combined weight halves, so six perfect answers give `3 / 6 = 0.5`. The prior prevents one lucky result from looking like mastery; decay prevents old evidence from counting forever.

Each quiz answer contributes one observation with weight 1, or 1.5 for open answers. Each simulation answer has weight 2. Reading a lesson contributes no mastery. Each active card contributes its current FSRS retrievability once, with weight 0.5 and age zero; repeated ratings cannot accumulate mastery. Flagged exercise evidence is excluded. Topics without evidence appear at zero. Plan mastery weights topics by their passage counts, including untouched topics. Historical charts replay answer evidence and the latest card review at each date. Older events recover question types from stored attempts when available; otherwise they use weight 1.

## Path rules

Before the simulation is complete, the path caps each topic's usable mastery at `0.5`. Completing the simulation removes that cap without inventing a mastery increase. The next topic's lesson and the current topic's practice/cards/gaps use the `0.5` threshold. Simulation requires every topic at least `0.5`; final check uses the plan's saved target. A target of 1 is treated as `0.99` by `reachableTarget`. Only the current path node may be completed.

## Knowledge gaps

A topic opens a gap after at least two imperfect answers in one attempt, or an open-answer score below `0.3`. A second open gap for the same topic is suppressed. Closure requires perfect later attempts on two distinct UTC days. Any imperfect later attempt keeps the gap open. Flagged source exercises can also keep a relevant gap open.

Preparation labels a gap severe when topic mastery is below half the plan target. It warns about a below-target topic after 21 days without study. The standalone `idleTopics()` helper defaults to seven days; the Preparation screen uses its own 21-day rule.

## Recommendation score

`src/core/plans/path.ts` assigns these weights:

```text
urgency = 1 + 2 / max(days_to_exam, 1)
deficit = max(0, target - topic_mastery)
score = 3 * due_cards + 4 * gap_count
      + 2 * deficit * urgency + days_idle + style_match
```

For two due cards, one gap, target `0.75`, mastery `0.5`, five days to the exam, two idle days and a matching style, the score is `6 + 4 + 0.7 + 2 + 1 = 13.7`. The explanation prefers due cards, then gaps, then the next lesson. Equal scores keep the first candidate.

The current caller passes all open topic gaps as `gap_count`, despite the parameter's name `severeGaps`. It considers only current path nodes, so the score does not unlock or skip a locked lesson. Recommendation weights are rules in code, not a predictive model. Progress forecasts are estimates and never promise an exam result.
