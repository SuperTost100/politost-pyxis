import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";

/** The tool session a chat continues. One Pyxis chat is one chat in the student's Claude, ChatGPT, Cursor or Gemini history. */
export type StoredSession = {
  /** The row's own id. */
  id: string;
  provider: string;
  /** The tool's id for the session, which `cli-funnel` resumes by. */
  sessionId: string;
  /** The folder the tool keyed the session by. A session resumes only from the same folder. */
  cwd: string;
  /** The hash of the context block the session last received, see `contextHash`. */
  told: string | null;
  /** Characters sent into the session so far. */
  chars: number;
};

type Row = {
  id: string;
  provider: string;
  session_id: string;
  cwd: string;
  told: string | null;
  chars: number;
};

/**
 * Tools that keep no compaction of their own that Pyxis has seen. Claude Code and Codex compact a long session by
 * themselves; for these two the session starts over, with the conversation handed across again, once this many
 * characters (about 100,000 tokens, under the smallest window the two offer) have gone into it.
 * shortcut: a fixed size, since neither tool reports how full its context is; replace it when cli-funnel reports that.
 */
export const UNCOMPACTED_SESSION_CHARS = 400_000;
const UNCOMPACTED = new Set(["agent", "antigravity"]);

/** The chat's open session, if any. */
export function currentSession(db: Database.Database, chatId: string): StoredSession | undefined {
  const row = db
    .prepare(
      `SELECT id, provider, session_id, cwd, told, chars FROM chat_sessions
       WHERE chat_id = ? AND ended_at IS NULL ORDER BY opened_at DESC, rowid DESC LIMIT 1`,
    )
    .get(chatId) as Row | undefined;
  return row && { id: row.id, provider: row.provider, sessionId: row.session_id, cwd: row.cwd, told: row.told, chars: row.chars };
}

/** True when a session of this tool has grown past what the tool is known to handle on its own. */
export function sessionTooLong(session: StoredSession): boolean {
  return UNCOMPACTED.has(session.provider) && session.chars >= UNCOMPACTED_SESSION_CHARS;
}

/** What a turn leaves in the session: the engine that answered, the context block it was told and what it sent. */
export type SessionTurn = {
  provider: string;
  sessionId: string;
  cwd: string;
  model: string;
  effort: string | null;
  told: string;
  chars: number;
  now: number;
};

/**
 * Records a finished turn. The session the turn continued is updated; one the turn did not continue (another tool
 * answered, or the tool started a new session) ends with the reason, and the new one is opened.
 */
export function recordSession(
  db: Database.Database,
  chatId: string,
  prior: StoredSession | undefined,
  turn: SessionTurn,
  reason: "tool" | "gone" | "long" = "gone",
): void {
  if (prior && prior.provider === turn.provider && prior.sessionId === turn.sessionId) {
    db.prepare(
      `UPDATE chat_sessions SET model = ?, effort = ?, told = ?, chars = chars + ?, turns = turns + 1, last_used_at = ?
       WHERE id = ?`,
    ).run(turn.model, turn.effort, turn.told, turn.chars, turn.now, prior.id);
    return;
  }
  if (prior)
    db.prepare(`UPDATE chat_sessions SET ended_at = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL`).run(
      turn.now,
      prior.provider !== turn.provider ? "tool" : reason,
      prior.id,
    );
  db.prepare(
    `INSERT INTO chat_sessions
      (id, chat_id, provider, session_id, model, effort, cwd, told, chars, turns, opened_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    uuidv7(turn.now),
    chatId,
    turn.provider,
    turn.sessionId,
    turn.model,
    turn.effort,
    turn.cwd,
    turn.told,
    turn.chars,
    turn.now,
    turn.now,
  );
}

/** Ends the chat's open session without opening another, when a turn on an engine with no stored session answered. */
export function endSession(db: Database.Database, chatId: string, now: number, reason: "tool" | "gone" | "long"): void {
  db.prepare(`UPDATE chat_sessions SET ended_at = ?, ended_reason = ? WHERE chat_id = ? AND ended_at IS NULL`).run(
    now,
    reason,
    chatId,
  );
}

/** How many tool sessions the chat has opened, the ended ones included. */
export function sessionsOpened(db: Database.Database, chatId: string): number {
  return (db.prepare(`SELECT COUNT(*) FROM chat_sessions WHERE chat_id = ?`).pluck().get(chatId) as number) ?? 0;
}

/** A short fingerprint of the context block, so a session is told it again only when it changed. */
export function contextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
