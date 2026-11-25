import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import type { ProposalState, ProposalView } from "../../shared/ipc";

/**
 * The chat's "ask first" tools: a model that would change the student's path, create an exam or delete something calls
 * a `propose_*` tool, which changes nothing. It stores a proposal with the reply (`chat_tool_results`, as every tool
 * result) and returns at once; the reply shows a card to confirm. Only the student acts on it, in the app, through
 * `decideProposal` (IPC `chats.decideTool`): no tool, argument, model text or later call can confirm one, because the
 * server offers no tool that reads or writes a decision.
 *
 * What a proposal will do is computed by the app from the chat's place and the data as it is, never taken from the model.
 * The data it was computed from is kept as a fingerprint (`basis`). When the student presses the confirming button,
 * the fingerprint is computed again and must equal both the stored one and the one the card showed (`seen`): a path, a
 * deck, a map or a quiz that changed meanwhile is never acted on, and the card says it changed. A pending proposal also
 * lapses once a later proposal of the same kind is made in the chat.
 *
 * The decision is kept in the row: `decision` is null while pending. The model hears the outcome at its next turn
 * (`decisionNotes`), in the message, as a short fixed line.
 */

export const PROPOSAL_TOOLS = ["propose_path_change", "propose_exam", "propose_delete"] as const;
export type ProposalTool = (typeof PROPOSAL_TOOLS)[number];

export const isProposal = (tool: string): tool is ProposalTool => (PROPOSAL_TOOLS as readonly string[]).includes(tool);

export type Decision =
  | { state: "applied"; at: number; outcome: unknown; restoredAt?: number }
  | { state: "declined"; at: number }
  /** The reply that made it is being answered again: nothing can act on it unless that answer fails and it comes back. */
  | { state: "withdrawn"; at: number };

export type ProposalData<P = unknown> = { proposal: P; basis: string; decision: Decision | null };

/** What the card of every proposal carries, whatever its kind. */
export type ProposalBase = {
  id: string;
  state: ProposalState;
  /** The reply that made it is saved: before that, nothing can decide on it. */
  ready: boolean;
  /** The fingerprint the card shows, which the confirming call sends back. */
  seen: string;
};

/** What each kind of proposal does: the data it stands on, the change, its undo, and its card and line. */
export type ProposalKind<P> = {
  tool: ProposalTool;
  /** The fingerprint of the data the proposal reads now, or null when what it is about is gone (an exam deleted). */
  fingerprint(db: Database.Database, proposal: P): string | null;
  /** Makes the change, as the student, through the app's own functions. Runs in a transaction. Returns what it did. */
  apply(db: Database.Database, proposal: P, chatId: string): unknown;
  /** Takes the change back, for a kind whose change can be undone. Runs in a transaction. */
  undo?(db: Database.Database, proposal: P, outcome: unknown): void;
  view(db: Database.Database, base: ProposalBase, proposal: P, outcome: unknown): ProposalView;
};

/** A stable short digest of a value, for the fingerprints. */
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

export function storeProposal<P>(db: Database.Database, chatId: string, tool: ProposalTool, proposal: P, basis: string, now = Date.now()): string {
  const id = uuidv7(now);
  const data: ProposalData<P> = { proposal, basis, decision: null };
  db.prepare(
    `INSERT INTO chat_tool_results (id, chat_id, message_id, tool, data_json, created_at) VALUES (?, ?, NULL, ?, ?, ?)`,
  ).run(id, chatId, tool, JSON.stringify(data), now);
  return id;
}

type Row = { id: string; chat_id: string; message_id: string | null; tool: string; data_json: string; created_at: number };

const kinds = new Map<string, ProposalKind<never>>();

/** Each proposal tool's file registers its kind once, when it is loaded. */
export function registerProposalKind<P>(kind: ProposalKind<P>): void {
  kinds.set(kind.tool, kind as unknown as ProposalKind<never>);
}

function kindOf(tool: string): ProposalKind<unknown> {
  const kind = kinds.get(tool);
  if (!kind) throw new Error("tool-result-missing");
  return kind as unknown as ProposalKind<unknown>;
}

function proposalRow(db: Database.Database, chatId: string, id: string): Row {
  const row = db
    .prepare(`SELECT id, chat_id, message_id, tool, data_json, created_at FROM chat_tool_results WHERE id = ? AND chat_id = ?`)
    .get(id, chatId) as Row | undefined;
  if (!row || !isProposal(row.tool)) throw new Error("tool-result-missing");
  return row;
}

/** Whether a later proposal of the same kind was made in the chat: then this one has lapsed. */
function superseded(db: Database.Database, row: Row): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM chat_tool_results WHERE chat_id = ? AND tool = ? AND id != ?
         AND (created_at > ? OR (created_at = ? AND id > ?)) LIMIT 1`,
    )
    .get(row.chat_id, row.tool, row.id, row.created_at, row.created_at, row.id);
}

/** Whether the reply that made the proposal is saved, so the student can decide on it. */
const replySaved = (db: Database.Database, row: Row) =>
  !!row.message_id && !!db.prepare("SELECT 1 FROM messages WHERE id = ? AND chat_id = ?").get(row.message_id, row.chat_id);

function stateOf(db: Database.Database, row: Row, data: ProposalData): { state: ProposalState; now: string | null } {
  const decision = data.decision;
  if (decision?.state === "applied") return { state: decision.restoredAt ? "restored" : "applied", now: null };
  if (decision?.state === "withdrawn") return { state: "expired", now: null };
  if (superseded(db, row)) return { state: "expired", now: null };
  if (decision?.state === "declined") return { state: "declined", now: null };
  const now = kindOf(row.tool).fingerprint(db, data.proposal as never);
  return { state: now === data.basis ? "pending" : "stale", now };
}

function viewOf(db: Database.Database, row: Row): ProposalView {
  const data = JSON.parse(row.data_json) as ProposalData;
  const { state } = stateOf(db, row, data);
  const outcome = data.decision?.state === "applied" ? data.decision.outcome : null;
  return kindOf(row.tool).view(db, { id: row.id, state, ready: replySaved(db, row), seen: data.basis }, data.proposal as never, outcome);
}

/** A stored proposal's view, for `toolViews`. */
export function proposalView(db: Database.Database, id: string): ProposalView | null {
  const row = db
    .prepare(`SELECT id, chat_id, message_id, tool, data_json, created_at FROM chat_tool_results WHERE id = ?`)
    .get(id) as Row | undefined;
  return row && isProposal(row.tool) ? viewOf(db, row) : null;
}

export type ProposalAction = "apply" | "decline" | "reopen" | "undo";

/**
 * The student's answer to a proposal, from its card. The result must be this chat's and its reply saved. «Applica»
 * (`apply`) acts only on a pending proposal whose data is still the data the card showed: the change is computed again
 * from the stored proposal and the current data, and when that data moved on, nothing happens and the card returned says
 * it changed. «Non cambiare» (`decline`) and «Rivedi la proposta» (`reopen`) change only the decision. `undo` takes
 * back an applied change that can be taken back (a deletion). Any other combination returns the card as it is.
 */
export function decideProposal(
  db: Database.Database,
  chatId: string,
  id: string,
  action: ProposalAction,
  seen: string | undefined,
  now = Date.now(),
): ProposalView {
  return db.transaction(() => {
    const row = proposalRow(db, chatId, id);
    if (!replySaved(db, row)) throw new Error("proposal-not-ready");
    const data = JSON.parse(row.data_json) as ProposalData;
    const kind = kindOf(row.tool);
    const { state, now: current } = stateOf(db, row, data);
    let decision: Decision | null | undefined;
    if (action === "apply" && state === "pending" && current === data.basis && seen === data.basis) {
      decision = { state: "applied", at: now, outcome: kind.apply(db, data.proposal as never, chatId) };
    } else if (action === "decline" && state === "pending") {
      decision = { state: "declined", at: now };
    } else if (action === "reopen" && state === "declined") {
      decision = null;
    } else if (action === "undo" && state === "applied" && kind.undo && data.decision?.state === "applied") {
      kind.undo(db, data.proposal as never, data.decision.outcome);
      decision = { ...data.decision, restoredAt: now };
    }
    if (decision !== undefined) {
      const next: ProposalData = { ...data, decision };
      db.prepare(`UPDATE chat_tool_results SET data_json = ? WHERE id = ?`).run(JSON.stringify(next), id);
    }
    return viewOf(db, proposalRow(db, chatId, id));
  })();
}

/**
 * «Rigenera» on the reply that made a pending proposal: it is withdrawn, so nothing can apply it while the new answer is
 * written. Returns whether it was. A proposal the student decided on stays as decided: what they did is theirs.
 */
export function withdrawProposal(db: Database.Database, chatId: string, id: string, now = Date.now()): boolean {
  const row = proposalRow(db, chatId, id);
  const data = JSON.parse(row.data_json) as ProposalData;
  if (data.decision) return false;
  db.prepare(`UPDATE chat_tool_results SET data_json = ? WHERE id = ?`).run(
    JSON.stringify({ ...data, decision: { state: "withdrawn", at: now } } satisfies ProposalData),
    id,
  );
  return true;
}

/** The new answer failed and the earlier reply stays: its withdrawn proposal is pending again. */
export function unwithdrawProposal(db: Database.Database, chatId: string, id: string): void {
  const row = proposalRow(db, chatId, id);
  const data = JSON.parse(row.data_json) as ProposalData;
  if (data.decision?.state !== "withdrawn") return;
  db.prepare(`UPDATE chat_tool_results SET data_json = ? WHERE id = ?`).run(JSON.stringify({ ...data, decision: null }), id);
}

/** Whether a stored proposal was decided on by the student (applied or declined), so its line outlives a regenerate. */
export function decidedProposal(db: Database.Database, chatId: string, id: string): boolean {
  const row = db.prepare(`SELECT tool, data_json FROM chat_tool_results WHERE id = ? AND chat_id = ?`).get(id, chatId) as
    | { tool: string; data_json: string }
    | undefined;
  if (!row || !isProposal(row.tool)) return false;
  const decision = (JSON.parse(row.data_json) as ProposalData).decision;
  return decision?.state === "applied" || decision?.state === "declined";
}

/**
 * The proposals of the chat the student decided on, or whose decision they changed, after `since` (the time of the
 * latest reply the model wrote): their ids, oldest first. The next turn tells the model what became of them.
 */
export function decidedSince(db: Database.Database, chatId: string, since: number): string[] {
  const rows = db
    .prepare(`SELECT id, tool, data_json FROM chat_tool_results WHERE chat_id = ? ORDER BY created_at, id`)
    .all(chatId) as Array<{ id: string; tool: string; data_json: string }>;
  return rows.flatMap((row) => {
    if (!isProposal(row.tool)) return [];
    const decision = (JSON.parse(row.data_json) as ProposalData).decision;
    if (!decision || decision.state === "withdrawn") return [];
    const at = decision.state === "applied" ? Math.max(decision.at, decision.restoredAt ?? 0) : decision.at;
    return at > since ? [row.id] : [];
  });
}
