# Mastery and recommendations

`src/core/study/mastery.ts` derives topic mastery from scored learning events. Scores are clamped to `0..1`; event age has a 14-day half-life. The prior is three observations with score zero.

```text
weight_i = type_weight_i * 0.5 ^ (age_days_i / 14)
mastery  = sum(weight_i * score_i) / (3 + sum(weight_i))
```

One perfect fresh answer gives `1 / 4 = 0.25`. Three perfect fresh answers give `3 / 6 = 0.5`. Six perfect fresh answers give `6 / 9 ≈ 0.667`. After 14 days with no new evidence, their combined weight halves, so six perfect answers give `3 / 6 = 0.5`. The prior prevents one lucky result from looking like mastery; decay prevents old evidence from counting forever.

Each quiz answer contributes one observation with weight 1, or 1.5 for open answers. Each simulation answer has weight 2. A lesson's quick check answer, and a self-rating of a practice exercise, are light evidence with weight 0.5, half a quiz answer. A topic's quick checks count from one lesson only: the one, in any wording, with the most recent answer. A lesson in parts is one lesson here: every part's check counts, and a part read at two levels counts from the text answered last. Its answers count once per question, and only for questions still in its current text. Answering a lesson in another wording replaces all the earlier lesson's check evidence, and an answer to a check that a rewrite removed no longer counts. Pyxis keeps no earlier versions of a lesson's text, so historical charts also judge older answers against the current text: after a rewrite, the replaced answers drop out of earlier dates too. Reading a lesson contributes no mastery. Each active card that has been reviewed at least once contributes its current FSRS retrievability once, with weight 0.5 and age zero; repeated ratings cannot accumulate mastery. Retrievability uses the exact time since the last review, in fractional days, so it starts falling on the day of the review. A card whose latest rating is Again is in Learning or Relearning and contributes 0 until it is rated again. A card never reviewed contributes nothing, so creating cards does not lower mastery. Flagged exercise evidence is excluded. Answers recorded before their scores named a source exercise find it through their attempt's questions. Topics without evidence appear at zero. Plan mastery weights topics by their passage counts, including untouched topics. A topic without passages weighs 1, so a plan built without sources, or after its sources were removed, still shows progress. Historical charts replay answer evidence and the latest card review at each date. Older events recover question types from stored attempts when available; otherwise they use weight 1.

| Evidence                       | Weight |
| ------------------------------ | ------ |
| Quiz answer                    | 1      |
| Open quiz answer               | 1.5    |
| Simulation answer              | 2      |
| Quick check in a lesson        | 0.5    |
| Self-rating of an exercise     | 0.5    |
| Reviewed card (retrievability) | 0.5    |

## Answering and handing in a quiz

A quiz, diagnostic, review, gap drill or redo is answered first and graded when the student hands it in with Consegna. Until then every answer is a draft: it can change, and nothing is graded or counted.

- **Non lo so** (key `0`) saves an empty answer, and pressing it again takes it back. An answer typed and then erased goes back to blank, so only the button sets "Non lo so".
- **Segna per dopo** (key `S`) marks a question for later. The Domande card shows the mark on its number, and Consegna counts the marked questions. The marked ids are kept in the answer draft (`marked` in `study.quizDraft`, and in the simulation's body through `study.simulationDraft`), so closing and reopening keeps them. A draft saved before 0.5 kept skipped questions instead; an unanswered skipped question opens marked for later. Marking changes nothing in grading, the timer or the question order.
- **Consegna** sends every question: a blank one goes as an empty answer, the same as "Non lo so". When some are blank or marked, it first asks, with how many of each. Core scores an empty answer 0 for every question type and shows the right answer in the results. It is a normal wrong answer: the same `answer_given` evidence with score 0, counted for gaps.
- **Segnala la domanda** flags the question as wrong (`study.quizWrong`) while the quiz is open. It leaves the score and every later quiz, and a model-written diagnostic question gets a new one in its place.

Answers corrected one at a time before 0.5 stay as they were checked: the page keeps them read-only, and Consegna hands in the checked answer. A simulation has the same Domande card, Segna per dopo and Consegna, but no "Non lo so", because its blank answers are already handed in empty.

## Unfinished activities

"Da finire" on the exam page lists what the student started on that exam and did not hand in, newest first (`plans.unfinished`, `unfinishedActivities` in `src/core/plans/unfinished.ts`). Each entry is something its own page already resumes, and Riprendi opens it there:

| Activity                              | Unfinished while                                                                                                         | Riprendi opens                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Quiz, gap drill (Ripasso mirato)      | Its newest open attempt exists, answered or not, with no grading job; one entry per quiz, as `plans.openQuiz` resumes it | The quiz at the question it was left on                    |
| Quiz still being written              | Its build job runs ("in preparazione") or stopped before the questions were all written                                  | The quiz page, which shows the work or offers to try again |
| Diagnostic, redo, past-paper quiz     | Its newest open attempt exists; an earlier one of the same kind is no longer resumed, so it is not listed                | The same page at that attempt                              |
| Review (Ripasso)                      | Its session is not done and less than a day old, as `readReview` resumes it                                              | The review                                                 |
| Simulation                            | Its attempt is open and grading has not started                                                                          | The simulation at its question                             |
| Simulation being prepared or prepared | Its build job runs, stopped, or finished without an attempt started from it                                              | The simulation page                                        |

A timed quiz or a simulation whose time ran out stays listed as "Tempo scaduto" until it is opened, which hands it in as it does today. Exercises have no attempt and nothing to hand in, so they are never listed.

Elimina (`plans.deleteUnfinished`) asks once and says what is lost. It deletes the attempt with its answers and draft, and stops and deletes any job still writing, checking or grading it. A complete quiz on a topic, a gap drill and the diagnostic keep their questions, so the quiz stays among the topic's activities on the path and can be done again. Whatever was made only for that attempt goes with it: a quiz still being written, a redo, a past-paper quiz and a simulation, with the build a simulation started from. A review is discarded as its own page discards it: cards already rated stay rated. A simulation being prepared stops and its build is forgotten.

## What a topic's number is made of

`plans.masteryBreakdown` returns, for each topic, the parts of the formula above: for quiz answers (open ones included), simulation answers, quick checks, self-ratings and cards, the count, the summed weight after decay, the summed weighted score and the plain average score (for cards, the average recall). `masteryDetail` in `src/core/study/mastery.ts` computes them in the same pass as the number, and `masteryFor` returns its `mastery`, so `sum(points) / (3 + sum(weight))` equals the mastery shown. `decay` is the mastery minus what the same evidence would give with no decay. Progress shows these under each topic row.

## Self-rating of exercises

After a practice exercise the student can choose "Got it" (score 1) or "Missed it" (score 0). It is optional: "Mark as done" works without any rating, and an unrated exercise adds nothing. Each rating is an `answer_given` event with `evidenceKind: "self"`, the exercise id and a `questionScores` entry for that exercise, so flagging the exercise removes the rating like any other evidence from it. Three rules follow from its being light evidence:

- It decays like other evidence (half-life 14 days) and has weight 0.5.
- Like a quick check, it never opens or closes a gap, and a "Missed it" is not a wrong answer on a gap. Gaps follow graded answers only.
- It does not count as a solved exercise in the plan's series (`plans.series`).

The student can change a rating. Every choice is stored, but mastery counts one rating per exercise per visit: a rating replaces the exercise's previous rating when it comes less than 6 hours after it (`SELF_RATING_WINDOW_MS`). Choosing the same rating again writes nothing. Six hours or more later, a rating is a new observation on top of the old one, which has decayed. The practice page shows the rating from the last 6 hours as chosen and starts a new visit unrated. Replaying an earlier date keeps the rating that stood at that date.

One "Got it" on a fresh topic gives `0.5 / 3.5 ≈ 0.143`, against `0.25` for one perfect quiz answer. Changing it to "Missed it" within the window gives `0`, not the average of the two.

## Mistakes notebook

`src/core/study/notebook.ts` lists every question whose latest answer was wrong, under 1 point, for each plan. It reads the submitted attempts of quizzes, gap drills, reviews, the diagnostic, simulations and redos, plus the quick check answers stored as `answer_given` events, so it needs no table of its own. A book exercise is one question wherever it is asked, keyed by its exercise id. Any other question is keyed by its wording: its form, its stem and its options in any order. So a quiz that asks the same question again, a redo and a quick check asked as a quiz question all update one entry, and marking one copy wrong hides them all. A later right answer takes the question out, and a later miss brings it back. A question left blank changes nothing. A question marked wrong, a quick check a rewrite removed, and a question on an archived topic stay out.

Redo asks up to ten of them again as one quiz item with no topic (`redo: true` in its body). Handing it in records the answers like any whole-plan quiz: one `answer_given` event per topic with `evidenceKind: "quiz"`, so each answer weighs 1, or 1.5 when open, and the quiz adds no step to the path. A quick check comes back as a multiple-choice quiz question and a simulation question as an open answer graded against its reference, so both count as quiz answers when redone. A redo can open a gap like any other graded attempt.

## A lesson in parts

A topic's lesson can be split into short parts, each a `lesson` item with one question at the end (`lesson_outlines` and `lesson_parts` in the [data model](data-model.md)). Progress through them is in `src/core/study/partProgress.ts`. A topic without an outline keeps every rule on this page as it was.

- **A part is done** once its last quick check is answered, right or wrong, and the recap part once all its recap questions are answered. This holds in any wording of the part: a part's texts are the item it points at and every earlier `lesson.part` item whose cache key has the part's id as its scope (`partTextSql` in `src/core/study/partText.ts`). `study.lessonAnswer` then returns `partDone: true`. A part with no question (one shown as book text, or written without a check) is finished with "Fatto" through `study.partDone`, which refuses a part that has a question. A part done stays done: answering again, or answering a rewritten part's new question, keeps its first `done_at`. The `answer_given` event is the evidence, so a wrong answer is in the mistakes notebook like any quick check.
- **The topic's lesson is done** when the last part of the live outline is done (the recap where there is one), in the same transaction, also when the earlier parts are not all done yet. Its step names the first written part's item, which reopening the step opens. `finished` in the answer says so. A lesson step recorded without an item, such as "Fatto" on a lesson, names the topic's newest lesson that is not a part's text. `recordStep` records one lesson step per topic, so finishing the parts of a lesson already read adds none.
- **The suggestion** of a lesson in parts carries `part` in `plans.recommend`: the first part not done, with its position, the number of teaching parts, its title, kind, minutes and whether it is written. `resumeFrom` names the part done last on that topic when it was done before today (local time), and is null otherwise. A suggestion of anything else has no `part`.

Parts read with no answer counted are not study for rule 2, as a lesson read halfway never was.

## Path rules

Nothing on the path is locked. Every activity is open at any time and in any order; the path only suggests what to do first. `suggestStep` in `src/core/plans/path.ts` picks the first of these that applies:

1. Due cards or severe gaps on any topic. When several topics qualify, the recommendation score below picks the topic, and its due cards come before its gaps.
2. On a plan with no study yet, the introduction (when the plan has one), then the diagnostic. Pyxis stores no skip: "Skip the test" on the suggestion opens the lesson of the first unread topic, and reading it ends this rule like any other study.
3. A simulation, once every topic has reached the target.
4. A simulation, when the exam is 0 to 3 days away and some study has happened.
5. The topic of the latest lesson read, until it reaches `0.6` mastery (or the target, when that is lower) or the student has done three graded activities on it, whichever comes first. Exercises come first, then a quiz, then exercises again. A quiz follows exercises, and exercises follow anything else.
6. A quiz on the topic just practiced, while that topic is below the target. Practice is not graded: a self-rating moves mastery only a little, and many students rate nothing. Without the quiz, rule 9 would suggest practice on the same topic again and again. The topic whose stay under rule 5 just ended is the exception when rule 7 or 8 has somewhere else to go.
7. A review quiz on a read topic still below the target that nothing has touched for 7 days or more (`daysIdle`), the longest idle first.
8. The lesson of a topic with parts done and its lesson not done (see [A lesson in parts](#a-lesson-in-parts)), then the lesson of the next unread topic, in plan order.
9. Exercises on the weakest topic.

Exercises means practice for a topic under `0.5` mastery and a quiz from `0.5` up. The suggestion shown on each topic follows the same order for that topic alone: due cards, severe gaps, the lesson while it is unread, then practice or quiz by the same `0.5` line.

The target is the plan's saved target, except that a target of 1 is treated as `0.99` by `reachableTarget`, because a decayed weighted mean never returns to 1 after a miss. The same reachable target decides which topics count as on track in the plan list and on Progress. Finishing an activity records a step on the path whenever it happens.

### Staying on a topic

A quiz of five answers cannot reach a `0.75` target on its own, so a topic used to get three steps (lesson, exercises, quiz) and stay below the target. Rule 5 keeps the path on the topic a little longer. `gradedActivities` in `src/core/plans/steps.ts` counts the graded activities on the topic since its lesson step. A lesson is recorded as read once, so that step marks when the stay began. These count, one each:

- a submitted attempt with answers on the topic: a quiz, a gap drill, or the topic's share of a diagnostic, review or simulation;
- a run of "Got it" or "Missed it" ratings on its exercises;
- a run of flashcard ratings on its cards;
- a run of quick check answers in one of its lessons.

A run ends at a different kind of evidence or at any step on the topic, so two practice sessions each finished with "Mark as done" are two activities. Reading, opening a page and exercises finished without a rating are not graded. Quick checks answered while the lesson is first read come before its step, so they move mastery but do not count toward the three; quick checks answered on a later visit do. A student who keeps missing moves on after the third activity.

Rule 5 follows only the latest lesson. A student who reads another topic's lesson before the stay ends moves the stay to that topic; the earlier one comes back through rule 7 or 9.

### Spaced review

`daysIdle` is the number of calendar days since the latest learning event on the topic, of any kind except the `gap_opened` and `gap_closed` rows the app writes itself when it syncs, flags or merges gaps. Rule 7 suggests a quiz with the reason "review" for a topic whose lesson was read, whose mastery is below the target and whose `daysIdle` is 7 or more. A topic the student never read is left to rule 8, even when the diagnostic touched it long ago. Due cards and severe gaps still come first, and a stay under rule 5 finishes before a review.

### Reopening a finished step

A step records what was done: the lesson or introduction read (`itemId`) and the submitted quiz, gap drill, diagnostic or simulation (`attemptId`), in the `lesson_completed` payload. Plan files carry both, and import maps them to the copied rows. Clicking a finished step opens it again without recording anything:

- a lesson opens as it was read (by the step's `itemId`), even if the wording, level, language or material changed since; a lesson that is not the one the current settings give cannot have one part rewritten, but can be regenerated. An introduction opens to read again;
- a quiz, gap drill or diagnostic opens its attempt read-only, with the answers, the score and a Redo button; a simulation opens its graded attempt the same way;
- exercises open without "Mark as done";
- cards open without generating more cards, and record a step again only if a card is rated.

An attempt from an imported plan has no answers (see [plan file](plan-file.md)); it says so and offers Redo. Only Redo starts a new attempt, and only submitting that attempt adds a step. A step recorded before steps named their attempt opens the latest attempt of the same kind and topic submitted by the step's time; without one, a quiz step opens the topic's lesson.

## Knowledge gaps

Gap rows follow the answers. Reading the exam's path or the recommendation syncs them first, and a second sync changes nothing.

**Opening.** A topic opens a gap when one attempt has at least two imperfect answers on it, or one open answer scores below `0.3`, and no gap on that topic is open at that moment. Flagged source exercises open or keep a separate flag-only gap on their topic. When a real gap opens on a topic that already has a flag-only gap, the flag gap becomes it.

**More than one gap per topic.** After a graded attempt that qualifies, one model call reads the wrong answers and returns a misconception sentence and a severity. A local embedding model compares the sentence with the topic's other open gaps. A close reading (cosine similarity of at least 0.9) merges into the older gap. A different reading opens its own gap with its own id, wrong answers and drill. If the local model cannot compare, the new gap stays separate and is marked unchecked, and a later analysis retries it and merges it when the model answers. The same mark is set when readings kept arriving during the comparison and some were never compared. The 0.9 threshold is untuned and has only been tested with injected vectors.

**Closing.** A gap closes after two clean sessions on different local calendar days after its last miss, so day 0 open, day 1 miss, then clean sessions on days 2 and 3 closes it on day 3. A miss resets the count, it does not keep the gap open for ever. A session is clean for a gap when it has at least one correct answer and no wrong answer that counts for that gap. A gap that is still flagged stays open however well the answers go. Closing writes one `gap_closed` event, and opening writes one `gap_opened` event, in the same transaction as the row.

**Which wrong answers count for which gap.** A drill question counts for the gap its drill was built for. A wrong answer from an analysed attempt counts for the gap the analysis put it on. Any other wrong answer, such as a single miss that never reached an analysis, counts for every gap open on its topic at that time. This is an approximation. A lone miss cannot be pinned on one misconception without a model call per miss, and Pyxis does not guess. The cost is that a stray miss resets every open gap on the topic, so closing is slower when a topic has several gaps. The reverse choice would let a gap close while the student still misses the topic. A session with wrong answers that count for a different gap can count as clean for this one.

**Severity.** The model proposes `severe` or `minor`. Pyxis also labels a gap severe when topic mastery is below half the plan target, and a gap with no proposal and mastery at or above that line is minor. A Ripasso mirato that names no gap drills the topic's first gap in that order: severe first, then by the number of linked wrong answers, then by age.

**Merging.** The older gap keeps its id. The absorbed gap closes with `merged_into` pointing at the survivor, its wrong answers and drill items move to the survivor, and a severe reading stays severe. A merge is not a learning close. It writes a `gap_closed` event with reason `merged`, and a drill built for the absorbed gap is offered for the survivor.

**Levels.** The exam page tells open gaps apart in three levels, from the two severities Pyxis stores (`gapLevel` in `src/core/study/openGaps.ts`). A gap is serious when it is severe by the rule above. A minor gap is moderate while its topic is under the plan's target (the target the topic can reach, so a full-mark goal counts as 0.99), and minor once the topic has reached it. The list puts serious gaps first, then moderate, then minor; inside a level, the gap with the most linked wrong answers first, then the oldest, then the lowest id. A gap on a topic removed from the exam, a closed gap, and a gap with no topic are not listed or counted. Two gaps on one topic are two rows until the analysis merges them, even when their sentences are identical.

`plans.series` marks a below-target topic idle after 21 days without study. The standalone `idleTopics()` helper defaults to seven days.

## Recommendation score

`src/core/plans/path.ts` assigns these weights:

```text
urgency = 1 + 2 / max(days_to_exam, 1)
deficit = max(0, target - topic_mastery)
score = 3 * due_cards + 4 * severe_gap_count
      + 2 * deficit * urgency + days_idle + style_match
```

For two due cards, one severe gap, target `0.75`, mastery `0.5`, five days to the exam, two idle days and a matching style, the score is `6 + 4 + 0.7 + 2 + 1 = 13.7`. The explanation prefers due cards, then gaps, then the next lesson. Equal scores keep the first candidate.

The caller syncs the gap rows first, then passes only the open gaps that Progress would call severe (see Severity above) as `severeGaps`; a minor gap does not count. It only ranks topics that have due cards or severe gaps; it does not decide which lesson comes next. Recommendation weights are rules in code, not a predictive model. Progress forecasts are estimates and never promise an exam result.

## Oggi and the session planner

Oggi is today's work on each exam that is not archived, and the inner ring of the [exam rings](#exam-rings). Each exam's next step comes from `suggestStep`, the same path rules as the exam page, except that due cards are left out because the exam list shows them on their own line: the due flashcards of every exam, which opens `/cards/due`, one session over the due cards of every plan, the closest exam's first. Rating cards there records a cards step on each topic it touched. `todayPlan` in `src/core/plans/planner.ts` computes the day per exam; exams already past have no work today.

An exam's day is done once today's steps cover it: the exam's steps and lesson parts today must add up to the exam's part of the student's goal for the day, counted with the step estimates below, and at least one step or part must be done. The goal for the day is a seventh of the hours of this week (the week's own hours when it has them, as in the planner's weeks, otherwise the usual hours), and it is Oggi's target: not the planner's pace, which is the least an exam needs and can be a few minutes a day for an exam far away. With one exam, the target is the whole goal. With several, `todayGoals` divides the goal among the dated exams that still have work, in proportion to the pace each needs (its work at the start of today over the days before it, the same pace `spread` uses to share a short day), so the targets add up to the goal; an exam with no work left takes none. An exam whose part is under 2.5 minutes has nothing planned unless it was studied today. Without weekly hours nothing measures the day and it is never done, however many steps were taken: one step alone never makes a day's work. The same holds for an exam with no date, which has no days to divide, and on the exam day, which gets no study time.

The session planner (`sessionPlan`) takes every exam with a date after today, the hours the student can study each week and each plan's remaining work, and spreads that work over the days before each exam. The student sets the usual hours in an exam's settings, and they apply to every exam. The planner had a page of its own until 0.5, where a single week could get other hours; such a week still counts until it is over. Both are stored in the `planner` settings row.

### Remaining work

`remainingMinutes` estimates a plan's remaining work in minutes from what the path already knows:

| Work                                                       | Minutes                       |
| ---------------------------------------------------------- | ----------------------------- |
| Introduction, while nothing is studied and it was not read | 10                            |
| Diagnostic, while nothing is studied and it was not taken  | 15                            |
| Lesson of each unread topic                                | 30                            |
| Lesson of each unread topic in parts                       | Minutes of its parts not done |
| Each graded activity a topic below the target still needs  | 20                            |
| One simulation, until one is done                          | 60                            |

A topic at zero mastery needs `stayActivities` (3) graded activities, the length of a stay under rule 5. A topic part of the way to the reachable target needs that share of the three, rounded up: halfway needs 2, a topic at the target needs none. Flashcards are review, outside the planned work. The same minutes count a finished step: a lesson done today counts 30 minutes, a quiz or exercise 20. A part done today counts its own minutes (an estimate of 4 to 8 until it is written, then the measured time), and the lesson step its last part records counts nothing, because the parts were counted. Which one a step is follows from the item it names: a part's text counts nothing, any other lesson was read whole and keeps its 30, also when its topic has an outline.

These numbers are rules, not measurements. They do not use the recorded active time, and real sessions vary a lot. They make the plan proportional to what is left, which is what the spreading needs.

### Spreading the work

Every day from today to the last exam, each exam with work left needs a pace: its remaining work divided by the days left before it. The exam day itself gets no study time for that exam. A day has the week's hours divided by 7. When the day's time covers every pace, each exam gets its pace and the rest stays free, so the work is spread evenly up to each exam. When it does not, every exam gets the same share of its pace. The day after an exam its time goes to the others.

The plan starts from today's start: today's finished steps are added back to the remaining work, so studying today does not change today's share. Every read computes the plan again from the current mastery and steps, so a day without study simply leaves more work for fewer days, and the days left get more.

`neededHours` is the weekly time that would bring every exam to its target on time: for each exam, the work of that exam and every earlier one over the days before it, the largest such pace, times 7, rounded up to the half hour.

### Expected dates on the exam page

The exam page shows, for each topic below the target and for the simulation, the day the planner expects it done (`plans.schedule`, `planSchedule`). `remainingWork` splits the remaining minutes into pieces in the path's order: the introduction and diagnostic together, then each topic below the target in the plan's order (its lesson if unread and its graded activities), then the simulation. `finishDays` lays those pieces, one after the other, on the minutes the planner gives the exam each day from today. A piece ends on the first day whose minutes so far cover it and every piece before it, within the same 2.5 minutes Oggi allows. Today's finished steps come first, because the planner lays the exam out from the start of today. A piece that the days before the exam do not cover gets no date, and the page says it does not fit at this pace. Without hours in the planner, without a date, on the exam day or for an archived exam there are no dates. The path suggests topics in its own order (rule 8 and the stays of rule 5), so a date reads as "by this day at this pace", not as the day the student must open that topic.

### Falling behind

An exam is behind when work is still left on its exam day. The warning gives two numbers. At the pace the exam got, it reaches its target that many days after the exam: the work left divided by its average minutes a day. By the exam it gets the share of the way from its current mastery to the target that matches the share of its work done: an exam at 10% with a 75% target that gets half its work done shows about 42%. This assumes mastery grows in step with the work, which is a simplification; it says which exam needs more time, not what the exam result will be.

## Exam rings

Each exam shows three rings, computed together by `examRings` in `src/core/plans/planner.ts` (`plans.rings`). None of them adds a scoring model; each reads a number the planner or Oggi already computes.

- **Preparazione** is the exam's mastery as the exam list shows it, topics weighted by their passages, read on the student's grade scale. While there is no evidence at all (no answer counted, no topic with mastery and no graded step; reading a lesson or the introduction measures nothing), it shows "ancora da misurare" and its ring stays empty. Evidence that scores zero, such as a wrong answer to a lesson's quick check, is measured and shows 0.
- **Percorso** is the share of the path's work done, in the planner's minutes: one minus the work left (`remainingWork`) over the work the same path had with nothing studied. Reading a lesson moves it, and a lesson in parts moves it part by part, because its work with nothing studied is the minutes of all its parts. Mastery reaching the target moves it too; mastery that decays below the target moves it back. An exam without topics has no path.
- **Oggi** is the share of today's goal done, with Oggi's own rules: the minutes of today's steps over the exam's part of the goal for the day (see above), full once Oggi ticks the exam off, which is within 2.5 minutes of the target and never before. With 6 hours a week the goal is 51 minutes a day (360 / 7, rounded), so one exam 64 days away with only its 10-minute introduction done reads "10 di 51 min" and is not full; with two alike exams each target is 26 minutes. `todayMinutes` carries the two numbers for the legend ("Oggi 10 di 51 min", and "fatto, 51 min" once full) and for the name a screen reader hears. Without weekly hours it is not measured: the ring stays empty, `todayUnmeasured` is `no-goal`, and the exam page's legend and the path's notice offer "Imposta obiettivo di studio", which opens the weekly hours in the exam's settings. The hours count for every exam. Once they are set, Oggi measures from nothing done. With hours but no date (`no-date`) or on the exam day (`exam-day`) it is not measured either, and the legend says why. Nothing is planned for an archived or past exam, for a share under 2.5 minutes, or when the path has no next step, unless something was done today anyway.

The rings draw each share from the top; an empty value leaves its track bare. Percentages round down, so a ring never reads 100% before it closes.
