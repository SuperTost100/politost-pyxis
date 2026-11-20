import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";

/**
 * The tool session an owner continues. An owner is a chat (its id), a topic's lesson (`lesson:<topic id>`) or a quiz
 * hand-in (`quiz:<attempt id>`). One Pyxis chat, lesson or hand-in is one chat in the student's Claude, ChatGPT, Cursor
 * or Gemini history, whatever number of turns it takes.
 */
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
  /** The hash of the system prompt the session was opened under (null: opened before it was kept). */
  instructions: string | null;
  /** Characters sent into the session so far. */
  chars: number;
  /** True after a turn that completed normally on this session, false from the start of any turn until one does. */
  inStep: boolean;
  /**
   * What the session holds in full. For a chat the last message: a session out of step is told what the student sees
   * after it, and null means from the start. For a lesson a fingerprint of the lesson as the session last saw it.
   */
  syncedTo: string | null;
  /** Cursor's own folder was seen to hold this chat, so its absence now means the student cleared it. */
  seen: boolean;
};

type Row = {
  id: string;
  provider: string;
  session_id: string;
  cwd: string;
  told: string | null;
  instructions: string | null;
  chars: number;
  in_step: number;
  synced_to: string | null;
  seen: number;
};

/**
 * Tools that keep no compaction of their own that Pyxis has seen. Claude Code, Codex and Antigravity compact a long
 * session by themselves (agy's program has a trajectory compaction with its own trigger, checked in the binary, though
 * no session was run to its limit); for Cursor Agent the session starts over, with the conversation handed across
 * again, once this many characters (about 100,000 tokens, under the smallest window it offers) have gone into it.
 * shortcut: a fixed size, since the tool does not report how full its context is; replace it when cli-funnel reports that.
 */
export const UNCOMPACTED_SESSION_CHARS = 400_000;
const UNCOMPACTED = new Set(["agent"]);

/** The owner's open session, if any. */
export function currentSession(db: Database.Database, owner: string): StoredSession | undefined {
  const row = db
    .prepare(
      `SELECT id, provider, session_id, cwd, told, instructions, chars, in_step, synced_to, seen FROM tool_sessions
       WHERE owner = ? AND ended_at IS NULL ORDER BY opened_at DESC, rowid DESC LIMIT 1`,
    )
    .get(owner) as Row | undefined;
  return row && { id: row.id, provider: row.provider, sessionId: row.session_id, cwd: row.cwd, told: row.told, instructions: row.instructions, chars: row.chars, inStep: row.in_step === 1, syncedTo: row.synced_to, seen: row.seen === 1 };
}

/** True when a session of this tool has grown past what the tool is known to handle on its own. */
export function sessionTooLong(session: StoredSession): boolean {
  return UNCOMPACTED.has(session.provider) && session.chars >= UNCOMPACTED_SESSION_CHARS;
}

/**
 * What a turn leaves in the session: the engine that answered, the context block it was told and what it sent.
 *
 * A session is in step when it holds the conversation the student sees. A turn marks the chat's open sessions out of
 * step when it starts (`markOutOfStep`), and only `keepSession` makes one in step again: when the turn's reply was both
 * completed by the model and kept on screen. A stop, a failure, a regenerate that was not kept, a reply that was
 * discarded, a turn that another tool or an API provider answered, and a lost session all leave it out of step, and the
 * next turn then replays what the student sees since `syncedTo`.
 */
export type SessionTurn = {
  provider: string;
  sessionId: string;
  cwd: string;
  model: string;
  effort: string | null;
  told: string;
  /** The hash of the system prompt this turn ran under. */
  instructions: string;
  chars: number;
  now: number;
  /** The model completed this turn: it counts as a turn of the session, which is not yet in step (see `keepSession`). */
  finished: boolean;
  /** For a session this turn opens: the last message its first prompt held (the one before the question). */
  syncedTo: string | null;
  /** Cursor's own folder was seen to hold the chat. */
  seen?: boolean;
};

/**
 * Records a turn. The session the turn continued is updated; one the turn did not continue (another tool answered, or the
 * tool started a new session) ends with the reason, and the new one is opened.
 */
export function recordSession(
  db: Database.Database,
  owner: string,
  prior: StoredSession | undefined,
  turn: SessionTurn,
  reason: "tool" | "gone" | "long" | "instructions" = "gone",
): void {
  if (prior && prior.provider === turn.provider && prior.sessionId === turn.sessionId) {
    db.prepare(
      `UPDATE tool_sessions SET model = ?, effort = ?, told = ?, instructions = ?, chars = chars + ?, seen = MAX(seen, ?),
         turns = turns + 1, last_used_at = ? WHERE id = ?`,
    ).run(turn.model, turn.effort, turn.told, turn.instructions, turn.chars, turn.seen ? 1 : 0, turn.now, prior.id);
    return;
  }
  if (prior)
    db.prepare(`UPDATE tool_sessions SET ended_at = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL`).run(
      turn.now,
      prior.provider !== turn.provider ? "tool" : reason,
      prior.id,
    );
  db.prepare(
    `INSERT INTO tool_sessions
      (id, owner, provider, session_id, model, effort, cwd, told, instructions, chars, in_step, synced_to, seen, turns, opened_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  ).run(
    uuidv7(turn.now),
    owner,
    turn.provider,
    turn.sessionId,
    turn.model,
    turn.effort,
    turn.cwd,
    turn.told,
    turn.instructions,
    turn.chars,
    turn.syncedTo,
    turn.seen ? 1 : 0,
    // A session opened when the tool names it has no finished turn yet.
    turn.finished ? 1 : 0,
    turn.now,
    turn.now,
  );
}

/** A turn starts: no open session of the owner can be trusted to hold the conversation until one completes normally. */
export function markOutOfStep(db: Database.Database, owner: string): void {
  db.prepare(`UPDATE tool_sessions SET in_step = 0 WHERE owner = ? AND ended_at IS NULL`).run(owner);
}

/**
 * The one place a session becomes in step: the model completed the reply on the open session of `provider`, and the reply
 * is kept on screen as `marker` (a message id for a chat), so the session holds the conversation up to it.
 */
export function keepSession(db: Database.Database, owner: string, provider: string, marker: string): void {
  db.prepare(`UPDATE tool_sessions SET in_step = 1, synced_to = ? WHERE owner = ? AND provider = ? AND ended_at IS NULL`).run(
    marker,
    owner,
    provider,
  );
}

/**
 * A regenerated reply was not kept, so the earlier answer stays on screen while the session was told to discard it: the
 * session holds the conversation only up to the last reply that completed normally before `questionId`, and the next
 * turn replays the question and the answer the student sees. The boundary only moves back, and never lands on a reply the
 * student saw cut off.
 */
export function rewindSession(db: Database.Database, chatId: string, questionId: string): void {
  const completed = db
    .prepare(
      `SELECT id, rowid FROM messages WHERE chat_id = ? AND role = 'assistant' AND stopped = 0
         AND rowid < (SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid DESC LIMIT 1`,
    )
    .get(chatId, questionId) as { id: string; rowid: number } | undefined;
  const current = db
    .prepare(`SELECT id, synced_to FROM tool_sessions WHERE owner = ? AND ended_at IS NULL`)
    .all(chatId) as Array<{ id: string; synced_to: string | null }>;
  for (const row of current) {
    if (row.synced_to === null) continue;
    const held = db.prepare(`SELECT rowid FROM messages WHERE id = ?`).pluck().get(row.synced_to) as number | undefined;
    if (completed && held !== undefined && held <= completed.rowid) continue;
    db.prepare(`UPDATE tool_sessions SET synced_to = ? WHERE id = ?`).run(completed?.id ?? null, row.id);
  }
}

/** How many tool sessions the chat has opened, the ended ones included. */
export function sessionsOpened(db: Database.Database, owner: string): number {
  return (db.prepare(`SELECT COUNT(*) FROM tool_sessions WHERE owner = ?`).pluck().get(owner) as number) ?? 0;
}

/** A short fingerprint of the context block, so a session is told it again only when it changed. */
export function contextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Counts what a tool kept of a turn that ended without an answer into the open session of that tool, for the size bound
 * only: what a session is told next does not depend on it.
 */
export function addSessionChars(db: Database.Database, owner: string, provider: string, chars: number): void {
  if (chars <= 0) return;
  db.prepare(`UPDATE tool_sessions SET chars = chars + ? WHERE owner = ? AND provider = ? AND ended_at IS NULL`).run(chars, owner, provider);
}
