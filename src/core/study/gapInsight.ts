import type Database from "better-sqlite3";
import { z } from "zod";
import { generate, type GenerateInput } from "../engine/generate";
import { planLanguage, systemPrompt } from "../engine/prompts";
import { selectionFor, type StoredSelection } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import { cosine } from "../plans/rebuild";
import { embedWithModel } from "../sources/retrieve";
import { assignAnswers, insertGap, mergeGap } from "./gapRows";

/** Short form of one mistake, for the progress screen and as the fallback while no analysis exists. */
export type GapMiss = {
  question: string;
  /** What the student answered, as text. */
  answer: string;
  expected: string;
  explanation: string;
  passageIds: string[];
};

/** One wrong answer with the evidence a model needs to read it: bounded, but not cut to a UI line. */
export type GapEvidence = GapMiss & { id: string; topicId: string; score: number; open: boolean };

const FULL = { stem: 500, answer: 400, expected: 400, explanation: 900 };

const clip = (value: unknown, max: number): string => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/** First sentence of the saved explanation: the shortest statement of what was misunderstood. */
const firstSentence = (value: string): string =>
  clip(/^.+?[.!?](?=\s|$)/s.exec(value)?.[0] ?? value, 200);

/** The student's pick as readable text: a multiple-choice index becomes its option. */
function pickText(
  question: { options?: string[]; answer?: { kind: string } },
  pick: unknown,
): string {
  if (typeof pick !== "string") return clip(pick == null ? "" : JSON.stringify(pick), FULL.answer);
  if (question.answer?.kind === "mcq" && /^\d+$/.test(pick.trim()))
    return clip(question.options?.[Number(pick)] ?? pick, FULL.answer);
  return clip(pick, FULL.answer);
}

type Row = { topic_id: string | null; body_json: string; payload_json: string };

const KINDS = "('quiz', 'diagnostic', 'simulation', 'review')";

/** Wrong answers of one graded attempt row. A mixed item (diagnostic, simulation, review) files each by its question's topic. */
function wrongsIn(row: Row): GapEvidence[] {
  const body = JSON.parse(row.body_json) as {
    questions?: Array<{
      id: string;
      stem?: string;
      topicId?: string;
      sourceIds?: string[];
      options?: string[];
      answer?: { kind: string };
    }>;
  };
  const { results = [], picks = {} } = JSON.parse(row.payload_json) as {
    picks?: Record<string, unknown>;
    results?: Array<{ id: string; score: number; expected?: string; explanation?: string }>;
  };
  const wrongs: GapEvidence[] = [];
  for (const result of results) {
    const question = body.questions?.find((item) => item.id === result.id);
    const topicId = row.topic_id ?? question?.topicId;
    if (!question?.stem || result.score >= 1 || !topicId) continue;
    wrongs.push({
      id: question.id,
      topicId,
      score: result.score,
      open: question.answer?.kind === "open",
      question: clip(question.stem, FULL.stem),
      answer: pickText(question, picks[result.id]),
      expected: clip(result.expected, FULL.expected),
      explanation: clip(result.explanation, FULL.explanation),
      passageIds: question.sourceIds ?? [],
    });
  }
  return wrongs;
}

/**
 * The newest wrongly answered questions behind a gap, with full evidence. A gap with linked answers reads exactly those;
 * one without (flag-only, or opened before links existed) reads its topic's misses since it opened. Rows are filtered
 * by topic before the limit, so recent mixed attempts on other topics cannot push this topic's evidence out.
 */
export function gapEvidence(db: Database.Database, gapId: string, limit = 5): GapEvidence[] {
  const gap = db
    .prepare("SELECT plan_id AS planId, topic_id AS topicId, opened_at AS openedAt FROM gaps WHERE id = ?")
    .get(gapId) as { planId: string; topicId: string | null; openedAt: number } | undefined;
  if (!gap?.topicId) return [];
  const linked = db
    .prepare("SELECT attempt_id AS attemptId, question_id AS questionId FROM gap_answers WHERE gap_id = ?")
    .all(gapId) as Array<{ attemptId: string; questionId: string }>;
  const mine = new Set(linked.map((row) => `${row.attemptId}\u0000${row.questionId}`));
  const rows = (
    linked.length > 0
      ? db
          .prepare(
            `SELECT a.id AS attemptId, i.topic_id, i.body_json, aa.payload_json FROM attempt_answers aa
             JOIN attempts a ON a.id = aa.attempt_id JOIN items i ON i.id = a.item_id
             WHERE a.id IN (SELECT DISTINCT attempt_id FROM gap_answers WHERE gap_id = ?)
               AND a.submitted_at IS NOT NULL AND json_type(aa.payload_json, '$.results') = 'array'
             ORDER BY a.submitted_at DESC`,
          )
          .all(gapId)
      : db
          .prepare(
            `SELECT a.id AS attemptId, i.topic_id, i.body_json, aa.payload_json FROM attempt_answers aa
             JOIN attempts a ON a.id = aa.attempt_id JOIN items i ON i.id = a.item_id
             WHERE a.plan_id = ? AND i.kind IN ${KINDS}
               AND (i.topic_id = ? OR (i.topic_id IS NULL AND EXISTS (
                 SELECT 1 FROM json_each(i.body_json, '$.questions') q WHERE json_extract(q.value, '$.topicId') = ?)))
               AND a.submitted_at IS NOT NULL AND a.submitted_at >= ?
               AND json_type(aa.payload_json, '$.results') = 'array'
             ORDER BY a.submitted_at DESC LIMIT 8`,
          )
          .all(gap.planId, gap.topicId, gap.topicId, gap.openedAt - SLACK)
  ) as Array<Row & { attemptId: string }>;
  const seen = new Set<string>();
  const found: GapEvidence[] = [];
  for (const row of rows)
    for (const wrong of wrongsIn(row)) {
      if (wrong.topicId !== gap.topicId || seen.has(wrong.question)) continue;
      if (linked.length > 0 && !mine.has(`${row.attemptId}\u0000${wrong.id}`)) continue;
      seen.add(wrong.question);
      found.push(wrong);
      if (found.length >= limit) return found;
    }
  return found;
}

/** The short form of `gapEvidence`: one line per field, the saved explanation cut to its first sentence. */
export function gapMisses(db: Database.Database, gapId: string, limit = 3): GapMiss[] {
  return gapEvidence(db, gapId, limit).map((wrong) => ({
    question: clip(wrong.question, 160),
    answer: clip(wrong.answer, 160),
    expected: clip(wrong.expected, 160),
    explanation: firstSentence(wrong.explanation),
    passageIds: wrong.passageIds,
  }));
}

// A gap opens in the same grading step that saves the answers; a few seconds of slack covers the gap between the two timestamps.
const SLACK = 10_000;

/**
 * One graded attempt's wrong answers, grouped by topic. A group qualifies for analysis (4.7) with two or more
 * wrong answers, or one wrong open answer scored under 0.3.
 */
export function attemptGroups(db: Database.Database, attemptId: string) {
  const rows = db
    .prepare(
      `SELECT i.topic_id, i.body_json, aa.payload_json FROM attempt_answers aa
       JOIN attempts a ON a.id = aa.attempt_id JOIN items i ON i.id = a.item_id
       WHERE a.id = ? AND a.submitted_at IS NOT NULL AND i.kind IN ${KINDS}
         AND json_type(aa.payload_json, '$.results') = 'array'`,
    )
    .all(attemptId) as Row[];
  const groups = new Map<string, GapEvidence[]>();
  for (const row of rows)
    for (const wrong of wrongsIn(row))
      groups.set(wrong.topicId, [...(groups.get(wrong.topicId) ?? []), wrong]);
  return [...groups].map(([topicId, wrongs]) => ({
    topicId,
    wrongs,
    qualifies: wrongs.length >= 2 || wrongs.some((wrong) => wrong.open && wrong.score < 0.3),
  }));
}

const analysisSchema = z.object({
  misconception: z.string().trim().min(1).max(400),
  severity: z.enum(["severe", "minor"]),
});

/**
 * Where the analysis landed: `first` is the reading of a gap that had none, `merged` a close one into an existing gap,
 * `distinct` a different one that opened its own gap, and `unchecked` one that opened its own gap because it could not be compared.
 */
type Outcome = "first" | "merged" | "distinct" | "unchecked";
type Analysis = {
  misconception: string;
  severity: "severe" | "minor";
  outcome: Outcome;
  /** The gap the misconception ended up on. */
  gapId: string;
  provider: string;
  model: string;
  at: number;
};
type InsightParams = {
  planId: string;
  /** Jobs from before analysis was per attempt carry only a gap; they read that gap's evidence instead. */
  gapId?: string;
  topicId?: string;
  attemptId?: string;
  selection: StoredSelection;
  /** Written with the gap update: the stored result and which model produced it. Its presence means the job is done. */
  analysis?: Analysis;
};

/** ponytail: e5 sentence vectors are compressed into roughly 0.7 to 1, so 0.9 means "the same idea". Tune against real misconceptions. */
export const MISCONCEPTION_SIMILARITY_MIN = 0.9;

export type Embed = (text: string, signal?: AbortSignal) => Promise<Float32Array | null>;

type Known = { id: string; misconception: string };
type Nearest = { status: "merged"; gapId: string } | { status: "distinct" | "unchecked" };

/** Whether the new text is close to any known one. No local model, no consent or a failed embedding says "unchecked", never a guess. */
async function nearest(text: string, known: Known[], embed: Embed, signal: AbortSignal): Promise<Nearest> {
  try {
    const mine = await embed(`query: ${text}`, signal);
    if (!mine) return { status: "unchecked" };
    let missing = false;
    for (const other of known) {
      const theirs = await embed(`query: ${other.misconception}`, signal);
      if (!theirs) missing = true;
      else if (cosine(mine, theirs) >= MISCONCEPTION_SIMILARITY_MIN) return { status: "merged", gapId: other.id };
    }
    return { status: missing ? "unchecked" : "distinct" };
  } catch {
    signal.throwIfAborted();
    return { status: "unchecked" };
  }
}

type OpenRow = {
  id: string;
  origin: string;
  misconception: string | null;
  severity: string | null;
  comparison: string | null;
};

/** The topic's open gaps while its topic is still active; a late job must not write to anything else. */
function openOn(db: Database.Database, planId: string, topicId: string): OpenRow[] {
  return db
    .prepare(
      `SELECT g.id, g.origin, g.misconception, g.severity, g.comparison FROM gaps g
       JOIN topics t ON t.id = g.topic_id AND t.archived_at IS NULL
       WHERE g.plan_id = ? AND g.topic_id = ? AND g.closed_at IS NULL ORDER BY g.opened_at, g.id`,
    )
    .all(planId, topicId) as OpenRow[];
}

/**
 * PRO-02 / 4.7: after each graded attempt, one analysis per topic whose wrong answers qualify and that has an open gap.
 * One job per attempt and topic, so a retried grade or a repeated call adds none; a failed job stays failed until retried from the jobs list.
 */
export function enqueueGapInsights(db: Database.Database, runner: Runner, attemptId: string) {
  const attempt = db
    .prepare("SELECT plan_id AS planId FROM attempts WHERE id = ? AND submitted_at IS NOT NULL")
    .get(attemptId) as { planId: string } | undefined;
  if (!attempt) return;
  for (const group of attemptGroups(db, attemptId)) {
    if (!group.qualifies || openOn(db, attempt.planId, group.topicId).length === 0) continue;
    const started = db
      .prepare(
        `SELECT 1 FROM jobs WHERE kind = 'gap-insight' AND json_extract(params_json, '$.attemptId') = ?
           AND json_extract(params_json, '$.topicId') = ?`,
      )
      .get(attemptId, group.topicId);
    if (started) continue;
    try {
      runner.start("gap-insight", {
        planId: attempt.planId,
        topicId: group.topicId,
        attemptId,
        selection: selectionFor(db, "grading"),
      } satisfies InsightParams);
    } catch {
      // The analysis is optional: a missing engine or unregistered job must never fail the grading that finished.
    }
  }
}

/**
 * A gap marked unchecked is compared with its siblings once the local model answers: a close one merges into the older gap,
 * and a gap that differs from all of them loses the mark. Without the model nothing changes.
 */
async function reconcile(db: Database.Database, planId: string, topicId: string, embed: Embed, signal: AbortSignal) {
  for (const gap of openOn(db, planId, topicId)) {
    if (gap.comparison !== "unchecked" || !gap.misconception) continue;
    const siblings = openOn(db, planId, topicId).filter(
      (other): other is OpenRow & { misconception: string } => other.id !== gap.id && !!other.misconception,
    );
    const result = await nearest(gap.misconception, siblings, embed, signal);
    if (result.status === "merged") {
      // The older gap keeps the id: merge into whichever of the pair opened first.
      const older = siblings.find((other) => other.id === result.gapId)!;
      const [from, into] = openedBefore(db, older.id, gap.id) ? [gap.id, older.id] : [older.id, gap.id];
      mergeGap(db, from, into);
    } else if (result.status === "distinct")
      db.prepare("UPDATE gaps SET comparison = NULL WHERE id = ? AND closed_at IS NULL").run(gap.id);
  }
}

const openedBefore = (db: Database.Database, a: string, b: string): boolean =>
  (db.prepare("SELECT (SELECT opened_at FROM gaps WHERE id = ?) <= (SELECT opened_at FROM gaps WHERE id = ?)").pluck().get(a, b) as number) === 1;

export function registerGapInsightJobs(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
  embed: Embed = embedWithModel,
) {
  runner.register("gap-insight", {
    jobClass: "model-cli",
    retryParams: (raw) => ({ ...(raw as InsightParams), selection: selectionFor(db, "grading") }),
    steps: [
      {
        name: "analysis",
        label: "jobs.gapInsight",
        async run(ctx) {
          const params = ctx.params as InsightParams;
          if (params.analysis) return true;
          const legacy = params.gapId
            ? (db.prepare("SELECT topic_id AS topicId FROM gaps WHERE id = ?").get(params.gapId) as { topicId: string | null } | undefined)
            : undefined;
          const topicId = params.topicId ?? legacy?.topicId ?? undefined;
          if (!topicId || openOn(db, params.planId, topicId).length === 0) return true;
          const wrongs = (
            params.attemptId
              ? (attemptGroups(db, params.attemptId).find((group) => group.topicId === topicId)?.wrongs ?? [])
              : gapEvidence(db, params.gapId!, 5)
          ).slice(0, 8);
          if (wrongs.length === 0) return true;
          const cited = [...new Set(wrongs.flatMap((wrong) => wrong.passageIds))].slice(0, 6);
          const passages = cited.length
            ? (db
                .prepare(
                  `SELECT p.text FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id
                   WHERE tp.topic_id = ? AND p.id IN (${cited.map(() => "?").join(",")})`,
                )
                .all(topicId, ...cited) as Array<{ text: string }>)
            : [];
          const title = db.prepare("SELECT title FROM topics WHERE id = ?").get(topicId) as
            | { title: string }
            | undefined;
          const result = await generate({
            selection: params.selection,
            run,
            signal: ctx.signal,
            schema: analysisSchema,
            system: systemPrompt("gap.insight", { contentLanguage: planLanguage(db, params.planId) }),
            prompt: JSON.stringify({
              topic: title?.title ?? "",
              mistakes: wrongs.map(({ question, answer, expected, explanation }) => ({
                question,
                answer,
                expected,
                explanation,
              })),
              passages: passages.map((row) => clip(row.text, 1000)),
            }),
          });
          ctx.signal.throwIfAborted();
          const data = result.data as z.infer<typeof analysisSchema>;
          const text = clip(data.misconception, 200);
          // Compare with every other gap's reading on the topic. Another analysis may land while the embeddings run, so look
          // again until nothing new is left to compare; the last read and the write below share one synchronous step.
          let status: Nearest["status"] = "distinct";
          let matchId: string | undefined;
          const compared = new Set<string>();
          const keyOf = (gap: Known) => `${gap.id}\u0000${gap.misconception}`;
          for (let round = 0; ; round += 1) {
            const open = openOn(db, params.planId, topicId);
            if (open.length === 0) return true;
            const fresh = open
              .filter((gap): gap is OpenRow & { misconception: string } => !!gap.misconception)
              .filter((gap) => !compared.has(keyOf(gap)));
            if (fresh.length === 0) break;
            // Readings kept landing while the model compared; stop at the cap, but never call the newest ones distinct unseen.
            // The gap opens marked unchecked, and the next reconcile compares it with them.
            if (round === 3) {
              status = "unchecked";
              break;
            }
            const next = await nearest(text, fresh, embed, ctx.signal);
            for (const gap of fresh) compared.add(keyOf(gap));
            if (next.status === "merged") {
              status = "merged";
              matchId = next.gapId;
              break;
            }
            if (next.status === "unchecked") status = "unchecked";
          }
          const questionIds = wrongs.map((wrong) => wrong.id);
          const landed = db.transaction(() => {
            const open = openOn(db, params.planId, topicId);
            if (open.length === 0) return undefined;
            const attempt = params.attemptId
              ? (db.prepare("SELECT submitted_at AS at FROM attempts WHERE id = ?").get(params.attemptId) as { at: number } | undefined)
              : undefined;
            const holdsAttempt = (gapId: string) =>
              params.attemptId
                ? db.prepare("SELECT 1 FROM gap_answers WHERE gap_id = ? AND attempt_id = ?").get(gapId, params.attemptId) != null
                : false;
            const unchecked = status === "unchecked" ? ("unchecked" as const) : null;
            // The gap this attempt's own wrong answers opened and that has no reading yet takes the first one.
            const unread =
              open.find((gap) => gap.origin === "answers" && !gap.misconception && holdsAttempt(gap.id)) ??
              (params.attemptId ? undefined : open.find((gap) => gap.origin === "answers" && !gap.misconception && gap.id === params.gapId));
            const match = status === "merged" ? open.find((gap) => gap.id === matchId) : undefined;
            let outcome: Outcome;
            let gapId: string;
            if (unread && match) {
              // This attempt's own gap had no reading yet and the reading is close to a sibling's: they are one gap.
              outcome = "merged";
              gapId = match.id;
              mergeGap(db, unread.id, match.id);
              if (data.severity === "severe")
                db.prepare("UPDATE gaps SET severity = 'severe' WHERE id = ? AND closed_at IS NULL").run(gapId);
            } else if (unread) {
              outcome = "first";
              gapId = unread.id;
              db.prepare("UPDATE gaps SET misconception = ?, severity = ?, comparison = ? WHERE id = ? AND closed_at IS NULL").run(
                text,
                data.severity,
                unchecked,
                gapId,
              );
            } else if (match) {
              outcome = "merged";
              gapId = match.id;
              if (data.severity === "severe")
                db.prepare("UPDATE gaps SET severity = 'severe' WHERE id = ? AND closed_at IS NULL").run(gapId);
            } else if (!params.attemptId) {
              return undefined;
            } else {
              outcome = status === "unchecked" ? "unchecked" : "distinct";
              gapId = insertGap(db, {
                planId: params.planId,
                topicId,
                openedAt: attempt?.at ?? Date.now(),
                origin: "misconception",
                misconception: text,
                severity: data.severity,
                ...(unchecked ? { comparison: unchecked } : {}),
              });
            }
            if (params.attemptId) assignAnswers(db, gapId, params.attemptId, questionIds);
            ctx.setParams({
              ...params,
              topicId,
              analysis: {
                misconception: text,
                severity: data.severity,
                outcome,
                gapId,
                provider: result.provider ?? params.selection.provider,
                model: result.model ?? params.selection.model,
                at: Date.now(),
              } satisfies Analysis,
            });
            return gapId;
          })();
          if (landed)
            try {
              await reconcile(db, params.planId, topicId, embed, ctx.signal);
            } catch {
              // The reading is stored; a failed later comparison leaves the gaps marked unchecked.
              ctx.signal.throwIfAborted();
            }
          return true;
        },
      },
    ],
  });
}
