import type Database from "better-sqlite3";
import { completeNode, createPlan, deletePlan, listPlans, listSubjects, nextLesson, readPlan, rebuildPlan } from "./create";
import { exportPlan, importPlan } from "./file";
import { planMastery, planSeries } from "./progress";
import { planDiskUsage } from "../share/usage";
import { listSimulations } from "../study/simulation";
import type { PlanFile } from "../../shared/plan-file";

export function planHandlers(db: Database.Database, workspace = "") {
  return {
    list() {
      return listPlans(db);
    },
    subjects() {
      return listSubjects(db);
    },
    usage() {
      return planDiskUsage(db, workspace);
    },
    create(input: Parameters<typeof createPlan>[1], signal?: AbortSignal) {
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
