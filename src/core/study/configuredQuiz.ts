import { interestsLine } from "../profile/context";
import { randomInt } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { generate, type GenerateInput } from "../engine/generate";
import {
  languageName,
  planLanguage,
  systemPrompt,
  templateVersion,
} from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import { requireTopic } from "./openLesson";
import { flaggedIds } from "./flags";
import { topicExercises } from "./exercises";
import { saveQuiz, startAttempt, type QuizQuestion } from "./attempt";

export const quizKinds = [
  "mcq",
  "tf",
  "completion",
  "matching",
  "open",
] as const;
export const quizConfig = z.object({
  count: z.number().int().min(10).max(100).default(20),
  types: z
    .array(z.enum(quizKinds))
    .min(1)
    .max(5)
    .refine((types) => new Set(types).size === types.length)
    .default([...quizKinds]),
  scope: z.enum(["topic", "plan", "page"]).default("topic"),
  sourceId: z.string().min(1).optional(),
  page: z.number().int().min(1).max(100000).optional(),
  timerMinutes: z.number().int().min(1).max(180).optional(),
});
const text = z.string().trim().min(1).max(5000);
const common = {
  stem: text,
  explanation: text,
  passageIds: z.array(z.string()).max(8),
};
const questionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("mcq"),
    options: z.array(text).length(4),
    correct: z.number().int().min(0).max(3),
  }),
  z.object({ ...common, kind: z.literal("tf"), correct: z.boolean() }),
  z.object({
    ...common,
    kind: z.literal("completion"),
    accepted: z.array(text).min(1).max(8),
  }),
  z.object({
    ...common,
    kind: z.literal("matching"),
    pairs: z.array(z.array(text).length(2)).min(3).max(6),
  }),
  z.object({
    ...common,
    kind: z.literal("open"),
    reference: text,
    rubric: z.array(text).min(2).max(4),
  }),
]);

export type QuizInput = {
  planId: string;
  /** Required for the topic scope; plan and page quizzes span topics. */
  topicId?: string;
  scope?: "topic" | "plan" | "page";
  sourceId?: string;
  page?: number;
  timerMinutes?: number;
  count?: number;
  feedback?: boolean;
  types?: Array<(typeof quizKinds)[number]>;
  /** A gap drill (LES-03) is five questions. That size is the drill's own; a quiz a student configures keeps its minimum of ten. */
  drill?: boolean;
};
export type QuizSnapshot = {
  config: z.infer<typeof quizConfig>;
  questions: QuizQuestion[];
  passages: Array<{ id: string; text: string }>;
  passageTopics?: Record<string, string>;
  language: string;
  selection: ReturnType<typeof selectionFor>;
  grounding: "sources" | "general";
  /** A gap drill's short explanation of the misunderstanding, shown above its questions. */
  explanation?: string;
  /** PER-04 line captured at preparation; gap drills reuse this builder, so they carry it too. */
  interests?: string;
  provenance?: { provider: string; model: string };
};

export function prepareQuiz(
  db: Database.Database,
  input: QuizInput,
): QuizSnapshot {
  const config = quizConfig.parse(input.drill ? { ...input, count: undefined } : input);
  if (input.drill) config.count = Math.min(10, Math.max(1, input.count ?? 5));
  if (config.scope === "topic") {
    if (!input.topicId) throw new Error("topic-missing");
    requireTopic(db, input.planId, input.topicId);
  } else if (!db.prepare("SELECT 1 FROM plans WHERE id = ?").get(input.planId))
    throw new Error("plan-missing");
  if (config.scope === "page" && (!config.sourceId || !config.page))
    throw new Error("page-missing");
  const blocked = flaggedIds(db, "exercise");
  // Smartbook exercises are tied to one topic's chapter, so only the topic scope mixes them in.
  const exercises =
    config.scope === "topic"
      ? topicExercises(db, input.topicId!).filter(
          (row) => row.answer?.trim() && !blocked.has(row.id),
        )
      : [];
  const questions: QuizQuestion[] = config.types.includes("open")
    ? exercises
        .slice(0, Math.floor(config.count / config.types.length))
        .map((row) => ({
          id: uuidv7(),
          sourceId: row.id,
          stem: row.prompt,
          explanation: row.answer!,
          grade: { kind: "open" as const, answer: "", reference: row.answer! },
        }))
    : [];
  const allPassages = (
    config.scope === "topic"
      ? db
          .prepare(
            `SELECT p.id, p.text FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id WHERE tp.topic_id = ? ORDER BY p.created_at, p.id`,
          )
          .all(input.topicId)
      : db
          .prepare(
            `SELECT DISTINCT p.id, p.text, p.created_at FROM topics t JOIN topic_passages tp ON tp.topic_id = t.id JOIN passages p ON p.id = tp.passage_id
             WHERE t.plan_id = ? AND t.archived_at IS NULL AND (? = 'plan' OR (p.source_id = ? AND json_extract(p.locator_json, '$.page') = ?))
             ORDER BY p.created_at, p.id`,
          )
          .all(
            input.planId,
            config.scope,
            config.sourceId ?? null,
            config.page ?? null,
          )
  ) as Array<{ id: string; text: string }>;
  // A page quiz without that page's text would silently turn into general knowledge.
  if (config.scope === "page" && !allPassages.length)
    throw new Error("page-empty");
  const count = Math.min(80, allPassages.length);
  const passages = Array.from(
    { length: count },
    (_, i) =>
      allPassages[
        Math.floor((i * (allPassages.length - 1)) / Math.max(1, count - 1))
      ]!,
  );
  const passageTopics: Record<string, string> = {};
  const memberships = db
    .prepare(
      "SELECT tp.passage_id,t.id FROM topic_passages tp JOIN topics t ON t.id=tp.topic_id WHERE t.plan_id=? AND t.archived_at IS NULL ORDER BY t.position,t.id",
    )
    .all(input.planId) as { passage_id: string; id: string }[];
  for (const membership of memberships)
    passageTopics[membership.passage_id] ??= membership.id;
  const plan = { language: planLanguage(db, input.planId) };
  const selection = selectionFor(db, "lesson");
  return {
    config,
    questions,
    passageTopics,
    passages: passages.map((row) => ({
      id: row.id,
      text: row.text.slice(0, 1000),
    })),
    language: plan.language,
    selection,
    grounding: allPassages.length ? "sources" : "general",
    interests: interestsLine(db) || undefined,
  };
}

export async function generateQuiz(
  snapshot: QuizSnapshot,
  run?: GenerateInput["run"],
  signal?: AbortSignal,
  onBatch?: () => void,
) {
  const { config, questions, passages, selection } = snapshot;
  const plan = { language: snapshot.language };
  const known = new Set(passages.map((row) => row.id));
  while (questions.length < config.count) {
    const batchCount = Math.min(10, config.count - questions.length);
    const kindCounts = new Map(
      config.types.map((kind) => [
        kind,
        questions.filter((question) => question.grade.kind === kind).length,
      ]),
    );
    const questionKinds = Array.from({ length: batchCount }, () => {
      const kind = [...config.types].sort(
        (a, b) => kindCounts.get(a)! - kindCounts.get(b)!,
      )[0]!;
      kindCounts.set(kind, kindCounts.get(kind)! + 1);
      return kind;
    });
    const schema = z
      .object({ questions: z.array(questionSchema).length(batchCount) })
      .superRefine((batch, ctx) => {
        const seen = new Set(
          questions.map((question) => question.stem.trim().toLowerCase()),
        );
        batch.questions.forEach((question, i) => {
          if (!config.types.includes(question.kind))
            ctx.addIssue({
              code: "custom",
              message: "Unselected question type",
              path: ["questions", i],
            });
          if (known.size && !question.passageIds.length)
            ctx.addIssue({
              code: "custom",
              message: "Grounded questions need passage IDs",
              path: ["questions", i],
            });
          if (question.passageIds.some((id) => !known.has(id)))
            ctx.addIssue({
              code: "custom",
              message: "Unknown passage ID",
              path: ["questions", i],
            });
          if (question.kind !== questionKinds[i])
            ctx.addIssue({
              code: "custom",
              message: "Wrong type for this batch position",
              path: ["questions", i],
            });
          if (
            question.kind === "mcq" &&
            new Set(
              question.options.map((option) => option.trim().toLowerCase()),
            ).size !== 4
          )
            ctx.addIssue({
              code: "custom",
              message: "Options must be distinct",
              path: ["questions", i],
            });
          if (
            question.kind === "matching" &&
            new Set(question.pairs.map((pair) => pair[0]!.trim().toLowerCase()))
              .size !== question.pairs.length
          )
            ctx.addIssue({
              code: "custom",
              message: "Matching labels must be distinct",
              path: ["questions", i],
            });
          if (
            question.kind === "completion" &&
            ([...question.stem.matchAll(/\{\{\d+\}\}/g)].length !== 1 ||
              !question.stem.includes("{{1}}"))
          )
            ctx.addIssue({
              code: "custom",
              message: "Completion must contain exactly one {{1}} blank",
              path: ["questions", i],
            });
          const key = question.stem.trim().toLowerCase();
          if (seen.has(key))
            ctx.addIssue({
              code: "custom",
              message: "Repeated question",
              path: ["questions", i],
            });
          seen.add(key);
        });
      });
    const result = await generate({
      selection,
      run,
      signal,
      schema,
      system: [
        systemPrompt("quiz.batch", {
          contentLanguage: languageName(plan.language),
        }),
        snapshot.interests,
      ]
        .filter(Boolean)
        .join("\n"),
      prompt: JSON.stringify({
        count: batchCount,
        types: config.types,
        questionKinds,
        passages: passages.map((row) => ({
          id: row.id,
          text: row.text.slice(0, 1000),
        })),
        previousQuestions: questions.map((question) => question.stem),
      }),
    });
    snapshot.provenance = { provider: result.provider, model: result.model };
    for (const row of (result.data as z.infer<typeof schema>).questions) {
      const base = {
        id: uuidv7(),
        generatedBy: { provider: result.provider, model: result.model },
        stem: row.stem,
        explanation: row.explanation,
        sourceIds: row.passageIds,
        topicId: row.passageIds
          .map((id) => snapshot.passageTopics?.[id])
          .find(Boolean),
      };
      if (row.kind === "mcq") {
        const indexed = row.options.map((option, i) => ({
          option,
          correct: i === row.correct,
        }));
        for (let i = indexed.length - 1; i > 0; i--) {
          const j = randomInt(i + 1);
          [indexed[i], indexed[j]] = [indexed[j]!, indexed[i]!];
        }
        questions.push({
          ...base,
          options: indexed.map((entry) => entry.option),
          grade: {
            kind: "mcq",
            picked: -1,
            correct: indexed.findIndex((entry) => entry.correct),
          },
        });
      } else if (row.kind === "tf")
        questions.push({
          ...base,
          grade: { kind: "tf", picked: false, correct: row.correct },
        });
      else if (row.kind === "completion")
        questions.push({
          ...base,
          grade: { kind: "completion", answers: [], accepted: [row.accepted] },
        });
      else if (row.kind === "open")
        questions.push({
          ...base,
          grade: {
            kind: "open",
            answer: "",
            reference: row.reference,
            rubric: row.rubric,
          },
        });
      else
        questions.push({
          ...base,
          left: row.pairs.map((pair) => pair[0]!),
          right: row.pairs.map((pair) => pair[1]!).reverse(),
          grade: {
            kind: "matching",
            pairs: [],
            correct: row.pairs.map((pair) => [pair[0]!, pair[1]!]),
          },
        });
    }
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    onBatch?.();
  }
}

export function saveQuizSnapshot(
  db: Database.Database,
  input: QuizInput,
  snapshot: QuizSnapshot,
  existingId?: string,
): string {
  return db.transaction(() => {
    const id = existingId ?? saveQuiz(db, input.planId, []);
    const body = {
      config: { ...snapshot.config, feedback: input.feedback ?? true },
      ...(snapshot.explanation ? { explanation: snapshot.explanation } : {}),
      complete: snapshot.questions.length === snapshot.config.count,
      questions: snapshot.questions.map(({ grade, ...question }) => ({
        ...question,
        answer: grade,
      })),
    };
    const models = [...new Map(snapshot.questions.flatMap((q) => q.generatedBy ? [[`${q.generatedBy.provider}:${q.generatedBy.model}`, q.generatedBy] as const] : [])).values()];
    const provenance = models.length === 1 ? models[0] : models.length > 1 ? undefined : snapshot.provenance;
    const updated = db
      .prepare(
        "UPDATE items SET topic_id = ?, body_json = ?, grounding = ?, engine_provider = ?, model_id = ?, model_source = ?, prompt_template = 'quiz.batch', prompt_version = ? WHERE id = ? AND plan_id = ?",
      )
      .run(
        snapshot.config.scope === "topic" ? (input.topicId ?? null) : null,
        JSON.stringify(body),
        snapshot.grounding,
        provenance?.provider ?? null,
        provenance?.model ?? null,
        provenance ? "reported" : null,
        templateVersion("quiz.batch"),
        id,
        input.planId,
      );
    if (!updated.changes) throw new Error("quiz-missing");
    for (const passage of snapshot.passages)
      db.prepare(
        "INSERT OR IGNORE INTO item_passages (item_id, passage_id) VALUES (?, ?)",
      ).run(id, passage.id);
    return id;
  })();
}

export async function startConfiguredQuiz(
  db: Database.Database,
  input: QuizInput,
  run?: GenerateInput["run"],
) {
  const snapshot = prepareQuiz(db, input);
  await generateQuiz(snapshot, run);
  return startAttempt(db, input.planId, saveQuizSnapshot(db, input, snapshot));
}
