import type Database from "better-sqlite3";
import { readProfile, saveProfile, type Profile } from "./profile";

/** `onSaved` runs after every save; core uses it to tell main the crash-report switch (src/main/crash-reports.ts). */
export function profileHandlers(db: Database.Database, onSaved?: (profile: Profile) => void) {
  return {
    get() {
      return readProfile(db);
    },
    save(input: Partial<Profile>) {
      const saved = saveProfile(db, input);
      onSaved?.(saved);
      return saved;
    },
  };
}
