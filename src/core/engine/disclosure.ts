import type Database from "better-sqlite3";
import { putSetting } from "../settings";
import { tierData } from "./tiers";

/** Thrown, never awaited on: a task does not wait for the student to read a notice. */
export const DISCLOSURE_REQUIRED = "engine-disclosure-required";

/**
 * The notice the student confirms. Version 1 (stored as `true`) named the text, the passages and the attachments.
 * Version 2 adds the student's own results (quiz grades and the state of each topic of the exam asked about), which
 * the chat's `read_progress` tool sends. A tool confirmed at version 1 goes on working, without that tool, until the
 * student confirms the new notice.
 */
export const DISCLOSURE_VERSION = 2;

const key = (provider: string) => `engine-disclosure:${provider}`;

/**
 * A provider must be acknowledged before a model receives workspace content. The notice is shown at setup, in
 * Settings, or once at launch, never during a task, so a task that reaches an unacknowledged provider fails at once.
 */
export function createDisclosure(db: Database.Database) {
  /** The version of the notice confirmed for the provider, 0 for none. */
  const version = (provider: string): number => {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key(provider)) as { value_json: string } | undefined;
    if (!row) return 0;
    try {
      const value = JSON.parse(row.value_json) as unknown;
      return value === true ? 1 : typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  };
  const isAcknowledged = (provider: string) => version(provider) >= 1;
  return {
    isAcknowledged,
    /**
     * The student confirmed the notice as it is now. The model on this computer sends nothing anywhere, so it needs no
     * such confirmation: its download consent covers it.
     */
    isCurrent: (provider: string) => provider === tierData.local.provider || version(provider) >= DISCLOSURE_VERSION,
    acknowledge(providers: readonly string[]) {
      const now = Date.now();
      db.transaction(() => {
        for (const provider of providers) putSetting(db, key(provider), DISCLOSURE_VERSION, now);
      })();
    },
    ensure(provider: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (!isAcknowledged(provider)) throw new Error(DISCLOSURE_REQUIRED);
    },
  };
}
