import {
  attachPlanSources,
  removePlanSource,
  readPlanItem,
  openPlanQuiz,
} from "./views";
import { savePlanSettings, setPlanArchived } from "./settings";
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
import { addSubject, reorderSubjects, removeSubject, renameSubject } from "./subjects";
import { recordStep } from "./steps";
import type { StepResult } from "./path";
import { stripPassageRefs } from "../../shared/smart-text";
import { smartAnswers } from "../study/smartText";
import type Database from "better-sqlite3";
import {
  createPlan,
  deletePlan,
  listPlans,
  listSubjects,
  planGuide,
  readPlan,
} from "./create";
import { proposeModules, proposeTree } from "./guided";
import { withLibraryOriginals } from "./libraryOriginals";
import { exportPlan, importPlan } from "./file";
import { queueSyllabusChecks } from "../sources/syllabus";
import { readProfile } from "../profile/profile";
import { planMastery, planMasteryBreakdown, planSeries } from "./progress";
import { freeUpSpace, planDiskUsage } from "../share/usage";
import {
  chatListedSources,
  deleteHiddenSources,
  deleteLoosePassages,
  removeUnreferencedBlobs,
} from "../chat/delete";
import { dueEverywhere, savePlannerHours, sessionPlan, todayPlan } from "./planner";
import { exportCalendar } from "../share/calendar";
import { listSimulations } from "../study/simulation";
import { AUTHOR_MAX, type PlanFile } from "../../shared/plan-file";

/** The profile name as a plan file carries it: trimmed, and cut to the file's limit without splitting a character. */
function fileAuthor(name: string): string {
  let author = name.trim().slice(0, AUTHOR_MAX);
  if (/[\ud800-\udbff]$/.test(author)) author = author.slice(0, -1);
  return author.trim();
}

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
    calendar(input: Parameters<typeof exportCalendar>[1]) {
      return exportCalendar(db, input);
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
    renameSubject(input: { id: string; name: string }) {
      return renameSubject(db, input.id, input.name);
    },
    removeSubject(input: { id: string }) {
      removeSubject(db, input.id);
      return { ok: true as const };
    },
    usage() {
      return planDiskUsage(db, workspace);
    },
    freeSpace() {
      return freeUpSpace(db, workspace);
    },
    build(input: { planId: string }) {
      return planBuildState(db, input.planId);
    },
    intro(input: { planId: string }) {
      const row = db
        .prepare(
          "SELECT id, body_json FROM items WHERE plan_id = ? AND kind = 'intro' ORDER BY created_at DESC LIMIT 1",
        )
        .get(input.planId) as { id: string; body_json: string } | undefined;
      if (!row) return null;
      const body = JSON.parse(row.body_json) as {
        markdown: string;
        passageIds?: string[];
      };
      // Older introductions cite passages as [P3] or raw ids; the page never shows them.
      return {
        itemId: row.id,
        markdown: stripPassageRefs(body.markdown),
        passageIds: body.passageIds ?? [],
        answers: smartAnswers(db, row.id),
      };
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
    archive(input: { planId: string; archived: boolean }) {
      return setPlanArchived(db, input.planId, input.archived);
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
          "SELECT id FROM jobs WHERE (kind IN ('quiz-build', 'map-build', 'exercise-build') AND json_extract(params_json, '$.input.planId') = ?) OR (kind IN ('simulation-grade', 'simulation-build', 'cards-build', 'gap-drill', 'gap-insight', 'exercise-build', 'quiz-replace') AND json_extract(params_json, '$.planId') = ?) OR (kind IN ('quiz-grade', 'quiz-check') AND json_extract(params_json, '$.attemptId') IN (SELECT id FROM attempts WHERE plan_id = ?))",
        )
        .all(input.planId, input.planId, input.planId) as Array<{ id: string }>;
      for (const quizJob of quizJobs) runner?.cancel(quizJob.id);
      db.prepare(
        "DELETE FROM jobs WHERE (kind IN ('quiz-build', 'map-build', 'exercise-build') AND json_extract(params_json, '$.input.planId') = ?) OR (kind IN ('simulation-grade', 'simulation-build', 'cards-build', 'gap-drill', 'gap-insight', 'exercise-build', 'quiz-replace') AND json_extract(params_json, '$.planId') = ?) OR (kind IN ('quiz-grade', 'quiz-check') AND json_extract(params_json, '$.attemptId') IN (SELECT id FROM attempts WHERE plan_id = ?))",
      ).run(input.planId, input.planId, input.planId);
      const hashes = db.transaction(() => {
        // What a plan file import brought: hidden copies of the originals, and quotes of skipped ones with no source.
        // Read before the plan's rows go; whatever else still uses one keeps it.
        const cited = `SELECT passage_id FROM topic_passages WHERE topic_id IN (SELECT id FROM topics WHERE plan_id = @plan)
          UNION SELECT passage_id FROM item_passages WHERE item_id IN (SELECT id FROM items WHERE plan_id = @plan)
          UNION SELECT passage_id FROM cards WHERE plan_id = @plan`;
        const sources = db
          .prepare(
            `SELECT source_id FROM plan_sources WHERE plan_id = @plan
             UNION SELECT source_id FROM passages WHERE id IN (${cited}) AND source_id IS NOT NULL`,
          )
          .pluck()
          .all({ plan: input.planId }) as string[];
        // Exercises written for this plan's topics, and book exercises an import tied to it because their book was
        // skipped, belong to no book, so nothing else would ever remove them.
        const owned = `SELECT id FROM exercises WHERE smartbook_id IS NULL
          AND (json_extract(locator_json, '$.topicId') IN (SELECT id FROM topics WHERE plan_id = @plan)
            OR json_extract(locator_json, '$.planId') = @plan)`;
        const loose = db
          .prepare(
            `SELECT id FROM passages WHERE source_id IS NULL
             AND (id IN (${cited}) OR id IN (SELECT passage_id FROM exercises WHERE id IN (${owned})))`,
          )
          .pluck()
          .all({ plan: input.planId }) as string[];
        db.prepare(
          `DELETE FROM flags WHERE target_kind = 'exercise' AND target_id IN (${owned})`,
        ).run({ plan: input.planId });
        db.prepare(`DELETE FROM exercises WHERE id IN (${owned})`).run({ plan: input.planId });
        deletePlan(db, input.planId);
        db.prepare("DELETE FROM settings WHERE key IN (?,?,?)").run(
          `plan-material:${input.planId}`,
          `plan-import:${input.planId}`,
          educationKey(input.planId),
        );
        const listed = chatListedSources(db);
        deleteLoosePassages(db, loose);
        // An imported smartbook's book row came with the import, so it goes too.
        return deleteHiddenSources(
          db,
          sources.filter((id) => !listed.has(id)),
          { books: true },
        );
      })();
      removeUnreferencedBlobs(db, workspace, hashes);
      return { ok: true };
    },
    export(input: {
      planId: string;
      progress?: boolean;
      embed?: boolean;
      author?: boolean;
    }) {
      const author =
        input.author === false ? "" : fileAuthor(readProfile(db)?.displayName ?? "");
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
    masteryBreakdown(input: { planId: string }) {
      return planMasteryBreakdown(db, input.planId);
    },
    series(input: { planId: string }) {
      return planSeries(db, input.planId);
    },
    simulations(input: { planId: string }) {
      return listSimulations(db, input.planId);
    },
    recommend(input: { planId: string }) {
      return planGuide(db, input.planId);
    },
    today() {
      return todayPlan(db);
    },
    planner() {
      return sessionPlan(db);
    },
    plannerHours(input: { week?: string; hours: number | null }) {
      return savePlannerHours(db, input);
    },
    dueEverywhere() {
      return dueEverywhere(db);
    },
    complete(input: {
      planId: string;
      activity: "intro" | "lesson" | "practice" | "cards";
      topicId: string | null;
      result?: StepResult;
    }) {
      recordStep(db, input.planId, input);
      return { ok: true };
    },
  };
}
