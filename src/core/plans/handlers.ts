import { enqueuePlan, planBuildState, registerPlanJobs } from "./jobs";
import type { Runner } from "../jobs/runner";
import type { GenerateInput } from "../engine/generate";
import { addSubject, reorderSubjects, removeSubject } from "./subjects";
import type Database from "better-sqlite3";
import {
  completeNode,
  createPlan,
  deletePlan,
  listPlans,
  listSubjects,
  nextLesson,
  readPlan,
  rebuildPlan,
} from "./create";
import { exportPlan, importPlan } from "./file";
import { planMastery, planSeries } from "./progress";
import { planDiskUsage } from "../share/usage";
import { listSimulations } from "../study/simulation";
import type { PlanFile } from "../../shared/plan-file";

export function planHandlers(
  db: Database.Database,
  workspace = "",
  runner?: Runner,
  run?: GenerateInput["run"],
) {
  if (runner) registerPlanJobs(db, runner, run);
  return {
    list() {
      return listPlans(db);
    },
    subjects() {
      return listSubjects(db);
    },
    addSubject(input: { name: string }) {
      return addSubject(db, input.name);
    },
    reorderSubjects(input: { ids: string[] }) {
      reorderSubjects(db, input.ids);
      return { ok: true as const };
    },
    removeSubject(input: { id: string }) {
      removeSubject(db, input.id);
      return { ok: true as const };
    },
    usage() {
      return planDiskUsage(db, workspace);
    },
    build(input: { planId: string }) {
      return planBuildState(db, input.planId);
    },
    intro(input: { planId: string }) {
      const row = db
        .prepare(
          "SELECT body_json FROM items WHERE plan_id = ? AND kind = 'intro' ORDER BY created_at DESC LIMIT 1",
        )
        .get(input.planId) as { body_json: string } | undefined;
      return row
        ? (JSON.parse(row.body_json) as {
            markdown: string;
            passageIds: string[];
          })
        : null;
    },
    create(input: Parameters<typeof createPlan>[1], signal?: AbortSignal) {
      if (runner) return enqueuePlan(db, runner, input);
      return (async () => {
        for (let step = 0; step <= input.sourceIds.length; step += 1) {
          await new Promise((resolve) => setImmediate(resolve));
          if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        }
        return createPlan(db, { ...input, signal });
      })();
    },
    rebuild(input: { planId: string; sourceIds: string[] }) {
      return rebuildPlan(db, input.planId, input.sourceIds);
    },
    read(input: { planId: string }) {
      return readPlan(db, input.planId);
    },
    delete(input: { planId: string }) {
      const job = planBuildState(db, input.planId);
      if (job) runner?.cancel(job.jobId);
      db.prepare(
        "DELETE FROM jobs WHERE kind = 'plan-build' AND json_extract(params_json, '$.planId') = ?",
      ).run(input.planId);
      const quizJobs = db
        .prepare(
          "SELECT id FROM jobs WHERE kind = 'quiz-build' AND json_extract(params_json, '$.input.planId') = ?",
        )
        .all(input.planId) as Array<{ id: string }>;
      for (const quizJob of quizJobs) runner?.cancel(quizJob.id);
      db.prepare(
        "DELETE FROM jobs WHERE kind = 'quiz-build' AND json_extract(params_json, '$.input.planId') = ?",
      ).run(input.planId);
      deletePlan(db, input.planId);
      return { ok: true };
    },
    export(input: { planId: string; progress?: boolean; embed?: boolean }) {
      return exportPlan(db, input.planId, {
        progress: input.progress === true,
        embed: input.embed === true,
        workspace,
      });
    },
    import(input: PlanFile) {
      return { planId: importPlan(db, input, Date.now(), workspace) };
    },
    mastery(input: { planId: string }) {
      return planMastery(db, input.planId);
    },
    series(input: { planId: string }) {
      return planSeries(db, input.planId);
    },
    simulations(input: { planId: string }) {
      return listSimulations(db, input.planId);
    },
    recommend(input: { planId: string }) {
      return nextLesson(db, input.planId);
    },
    complete(input: { planId: string; nodeId: string }) {
      completeNode(db, input.planId, input.nodeId);
      return { ok: true };
    },
  };
}
