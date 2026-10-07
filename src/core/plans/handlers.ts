import {
  attachPlanSources,
  removePlanSource,
  readPlanItem,
  openPlanQuiz,
} from "./views";
import { savePlanSettings } from "./settings";
import {
  applyStoredRebuild,
  enqueuePlan,
  planBuildState,
  rebuildState,
  registerPlanJobs,
  startRebuild,
} from "./jobs";
import { educationKey, planEducation, setPlanEducation } from "./education";
import type { EducationLevel } from "../profile/profile";
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
} from "./create";
import { proposeModules, proposeTree } from "./guided";
import { withLibraryOriginals } from "./libraryOriginals";
import { exportPlan, importPlan } from "./file";
import { queueSyllabusChecks } from "../sources/syllabus";
import { readProfile } from "../profile/profile";
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
  // SRC-08: what a plan edit changes is what the stored source comparison depends on, so it is queued again, once.
  const recheck = <T>(planId: string, result: T): T => {
    if (runner) queueSyllabusChecks(db, runner, planId);
    return result;
  };
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
    proposeModules(
      input: Parameters<typeof proposeModules>[1],
      signal?: AbortSignal,
    ) {
      return proposeModules(db, input, signal, run);
    },
    proposeTree(
      input: Parameters<typeof proposeTree>[1],
      signal?: AbortSignal,
    ) {
      return proposeTree(db, input, signal, run);
    },
    rebuildState(input: { planId: string }) {
      return rebuildState(db, input.planId);
    },
    rebuildStart(input: { planId: string }) {
      if (!runner) throw new Error("rebuild-unavailable");
      return startRebuild(db, runner, input.planId);
    },
    rebuildApply(input: { planId: string; jobId: string }) {
      return recheck(input.planId, applyStoredRebuild(db, input.planId, input.jobId));
    },
    rebuildDiscard(input: { planId: string }) {
      const job = rebuildState(db, input.planId);
      if (job) {
        runner?.cancel(job.jobId);
        db.prepare("DELETE FROM jobs WHERE id = ?").run(job.jobId);
      }
      return { ok: true as const };
    },
    education(input: { planId: string }) {
      return { level: planEducation(db, input.planId) };
    },
    setEducation(input: { planId: string; level: EducationLevel }) {
      return { level: setPlanEducation(db, input.planId, input.level) };
    },
    settings(input: Parameters<typeof savePlanSettings>[1]) {
      return recheck(input.planId, savePlanSettings(db, input));
    },
    attachSources(input: { planId: string; sourceIds: string[] }) {
      return recheck(input.planId, attachPlanSources(db, input.planId, input.sourceIds));
    },
    removeSource(input: { planId: string; sourceId: string }) {
      return recheck(input.planId, removePlanSource(db, input.planId, input.sourceId));
    },
    item(input: { planId: string; itemId: string }) {
      return readPlanItem(db, input.planId, input.itemId);
    },
    openQuiz(input: { planId: string; itemId: string }) {
      return openPlanQuiz(db, input.planId, input.itemId);
    },
    read(input: { planId: string }) {
      return readPlan(db, input.planId);
    },
    delete(input: { planId: string }) {
      const job = planBuildState(db, input.planId);
      if (job) runner?.cancel(job.jobId);
      const rebuild = rebuildState(db, input.planId);
      if (rebuild) runner?.cancel(rebuild.jobId);
      db.prepare(
        "DELETE FROM jobs WHERE kind IN ('plan-build', 'plan-rebuild') AND json_extract(params_json, '$.planId') = ?",
      ).run(input.planId);
      const quizJobs = db
        .prepare(
          "SELECT id FROM jobs WHERE (kind IN ('quiz-build', 'map-build', 'exercise-build') AND json_extract(params_json, '$.input.planId') = ?) OR (kind IN ('simulation-grade', 'simulation-build', 'cards-build', 'gap-drill', 'exercise-build', 'quiz-replace') AND json_extract(params_json, '$.planId') = ?) OR (kind IN ('quiz-grade', 'quiz-check') AND json_extract(params_json, '$.attemptId') IN (SELECT id FROM attempts WHERE plan_id = ?))",
        )
        .all(input.planId, input.planId, input.planId) as Array<{ id: string }>;
      for (const quizJob of quizJobs) runner?.cancel(quizJob.id);
      db.prepare(
        "DELETE FROM jobs WHERE (kind IN ('quiz-build', 'map-build', 'exercise-build') AND json_extract(params_json, '$.input.planId') = ?) OR (kind IN ('simulation-grade', 'simulation-build', 'cards-build', 'gap-drill', 'exercise-build', 'quiz-replace') AND json_extract(params_json, '$.planId') = ?) OR (kind IN ('quiz-grade', 'quiz-check') AND json_extract(params_json, '$.attemptId') IN (SELECT id FROM attempts WHERE plan_id = ?))",
      ).run(input.planId, input.planId, input.planId);
      deletePlan(db, input.planId);
      db.prepare("DELETE FROM settings WHERE key IN (?,?,?)").run(
        `plan-material:${input.planId}`,
        `plan-import:${input.planId}`,
        educationKey(input.planId),
      );
      return { ok: true };
    },
    export(input: {
      planId: string;
      progress?: boolean;
      embed?: boolean;
      author?: boolean;
    }) {
      const author =
        input.author === false ? "" : readProfile(db)?.displayName.trim();
      return exportPlan(db, input.planId, {
        progress: input.progress === true,
        embed: input.embed === true,
        ...(author ? { author } : {}),
        workspace,
      });
    },
    import(input: PlanFile & { libraryFor?: Record<string, string> }) {
      const planId = importPlan(
        db,
        withLibraryOriginals(db, workspace, input),
        Date.now(),
        workspace,
      );
      return recheck(planId, { planId });
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
