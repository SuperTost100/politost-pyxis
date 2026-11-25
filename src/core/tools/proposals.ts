import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import type { ProposalState, ProposalView } from "../../shared/ipc";
import { liveSubject } from "../chat/subject";
import type { ToolTurn } from "./server";

/**
 * The chat's "ask first" tools: a model that would change the student's path, create an exam or delete something calls
 * a `propose_*` tool, which changes nothing. It stores a proposal with the reply (`chat_tool_results`, as every tool
 * result) and returns at once; the reply shows a card to confirm. Only the student acts on it, in the app, through
 * `decideProposal` (IPC `chats.decideTool`): no tool, argument, model text or later call can confirm one, because the
 * server offers no tool that reads or writes a decision.
 *
 * A proposal keeps the model's `request` and the `action` the app resolved from it, in the chat's place and on the data
 * as they were: the exact ids and values it would act on, with everything its card shows. `basis` is a digest of that
 * action. Whenever the card is read or answered, the request is resolved again from the chat's place and the data as
 * they are now. The proposal is pending only while that resolution equals the stored one; otherwise it is stale.
 * «Applica» acts only when the new resolution's digest equals both `basis` and the one the card showed (`seen`), and it
 * executes that new resolution, never the stored payload, in the same transaction.
 *
 * The decision is kept in the row: `decision` is null while pending. A proposal lapses for good when a later one of its
 * kind is saved with a reply of the chat (`expireOlderProposals`). The model hears the student's decision at its next
 * turn (`decidedSince`), in the message, as a short fixed line.
 */

export const PROPOSAL_TOOLS = ["propose_path_change", "propose_exam", "propose_delete"] as const;
export type ProposalTool = (typeof PROPOSAL_TOOLS)[number];

export const isProposal = (tool: string): tool is ProposalTool => (PROPOSAL_TOOLS as readonly string[]).includes(tool);

export type Decision =
  | { state: "applied"; at: number; outcome: unknown; restoredAt?: number; restored?: unknown }
  | { state: "declined"; at: number }
  /** The reply that made it is being answered again: nothing can act on it unless that answer fails and it comes back. */
  | { state: "withdrawn"; at: number }
  /** A later proposal of its kind was saved in the chat: it never comes back. */
  | { state: "expired"; at: number };

export type ProposalData<R = unknown, A = unknown> = { request: R; proposal: A; basis: string; decision: Decision | null };

/** What the card of every proposal carries, whatever its kind. */
export type ProposalBase = {
  id: string;
  state: ProposalState;
  /** The reply that made it is saved: before that, nothing can decide on it. */
  ready: boolean;
  /** The digest of what the card shows, which the confirming call sends back. */
  seen: string;
};

/** Where and when a proposal is resolved: the chat's place as it is now, and the time. */
export type ProposalContext = { chatId: string; resultId: string; place: ReturnType<ToolTurn["place"]>; now: number };

/** What each kind of proposal does: how a request resolves, the change, its undo, and its card. */
export type ProposalKind<R, A> = {
  tool: ProposalTool;
  /**
   * What the request means in the chat's place on the data as they are: the exact action, with everything its card shows,
   * or why there is none (the text the model reads when it proposes). It only reads.
   */
  resolve(db: Database.Database, request: R, ctx: Omit<ProposalContext, "resultId">): A | { refused: string };
  /**
   * Makes the change an action names, as the student, through the app's own functions, inside the transaction that just
   * resolved it. Throws `ProposalStale` before writing when something it acts on is not what the action named.
   */
  apply(db: Database.Database, action: A, ctx: ProposalContext): unknown;
  /** Takes an applied change back. Throws `ProposalStale`, having written nothing, when it no longer can. */
  undo?(db: Database.Database, action: A, outcome: unknown, ctx: ProposalContext): unknown;
  view(db: Database.Database, base: ProposalBase, action: A, decision: Decision | null): ProposalView;
};

/** What `apply` or `undo` throws when what it would act on is no longer what the proposal named: nothing is written. */
export class ProposalStale extends Error {
  constructor() {
    super("proposal-stale");
  }
}

/** A stable short digest of a value. */
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

/** Strips the controls that reorder text on screen from a name a card shows, so a name cannot disguise the words around it. */
export const plainName = (text: string) => text.replace(/[؜‎‏‪-‮⁦-⁩]/g, "");

const kinds = new Map<string, ProposalKind<unknown, unknown>>();

/** Each proposal tool's file registers its kind once, when it is loaded. */
export function registerProposalKind<R, A>(kind: ProposalKind<R, A>): void {
  kinds.set(kind.tool, kind as unknown as ProposalKind<unknown, unknown>);
}

function kindOf(tool: string): ProposalKind<unknown, unknown> {
  const kind = kinds.get(tool);
  if (!kind) throw new Error("tool-result-missing");
  return kind;
}

const isRefusal = (value: unknown): value is { refused: string } => !!value && typeof value === "object" && "refused" in value;

/**
 * A tool's call: resolves the request in the turn's place and, when it means something, stores it with the reply as a
 * pending proposal. Returns the stored id and the action, or the refusal the model reads.
 */
export function propose<R, A>(
  db: Database.Database,
  turn: ToolTurn,
  tool: ProposalTool,
  request: R,
  now = Date.now(),
): { resultId: string; action: A } | { refused: string } {
  const action = kindOf(tool).resolve(db, request, { chatId: turn.chatId, place: turn.place(), now });
  if (isRefusal(action)) return action;
  const resultId = uuidv7(now);
  const data: ProposalData<R, unknown> = { request, proposal: action, basis: digest(action), decision: null };
  db.prepare(
    `INSERT INTO chat_tool_results (id, chat_id, message_id, tool, data_json, created_at) VALUES (?, ?, NULL, ?, ?, ?)`,
  ).run(resultId, turn.chatId, tool, JSON.stringify(data), now);
  return { resultId, action: action as A };
}

type Row = { id: string; chat_id: string; message_id: string | null; tool: string; data_json: string; created_at: number };

function proposalRow(db: Database.Database, chatId: string, id: string): Row {
  const row = db
    .prepare(`SELECT id, chat_id, message_id, tool, data_json, created_at FROM chat_tool_results WHERE id = ? AND chat_id = ?`)
    .get(id, chatId) as Row | undefined;
  if (!row || !isProposal(row.tool)) throw new Error("tool-result-missing");
  return row;
}

/** The chat's place now, as a turn of it would see it: its exam while that exists, and its subject while that exists. */
export function chatPlace(db: Database.Database, chatId: string): ReturnType<ToolTurn["place"]> {
  const row = db.prepare("SELECT scope_json, subject FROM chats WHERE id = ?").get(chatId) as
    | { scope_json: string; subject: string | null }
    | undefined;
  if (!row) return { planId: null, subject: null };
  const scope = JSON.parse(row.scope_json) as { planId?: unknown } | unknown[] | null;
  const planId = scope && !Array.isArray(scope) && typeof scope.planId === "string" ? scope.planId : null;
  return {
    planId: planId && db.prepare("SELECT 1 FROM plans WHERE id = ?").get(planId) ? planId : null,
    subject: liveSubject(db, row.subject),
  };
}

/** Whether a later proposal of the same kind was saved with a reply of the chat. */
function newerSaved(db: Database.Database, row: Row): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM chat_tool_results r JOIN messages m ON m.id = r.message_id AND m.chat_id = r.chat_id
       WHERE r.chat_id = ? AND r.tool = ? AND r.id != ? AND (r.created_at > ? OR (r.created_at = ? AND r.id > ?)) LIMIT 1`,
    )
    .get(row.chat_id, row.tool, row.id, row.created_at, row.created_at, row.id);
}

/** Whether the reply that made the proposal is saved, so the student can decide on it. */
const replySaved = (db: Database.Database, row: Row) =>
  !!row.message_id && !!db.prepare("SELECT 1 FROM messages WHERE id = ? AND chat_id = ?").get(row.message_id, row.chat_id);

/**
 * Where a proposal stands, and for a pending one the action it means now. Anything that keeps the request from
 * resolving, an error reading its target included, is a change: the card reads stale and can still be declined.
 */
function stateOf(db: Database.Database, row: Row, data: ProposalData, at: number): { state: ProposalState; action: unknown } {
  const decision = data.decision;
  if (decision?.state === "applied") return { state: decision.restoredAt ? "restored" : "applied", action: null };
  if (decision?.state === "withdrawn" || decision?.state === "expired") return { state: "expired", action: null };
  if (decision?.state === "declined") return { state: "declined", action: null };
  let action: unknown;
  try {
    action = kindOf(row.tool).resolve(db, data.request, { chatId: row.chat_id, place: chatPlace(db, row.chat_id), now: at });
  } catch {
    return { state: "stale", action: null };
  }
  if (isRefusal(action)) return { state: "stale", action: null };
  return digest(action) === data.basis ? { state: "pending", action } : { state: "stale", action: null };
}

function viewOf(db: Database.Database, row: Row, at = Date.now(), stale = false): ProposalView {
  const data = JSON.parse(row.data_json) as ProposalData;
  const found = stateOf(db, row, data, at).state;
  const state = stale && found === "pending" ? "stale" : found;
  return kindOf(row.tool).view(db, { id: row.id, state, ready: replySaved(db, row), seen: data.basis }, data.proposal, data.decision);
}

/** A stored proposal's view, for `toolViews`. */
export function proposalView(db: Database.Database, id: string): ProposalView | null {
  const row = db
    .prepare(`SELECT id, chat_id, message_id, tool, data_json, created_at FROM chat_tool_results WHERE id = ?`)
    .get(id) as Row | undefined;
  return row && isProposal(row.tool) ? viewOf(db, row) : null;
}

export type ProposalAction = "apply" | "decline" | "reopen" | "undo";

/** Runs `write` in a savepoint: a `ProposalStale` it throws leaves nothing written and comes back as `refused`. */
function guarded<T>(db: Database.Database, write: () => T): { done: T } | { refused: true } {
  try {
    return { done: db.transaction(write)() };
  } catch (err) {
    if (err instanceof ProposalStale) return { refused: true };
    throw err;
  }
}

/**
 * The student's answer to a proposal, from its card. The result must be this chat's and its reply saved. «Applica»
 * (`apply`) resolves the request again, in the chat's place now, and acts only when that resolution is the one the card
 * showed (`seen`) and the one stored: it executes that resolution, in this transaction. Otherwise nothing happens and
 * the card returned says it changed. «Non cambiare» (`decline`), which a stale card also takes, and «Rivedi la
 * proposta» (`reopen`) change only the decision. `undo` takes back an applied change that can be taken back (a
 * deletion), and leaves it as it is when it no longer can. Any other combination returns the card as it is.
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
    const ctx: ProposalContext = { chatId, resultId: id, place: chatPlace(db, chatId), now };
    const { state, action: current } = stateOf(db, row, data, now);
    let decision: Decision | null | undefined;
    let refused = false;
    if (action === "apply" && state === "pending" && seen === data.basis && digest(current) === data.basis) {
      const result = guarded(db, () => kind.apply(db, current, ctx));
      if ("done" in result) decision = { state: "applied", at: now, outcome: result.done };
      else refused = true;
    } else if (action === "decline" && (state === "pending" || state === "stale")) {
      decision = { state: "declined", at: now };
    } else if (action === "reopen" && state === "declined") {
      // A later proposal of its kind saved since replaced it for good: reopened, it reads as lapsed, never pending.
      decision = newerSaved(db, row) ? { state: "expired", at: now } : null;
    } else if (action === "undo" && state === "applied" && kind.undo && data.decision?.state === "applied") {
      const applied = data.decision;
      const result = guarded(db, () => kind.undo!(db, data.proposal, applied.outcome, ctx));
      if ("done" in result) decision = { ...applied, restoredAt: now, restored: result.done };
    }
    if (decision !== undefined) {
      const next: ProposalData = { ...data, decision };
      db.prepare(`UPDATE chat_tool_results SET data_json = ? WHERE id = ?`).run(JSON.stringify(next), id);
    }
    return viewOf(db, proposalRow(db, chatId, id), now, refused);
  })();
}

/**
 * The proposals `ids` were saved with a reply: every proposal of the same kind made before them in the chat and still
 * waiting lapses for good. A result of a turn that failed is never saved, so it never touches an older card.
 */
export function expireOlderProposals(db: Database.Database, chatId: string, ids: readonly string[], now = Date.now()): void {
  const rows = db
    .prepare(`SELECT id, tool, data_json, created_at FROM chat_tool_results WHERE chat_id = ? ORDER BY created_at, id`)
    .all(chatId) as Array<{ id: string; tool: string; data_json: string; created_at: number }>;
  const saved = rows.filter((row) => ids.includes(row.id) && isProposal(row.tool));
  if (saved.length === 0) return;
  for (const row of rows) {
    if (!isProposal(row.tool) || ids.includes(row.id)) continue;
    const newer = saved.some(
      (other) => other.tool === row.tool && (other.created_at > row.created_at || (other.created_at === row.created_at && other.id > row.id)),
    );
    const data = JSON.parse(row.data_json) as ProposalData;
    // Only a proposal still waiting lapses. One withdrawn by a regenerate stays withdrawn, so a stopped or failed new
    // answer still brings it back (`unwithdrawProposal`); a regenerate that keeps its new answer drops it with the old one.
    if (!newer || data.decision) continue;
    db.prepare(`UPDATE chat_tool_results SET data_json = ? WHERE id = ?`).run(
      JSON.stringify({ ...data, decision: { state: "expired", at: now } } satisfies ProposalData),
      row.id,
    );
  }
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
    if (!decision || decision.state === "withdrawn" || decision.state === "expired") return [];
    const at = decision.state === "applied" ? Math.max(decision.at, decision.restoredAt ?? 0) : decision.at;
    return at > since ? [row.id] : [];
  });
}
