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

Gap rows follow the answers. Reading Progress or the recommendation syncs them first, and a second sync changes nothing.

**Opening.** A topic opens a gap when one attempt has at least two imperfect answers on it, or one open answer scores below `0.3`, and no gap on that topic is open at that moment. Flagged source exercises open or keep a separate flag-only gap on their topic. When a real gap opens on a topic that already has a flag-only gap, the flag gap becomes it.

**More than one gap per topic.** After a graded attempt that qualifies, one model call reads the wrong answers and returns a misconception sentence and a severity. A local embedding model compares the sentence with the topic's other open gaps. A close reading (cosine similarity of at least 0.9) merges into the older gap. A different reading opens its own gap with its own id, wrong answers and drill. If the local model cannot compare, the new gap stays separate and is marked unchecked, and a later analysis retries it and merges it when the model answers. The same mark is set when readings kept arriving during the comparison and some were never compared. The 0.9 threshold is untuned and has only been tested with injected vectors.

**Closing.** A gap closes after two clean sessions on different local calendar days after its last miss, so day 0 open, day 1 miss, then clean sessions on days 2 and 3 closes it on day 3. A miss resets the count, it does not keep the gap open for ever. A session is clean for a gap when it has at least one correct answer and no wrong answer that counts for that gap. A gap that is still flagged stays open however well the answers go. Closing writes one `gap_closed` event, and opening writes one `gap_opened` event, in the same transaction as the row.

**Which wrong answers count for which gap.** A drill question counts for the gap its drill was built for. A wrong answer from an analysed attempt counts for the gap the analysis put it on. Any other wrong answer, such as a single miss that never reached an analysis, counts for every gap open on its topic at that time. This is an approximation. A lone miss cannot be pinned on one misconception without a model call per miss, and Pyxis does not guess. The cost is that a stray miss resets every open gap on the topic, so closing is slower when a topic has several gaps. The reverse choice would let a gap close while the student still misses the topic. A session with wrong answers that count for a different gap can count as clean for this one.

**Severity.** The model proposes `severe` or `minor`. Pyxis also labels a gap severe when topic mastery is below half the plan target, and a gap with no proposal and mastery at or above that line is minor. Progress ranks gaps by severity, then by the number of linked wrong answers, then by age.

**Merging.** The older gap keeps its id. The absorbed gap closes with `merged_into` pointing at the survivor, its wrong answers and drill items move to the survivor, and a severe reading stays severe. A merge is not a learning close. It writes a `gap_closed` event with reason `merged`, and a drill built for the absorbed gap is offered for the survivor.

Preparation warns about a below-target topic after 21 days without study. The standalone `idleTopics()` helper defaults to seven days; the Preparation screen uses its own 21-day rule.

## Recommendation score

`src/core/plans/path.ts` assigns these weights:

```text
urgency = 1 + 2 / max(days_to_exam, 1)
deficit = max(0, target - topic_mastery)
score = 3 * due_cards + 4 * severe_gap_count
      + 2 * deficit * urgency + days_idle + style_match
```

For two due cards, one severe gap, target `0.75`, mastery `0.5`, five days to the exam, two idle days and a matching style, the score is `6 + 4 + 0.7 + 2 + 1 = 13.7`. The explanation prefers due cards, then gaps, then the next lesson. Equal scores keep the first candidate.

The caller syncs the gap rows first, then passes only the open gaps that Progress would call severe (see Severity above) as `severeGaps`; a minor gap does not count. It considers only current path nodes, so the score does not unlock or skip a locked lesson. Recommendation weights are rules in code, not a predictive model. Progress forecasts are estimates and never promise an exam result.
