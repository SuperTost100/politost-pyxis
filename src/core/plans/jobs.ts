import type Database from "better-sqlite3";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { IpcError } from "../../shared/ipc";
import { generate, type GenerateInput } from "../engine/generate";
import {
  planLanguage,
  promptProvenance,
  systemPrompt,
  templateVersion,
} from "../engine/prompts";
import { selectionFor, type StoredSelection } from "../engine/selection";
import type { Runner, StepContext } from "../jobs/runner";
import { createPlan, type BuildTopic } from "./create";
import { acrossTopics } from "../study/topicQuiz";
import { addSubject } from "./subjects";

export type PlanInput = Omit<
  Parameters<typeof createPlan>[1],
  "buildId" | "tree" | "signal"
>;
type Snapshot = {
  sourceId: string;
  documentId: string;
  kind: string;
  chapters?: Array<{ number: number; title: string }>;
};
type Params = {
  input: PlanInput;
  planId: string;
  selection: StoredSelection;
  snapshots?: Snapshot[];
  tree?: BuildTopic[];
  materialized?: boolean;
  introId?: string;
  diagnosticId?: string;
  synopses?: Record<string, string>;
};
type Passage = {
  id: string;
  source_id: string;
  text: string;
  section_path: string | null;
  locator_json: string;
};
const sectionKey = (sourceId: string, section: string) =>
  JSON.stringify([sourceId, section]);
const sectionOf = (p: Passage) => p.section_path ?? "Material";
const abort = (ctx: StepContext) => ctx.signal.throwIfAborted();
const topicSchema = z.object({
  topics: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        summary: z.string().min(1).max(1200),
        subtopics: z.array(z.string().min(1).max(160)).max(30),
        sourceSections: z
          .array(z.object({ sourceId: z.string(), section: z.string() }))
          .max(2000),
      }),
    )
    .min(1)
    .max(15),
});
const introSchema = z.object({ markdown: z.string().min(1).max(20000) });
const diagnosticSchema = z.object({
  questions: z
    .array(
      z.object({
        stem: z.string().min(1).max(1200),
        options: z.array(z.string().min(1).max(600)).length(4),
        correct: z.number().int().min(0).max(3),
        topicIndex: z.number().int().min(0),
        passageIds: z.array(z.string()).max(8),
        explanation: z.string().max(2000),
      }),
    )
    .min(10)
    .max(20),
});

function passages(db: Database.Database, params: Params): Passage[] {
  const select = db.prepare(
    "SELECT id, source_id, text, section_path, locator_json FROM passages WHERE document_id = ? ORDER BY created_at, id",
  );
  return (params.snapshots ?? []).flatMap(
    (snapshot) => select.all(snapshot.documentId) as Passage[],
  );
}
function paragraphTitles(rows: Passage[]): string[] {
  const titles = new Map<string, string>();
  for (const row of rows) {
    const locator = JSON.parse(row.locator_json) as { paragraph?: string };
    const id = locator.paragraph ?? row.id;
    if (!titles.has(id))
      titles.set(
        id,
        `${locator.paragraph ?? ""} ${row.text.split("\n")[0] ?? ""}`.trim(),
      );
  }
  return [...titles.values()];
}
function requirePlan(db: Database.Database, id: string): void {
  if (!db.prepare("SELECT id FROM plans WHERE id = ?").get(id))
    throw new IpcError("plan-missing", "errors.notAvailable");
}
function checkpoint(
  db: Database.Database,
  ctx: StepContext,
  params: Params,
  save: () => void,
): void {
  abort(ctx);
  requirePlan(db, params.planId);
  db.transaction(() => {
    save();
    ctx.setParams(params);
  })();
}
export function diagnosticTopics(tree: BuildTopic[]): number[] {
  const grounded = tree.some((topic) => topic.passageIds.length > 0);
  const eligible = tree.flatMap((topic, i) =>
    !grounded || topic.passageIds.length ? [i] : [],
  );
  if (eligible.length <= 20) return eligible;
  return Array.from(
    { length: 20 },
    (_, i) => eligible[Math.floor((i * (eligible.length - 1)) / 19)]!,
  );
}
function samplePassages(
  params: Params,
  rows: Passage[],
  indices?: number[],
): Passage[] {
  const topics = indices
    ? indices.map((i) => params.tree![i]!)
    : (params.tree ?? []);
  return acrossTopics(
    topics.map((topic) =>
      rows.filter((row) => topic.passageIds.includes(row.id)),
    ),
    40,
  );
}
function contentPrompt(
  params: Params,
  rows: Passage[],
  diagnosticTopicIndices?: number[],
): string {
  return JSON.stringify({
    title: params.input.title,
    subject: params.input.subject,
    language: params.input.language ?? "it",
    diagnosticTopicIndices,
    topics: params.tree?.map((topic, topicIndex) => ({
      topicIndex,
      title: topic.title,
      summary: topic.summary,
    })),
    passages: rows.slice(0, 40).map((row) => ({
      id: row.id,
      section: sectionOf(row),
      text: row.text.slice(0, 700),
    })),
  });
}
function saveItem(
  db: Database.Database,
  params: Params,
  kind: string,
  body: unknown,
  ids: string[],
  model: string,
  provider: string,
  prompt: { template: string; version: string },
): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO items (id, plan_id, kind, body_json, engine_provider, model_id, model_source, prompt_template, prompt_version, grounding, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'reported', ?, ?, ?, ?)`,
  ).run(
    id,
    params.planId,
    kind,
    JSON.stringify(body),
    provider,
    model,
    prompt.template,
    prompt.version,
    ids.length ? "sources" : "general",
    Date.now(),
  );
  const link = db.prepare(
    "INSERT OR IGNORE INTO item_passages (item_id, passage_id) VALUES (?, ?)",
  );
  for (const passageId of ids) link.run(id, passageId);
  return id;
}

export function registerPlanJobs(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
) {
  runner.register("plan-build", {
    retryParams: (params) => ({ ...(params as Params), selection: selectionFor(db, "plan") }),
    jobClass: "local",
    steps: [
      {
        name: "sources",
        jobClass: null,
        label: "wizard.stepSources",
        async run(ctx) {
          const params = ctx.params as Params;
          if (params.snapshots) return true;
          for (;;) {
            abort(ctx);
            requirePlan(db, params.planId);
            const states = params.input.sourceIds.map(
              (id) =>
                db
                  .prepare("SELECT id, kind, status FROM sources WHERE id = ?")
                  .get(id) as
                  { id: string; kind: string; status: string } | undefined,
            );
            if (
              states.some(
                (s) =>
                  !s ||
                  [
                    "failed",
                    "removed",
                    "cancelled",
                    "interrupted",
                    "needs-ocr",
                  ].includes(s.status),
              )
            )
              throw new IpcError("source-not-ready", "wizard.sourceNotReady");
            if (states.every((s) => s?.status === "ready")) break;
            await delay(100, undefined, { signal: ctx.signal });
          }
          params.snapshots = params.input.sourceIds.map((sourceId) => {
            const doc = db
              .prepare(
                `SELECT d.id, d.tree_json, s.kind FROM source_documents d JOIN sources s ON s.id = d.source_id WHERE d.source_id = ? ORDER BY d.version DESC LIMIT 1`,
              )
              .get(sourceId) as
              | { id: string; tree_json: string | null; kind: string }
              | undefined;
            if (!doc)
              throw new IpcError("source-not-ready", "wizard.sourceNotReady");
            const tree = doc.tree_json
              ? (JSON.parse(doc.tree_json) as {
                  chapters?: Snapshot["chapters"];
                })
              : {};
            return {
              sourceId,
              documentId: doc.id,
              kind: doc.kind,
              chapters: tree.chapters,
            };
          });
          checkpoint(db, ctx, params, () => undefined);
          return true;
        },
      },
      {
        name: "topics",
        jobClass: "model-cli",
        label: "wizard.stepTopics",
        async run(ctx) {
          const params = ctx.params as Params;
          if (params.tree) return true;
          const rows = passages(db, params);
          const book =
            params.snapshots?.length === 1 &&
            params.snapshots[0]?.kind === "smartbook"
              ? params.snapshots[0]
              : undefined;
          if (book?.chapters?.length) {
            params.tree = book.chapters.map((chapter) => {
              const chapterRows = rows.filter(
                (row) =>
                  (JSON.parse(row.locator_json) as { chapter?: number })
                    .chapter === chapter.number,
              );
              return {
                title: `${chapter.number}. ${chapter.title}`,
                summary: chapter.title,
                subtopics: paragraphTitles(chapterRows),
                passageIds: chapterRows.map((row) => row.id),
              };
            });
          } else {
            const sections = new Map<
              string,
              { sourceId: string; section: string; sample: string }
            >();
            for (const row of rows) {
              const key = sectionKey(row.source_id, sectionOf(row));
              if (!sections.has(key))
                sections.set(key, {
                  sourceId: row.source_id,
                  section: sectionOf(row),
                  sample: row.text.slice(0, 250),
                });
            }
            const known = new Set(sections.keys());
            const schema = topicSchema.superRefine((value, ctx) => {
              const covered = new Set<string>();
              value.topics.forEach((topic, i) =>
                topic.sourceSections.forEach((section, j) => {
                  const key = sectionKey(section.sourceId, section.section);
                  if (!known.has(key))
                    ctx.addIssue({
                      code: "custom",
                      message: "Unknown source section",
                      path: ["topics", i, "sourceSections", j],
                    });
                  covered.add(key);
                }),
              );
              for (const key of known)
                if (!covered.has(key))
                  ctx.addIssue({
                    code: "custom",
                    message: `Missing source section ${key}`,
                  });
              if (
                known.size &&
                value.topics.some((topic) => !topic.sourceSections.length)
              )
                ctx.addIssue({
                  code: "custom",
                  message: "Every grounded topic needs a source section",
                });
            });
            // Limit sampled text while retaining every section reference, including long PDFs.
            const outline = [...sections.values()];
            const sampleBudget = Math.max(
              1,
              Math.floor(48000 / Math.max(outline.length, 1)),
            );
            if (JSON.stringify(outline).length > 64000) {
              params.synopses ??= {};
              for (const snapshot of params.snapshots ?? []) {
                if (params.synopses[snapshot.documentId]) continue;
                const sourceRows = rows.filter(
                  (row) => row.source_id === snapshot.sourceId,
                );
                const count = Math.min(80, sourceRows.length);
                const sampled = Array.from(
                  { length: count },
                  (_, i) =>
                    sourceRows[
                      Math.floor(
                        (i * (sourceRows.length - 1)) / Math.max(count - 1, 1),
                      )
                    ]!,
                );
                const summary = await generate({
                  selection: params.selection,
                  signal: ctx.signal,
                  run,
                  schema: z.object({ synopsis: z.string().min(1).max(4000) }),
                  system: systemPrompt("plan.synopsis", {
                    contentLanguage: planLanguage(db, params.planId),
                  }),
                  prompt: JSON.stringify({
                    language: params.input.language ?? "it",
                    sourceId: snapshot.sourceId,
                    passages: sampled.map((row) => ({
                      section: sectionOf(row),
                      text: row.text.slice(0, 500),
                    })),
                  }),
                });
                params.synopses[snapshot.documentId] = (
                  summary.data as { synopsis: string }
                ).synopsis;
                checkpoint(db, ctx, params, () => undefined);
              }
            }
            const result = await generate({
              selection: params.selection,
              signal: ctx.signal,
              run,
              schema,
              system: systemPrompt("plan.topics", {
                contentLanguage: planLanguage(db, params.planId),
              }),
              prompt: JSON.stringify({
                title: params.input.title,
                subject: params.input.subject,
                language: params.input.language ?? "it",
                sourceSynopses: params.snapshots?.flatMap((snapshot) => {
                  const synopsis = params.synopses?.[snapshot.documentId];
                  return synopsis
                    ? [{ sourceId: snapshot.sourceId, synopsis }]
                    : [];
                }),
                sources: outline.map((section) => ({
                  ...section,
                  sample: section.sample.slice(0, sampleBudget),
                })),
              }),
            });
            const tree = result.data as z.infer<typeof topicSchema>;
            params.tree = tree.topics.map((topic) => {
              const sectionIds = new Set(
                topic.sourceSections.map((section) =>
                  sectionKey(section.sourceId, section.section),
                ),
              );
              return {
                title: topic.title,
                summary: topic.summary,
                subtopics: topic.subtopics,
                passageIds: rows
                  .filter((row) =>
                    sectionIds.has(sectionKey(row.source_id, sectionOf(row))),
                  )
                  .map((row) => row.id),
                provider: result.provider,
                model: result.model,
              };
            });
          }
          checkpoint(db, ctx, params, () => undefined);
          return true;
        },
      },
      {
        name: "path",
        label: "wizard.stepPath",
        async run(ctx) {
          const params = ctx.params as Params;
          if (params.materialized) return true;
          checkpoint(db, ctx, params, () => {
            createPlan(db, {
              ...params.input,
              buildId: params.planId,
              tree: params.tree,
              signal: ctx.signal,
            });
            db.prepare("UPDATE plans SET status = 'building' WHERE id = ?").run(
              params.planId,
            );
            params.materialized = true;
          });
          return true;
        },
      },
      {
        name: "intro",
        jobClass: "model-cli",
        label: "wizard.stepIntro",
        async run(ctx) {
          const params = ctx.params as Params;
          if (params.introId) return true;
          const rows = samplePassages(params, passages(db, params));
          const schema = introSchema.superRefine((value, ctx) => {
            for (const match of value.markdown.matchAll(/\[P(\d+)\]/g)) {
              const index = Number(match[1]);
              if (index < 1 || index > rows.length)
                ctx.addIssue({
                  code: "custom",
                  message: "Unknown introduction citation",
                });
            }
          });
          const result = await generate({
            selection: params.selection,
            signal: ctx.signal,
            run,
            schema,
            system: systemPrompt("plan.intro", {
              contentLanguage: planLanguage(db, params.planId),
            }),
            prompt: contentPrompt(params, rows),
          });
          checkpoint(db, ctx, params, () => {
            params.introId = saveItem(
              db,
              params,
              "intro",
              {
                ...(result.data as z.infer<typeof introSchema>),
                passageIds: rows.map((row) => row.id),
              },
              rows.map((row) => row.id),
              result.model,
              result.provider,
              promptProvenance("plan.intro"),
            );
          });
          return true;
        },
      },
      {
        name: "diagnostic",
        jobClass: "model-cli",
        label: "wizard.stepDiagnostic",
        async run(ctx) {
          const params = ctx.params as Params;
          if (params.diagnosticId) return true;
          const indices = diagnosticTopics(params.tree ?? []);
          const rows = samplePassages(params, passages(db, params), indices);
          const ids = new Set(rows.slice(0, 40).map((row) => row.id));
          const schema = diagnosticSchema.superRefine((value, ctx) => {
            const covered = new Set(value.questions.map((q) => q.topicIndex));
            for (const i of indices)
              if (!covered.has(i))
                ctx.addIssue({
                  code: "custom",
                  message: `Missing diagnostic question for topic ${i}`,
                });
            value.questions.forEach((q, i) => {
              if (!indices.includes(q.topicIndex))
                ctx.addIssue({
                  code: "custom",
                  message: "Unknown topic index",
                  path: ["questions", i, "topicIndex"],
                });
              if (
                q.passageIds.some(
                  (id) =>
                    !ids.has(id) ||
                    !params.tree?.[q.topicIndex]?.passageIds.includes(id),
                ) ||
                (ids.size > 0 && q.passageIds.length === 0)
              )
                ctx.addIssue({
                  code: "custom",
                  message: "Use supplied passage IDs",
                  path: ["questions", i, "passageIds"],
                });
            });
          });
          const result = await generate({
            selection: params.selection,
            signal: ctx.signal,
            run,
            schema,
            system: systemPrompt("plan.diagnostic", {
              contentLanguage: planLanguage(db, params.planId),
            }),
            prompt: contentPrompt(params, rows, indices),
          });
          const data = result.data as z.infer<typeof diagnosticSchema>;
          checkpoint(db, ctx, params, () => {
            const topics = db
              .prepare(
                "SELECT id FROM topics WHERE plan_id = ? ORDER BY position",
              )
              .all(params.planId) as Array<{ id: string }>;
            const questions = data.questions.map((q) => ({
              id: uuidv7(),
              stem: q.stem,
              options: q.options,
              explanation: q.explanation,
              topicId: topics[q.topicIndex]!.id,
              sourceIds: q.passageIds,
              answer: { kind: "mcq", picked: -1, correct: q.correct },
            }));
            params.diagnosticId = saveItem(
              db,
              params,
              "diagnostic",
              { questions },
              [...new Set(data.questions.flatMap((q) => q.passageIds))],
              result.model,
              result.provider,
              promptProvenance("plan.diagnostic"),
            );
          });
          return true;
        },
      },
      {
        name: "ready",
        label: "wizard.stepReady",
        async run(ctx) {
          const params = ctx.params as Params;
          checkpoint(db, ctx, params, () =>
            db
              .prepare(
                "UPDATE plans SET status = 'ready', engine_provider = ?, model_id = ?, model_source = 'selected', prompt_template = ?, prompt_version = ?, updated_at = ? WHERE id = ?",
              )
              .run(
                params.selection.provider,
                params.selection.model,
                // A model-written topic tree is the plan's generated structure; smartbook chapters are not.
                params.tree?.some((topic) => topic.provider)
                  ? "plan.topics"
                  : null,
                params.tree?.some((topic) => topic.provider)
                  ? templateVersion("plan.topics")
                  : null,
                Date.now(),
                params.planId,
              ),
          );
          return { planId: params.planId };
        },
      },
    ],
  });
}

export function enqueuePlan(
  db: Database.Database,
  runner: Runner,
  input: PlanInput,
) {
  const planId = uuidv7();
  const selection = selectionFor(db, "plan");
  const jobId = db.transaction(() => {
    const subjectId = input.subject?.trim()
      ? addSubject(db, input.subject).id
      : null;
    db.prepare(
      `INSERT INTO plans (id, title, status, subject_id, content_language, exam_at, target, style, created_at, updated_at) VALUES (?, ?, 'building', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      planId,
      input.title,
      subjectId,
      input.language ?? "it",
      input.examAt ?? null,
      input.target ?? 0.75,
      input.style ?? "decide",
      Date.now(),
      Date.now(),
    );
    for (const sourceId of new Set(input.sourceIds))
      db.prepare(
        "INSERT INTO plan_sources (plan_id, source_id) VALUES (?, ?)",
      ).run(planId, sourceId);
    return runner.start("plan-build", {
      planId,
      input,
      selection,
    } satisfies Params);
  })();
  return { planId, jobId, topics: 0, pathNodes: 0 };
}

export function planBuildState(db: Database.Database, planId: string) {
  const row = db
    .prepare(
      "SELECT id, state, progress, step_label, error FROM jobs WHERE kind = 'plan-build' AND json_extract(params_json, '$.planId') = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(planId) as
    | {
        id: string;
        state: string;
        progress: number;
        step_label: string | null;
        error: string | null;
      }
    | undefined;
  return row
    ? {
        jobId: row.id,
        state: row.state,
        progress: row.progress,
        stepLabel: row.step_label,
        error: row.error,
        steps: db
          .prepare(
            "SELECT name, label, state FROM job_steps WHERE job_id = ? ORDER BY position",
          )
          .all(row.id) as Array<{
          name: string;
          label: string;
          state: "pending" | "running" | "succeeded" | "failed";
        }>,
      }
    : null;
}
