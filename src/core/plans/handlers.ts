import type Database from "better-sqlite3";
import { createPlan, listPlans, readPlan } from "./create";

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
  };
}
