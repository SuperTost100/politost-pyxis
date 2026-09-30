import type Database from "better-sqlite3";
import { completeNode, createPlan, listPlans, readPlan } from "./create";
import { planMastery } from "./progress";

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
    mastery(input: { planId: string }) {
      return planMastery(db, input.planId);
    },
    complete(input: { planId: string; nodeId: string }) {
      completeNode(db, input.planId, input.nodeId);
      return { ok: true };
    },
  };
}
