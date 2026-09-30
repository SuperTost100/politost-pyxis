import type Database from "better-sqlite3";
import { readProfile, saveProfile, type Profile } from "./profile";

export function profileHandlers(db: Database.Database) {
  return {
    get() {
      return readProfile(db);
    },
    save(input: Partial<Profile>) {
      return saveProfile(db, input);
    },
  };
}
