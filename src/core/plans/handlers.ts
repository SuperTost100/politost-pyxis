import type Database from "better-sqlite3";
import { completeNode, createPlan, deletePlan, listPlans, readPlan } from "./create";
import { exportPlan, importPlan } from "./file";
import { planMastery } from "./progress";
import type { PlanFile } from "../../shared/plan-file";

export function planHandlers(db: Database.Database) {
  return {
    list() {
      return listPlans(db);
    },
    create(input: { title: string; sourceIds: string[] }) {
      return createPlan(db, input);
    },
    read(input: { planId: string }) {
      return readPlan(db, input.planId);
    },
    delete(input: { planId: string }) {
      deletePlan(db, input.planId);
      return { ok: true };
    },
    export(input: { planId: string }) {
      return exportPlan(db, input.planId);
    },
    import(input: PlanFile) {
      return { planId: importPlan(db, input) };
    },
    mastery(input: { planId: string }) {
      return planMastery(db, input.planId);
    },
    complete(input: { planId: string; nodeId: string }) {
      completeNode(db, input.planId, input.nodeId);
      return { ok: true };
    },
  };
}
