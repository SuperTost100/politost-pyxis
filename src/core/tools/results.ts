import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { removeCards, restoreCards } from "../study/cards";
import type { ToolResultView } from "../../shared/ipc";
import { mapToolBlocks, TOOL_FENCE, toolBlockIds } from "../../shared/tool-blocks";

/**
 * What a chat tool did, stored with the reply that called it (`chat_tool_results`) and shown there as a ```pyxis-tool
 * block whose body is the row's id. The row outlives the turn: the chat shows it again when reopened, and «Annulla» and
 * «Ripristina» act on it later.
 */

/** A flashcard result: the cards it created, in order, where they went, and the first fronts the chat lists. */
export type FlashcardsData = {
  cardIds: string[];
  duplicates: number;
  /** A few words the model gave that complete "8 flashcard …", or null. */
  title: string | null;
  /** The subject's or the exam's name, for a result without a title. */
  deck: string;
  fronts: string[];
};

/** Fronts the result keeps for the chat to list. */
const LISTED = 3;

export function storeFlashcards(
  db: Database.Database,
  chatId: string,
  data: Omit<FlashcardsData, "fronts"> & { fronts: string[] },
  now = Date.now(),
): string {
  const id = uuidv7(now);
  const stored: FlashcardsData = { ...data, fronts: data.fronts.slice(0, LISTED) };
  db.prepare(
    `INSERT INTO chat_tool_results (id, chat_id, message_id, tool, data_json, created_at)
     VALUES (?, ?, NULL, 'create_flashcards', ?, ?)`,
  ).run(id, chatId, JSON.stringify(stored), now);
  return id;
}

/**
 * Adds a later call's cards to the result an earlier call of the same reply stored, so one reply shows one card of what
 * it made however the model split the list.
 */
export function addFlashcards(
  db: Database.Database,
  chatId: string,
  id: string,
  more: { cardIds: string[]; duplicates: number; fronts: string[] },
): void {
  const { data } = flashcardsRow(db, chatId, id);
  const next: FlashcardsData = {
    ...data,
    cardIds: [...data.cardIds, ...more.cardIds],
    duplicates: data.duplicates + more.duplicates,
    fronts: [...data.fronts, ...more.fronts].slice(0, LISTED),
  };
  db.prepare(`UPDATE chat_tool_results SET data_json = ? WHERE id = ?`).run(JSON.stringify(next), id);
}

type Row = { id: string; tool: string; data_json: string; undone_json: string | null };

function view(row: Row): ToolResultView | null {
  if (row.tool !== "create_flashcards") return null;
  const data = JSON.parse(row.data_json) as FlashcardsData;
  const undone = row.undone_json ? (JSON.parse(row.undone_json) as string[]) : null;
  return {
    id: row.id,
    tool: "create_flashcards",
    count: data.cardIds.length,
    duplicates: data.duplicates,
    title: data.title,
    deck: data.deck,
    fronts: data.fronts,
    undone: undone ? undone.length : null,
  };
}

/** The views of the results `ids` names that belong to the chat, by id. */
export function toolViews(db: Database.Database, chatId: string, ids: readonly string[]): Record<string, ToolResultView> {
  if (ids.length === 0) return {};
  const rows = db
    .prepare(
      `SELECT id, tool, data_json, undone_json FROM chat_tool_results
       WHERE chat_id = ? AND id IN (SELECT value FROM json_each(?))`,
    )
    .all(chatId, JSON.stringify(ids)) as Row[];
  return Object.fromEntries(rows.flatMap((row) => {
    const shown = view(row);
    return shown ? [[row.id, shown]] : [];
  }));
}

/** One result's view, or null when the chat has no such result. */
export function toolView(db: Database.Database, chatId: string, id: string): ToolResultView | null {
  return toolViews(db, chatId, [id])[id] ?? null;
}

/** Ties the results a saved reply shows to it. */
export function linkToolResults(db: Database.Database, chatId: string, messageId: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  db.prepare(
    `UPDATE chat_tool_results SET message_id = ? WHERE chat_id = ? AND id IN (SELECT value FROM json_each(?))`,
  ).run(messageId, chatId, JSON.stringify(ids));
}

function flashcardsRow(db: Database.Database, chatId: string, id: string): { data: FlashcardsData; undone: string[] | null } {
  const row = db
    .prepare(`SELECT tool, data_json, undone_json FROM chat_tool_results WHERE id = ? AND chat_id = ?`)
    .get(id, chatId) as { tool: string; data_json: string; undone_json: string | null } | undefined;
  if (!row || row.tool !== "create_flashcards") throw new Error("tool-result-missing");
  return {
    data: JSON.parse(row.data_json) as FlashcardsData,
    undone: row.undone_json ? (JSON.parse(row.undone_json) as string[]) : null,
  };
}

/**
 * «Annulla»: the result's cards leave the deck, reviewed or not, by the cards' own soft delete. A second undo changes
 * nothing. The cards the undo removed are kept, so «Ripristina» brings back exactly those.
 */
export function undoToolResult(db: Database.Database, chatId: string, id: string): ToolResultView {
  return db.transaction(() => {
    const { data, undone } = flashcardsRow(db, chatId, id);
    if (!undone) {
      const removed = removeCards(db, data.cardIds);
      db.prepare(`UPDATE chat_tool_results SET undone_json = ? WHERE id = ?`).run(JSON.stringify(removed), id);
    }
    return toolView(db, chatId, id)!;
  })();
}

/** «Ripristina»: the cards the undo removed come back with their reviews. */
export function restoreToolResult(db: Database.Database, chatId: string, id: string): ToolResultView {
  return db.transaction(() => {
    const { undone } = flashcardsRow(db, chatId, id);
    if (undone) {
      restoreCards(db, undone);
      db.prepare(`UPDATE chat_tool_results SET undone_json = NULL WHERE id = ?`).run(id);
    }
    return toolView(db, chatId, id)!;
  })();
}

/**
 * A reply that is answered again takes what its tools did with it: each of `ids` that still stands is undone as «Annulla»
 * does it, before the new answer runs, so the new answer's cards are not taken for duplicates of the old ones. Returns
 * the ids it undid, which `restoreToolResults` puts back if the old reply stays after all.
 */
export function takeBackToolResults(db: Database.Database, chatId: string, ids: readonly string[]): string[] {
  return ids.filter((id) => {
    const row = db.prepare(`SELECT undone_json FROM chat_tool_results WHERE id = ? AND chat_id = ?`).get(id, chatId) as
      | { undone_json: string | null }
      | undefined;
    if (!row || row.undone_json !== null) return false;
    undoToolResult(db, chatId, id);
    return true;
  });
}

/** Puts back what `takeBackToolResults` undid, when the reply it was taken from stays on screen. */
export function restoreToolResults(db: Database.Database, chatId: string, ids: readonly string[]): void {
  for (const id of ids) restoreToolResult(db, chatId, id);
}

/**
 * The results of the chat that no reply shows: a reply that was answered again, stopped or failed was discarded with them.
 * Their cards leave the deck as «Annulla» takes them, reviews kept, and the rows go, so none points at a message that is
 * gone. `keep` are rows to leave alone.
 */
export function dropStrayToolResults(db: Database.Database, chatId: string, keep: readonly string[] = []): void {
  db.transaction(() => {
    const stray = db
      .prepare(
        `SELECT id, data_json, undone_json FROM chat_tool_results r
         WHERE r.chat_id = ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = r.message_id AND m.chat_id = r.chat_id)`,
      )
      .all(chatId) as Array<{ id: string; data_json: string; undone_json: string | null }>;
    for (const row of stray) {
      if (keep.includes(row.id)) continue;
      if (row.undone_json === null) removeCards(db, (JSON.parse(row.data_json) as FlashcardsData).cardIds);
      db.prepare(`DELETE FROM chat_tool_results WHERE id = ?`).run(row.id);
    }
  })();
}

/** The cards a result created, for «Apri», which lists them in the card browser. Empty for an unknown id. */
export function toolResultCards(db: Database.Database, id: string): string[] {
  const row = db.prepare(`SELECT tool, data_json FROM chat_tool_results WHERE id = ?`).get(id) as
    | { tool: string; data_json: string }
    | undefined;
  if (row?.tool !== "create_flashcards") return [];
  return (JSON.parse(row.data_json) as FlashcardsData).cardIds;
}

/**
 * A reply's text with each tool block replaced by a line that says what the tool did, for the conversation handed to a
 * model and for an export. `describe` words one result; a block whose result is gone becomes nothing.
 */
export function describeToolBlocks(
  db: Database.Database,
  chatId: string,
  body: string,
  describe: (view: ToolResultView) => string,
): string {
  const ids = toolBlockIds(body);
  if (ids.length === 0) return mapToolBlocks(body, () => "");
  const views = toolViews(db, chatId, ids);
  return mapToolBlocks(body, (id) => {
    const shown = views[id];
    return shown ? describe(shown) : "";
  });
}

/** How the conversation handed to a model tells what a tool did: what the model would have read as the tool's result. */
export function toolNote(view: ToolResultView): string {
  const what = `${view.count} flashcard${view.count === 1 ? "" : "s"}${view.title ? ` (${view.title})` : ""}`;
  return view.undone !== null
    ? `[Pyxis tool create_flashcards: created ${what}; the student then undid them, so they are no longer in the deck.]`
    : `[Pyxis tool create_flashcards: created ${what} in the deck of ${view.deck}.]`;
}

/**
 * A reply as streamed, with each tool's block placed where the model called it: `marks` are offsets into `raw` with the
 * block's body (a result id, or `pending:<tool>` while it runs). Any fence the model wrote itself with the tool's
 * language becomes a plain code fence, so only core's blocks are ever read as results.
 */
export function spliceToolBlocks(raw: string, marks: ReadonlyArray<{ offset: number; body: string }>): string {
  const neutral = (text: string) => text.replace(/^([ \t]*(?:\x60{3,}|~{3,})[ \t]*)pyxis-tool\b/gim, "$1text");
  if (marks.length === 0) return raw.includes(TOOL_FENCE) ? neutral(raw) : raw;
  const sorted = [...marks].sort((a, b) => a.offset - b.offset);
  let out = "";
  let at = 0;
  for (const mark of sorted) {
    const offset = Math.min(Math.max(mark.offset, at), raw.length);
    const before = neutral(raw.slice(at, offset));
    out += `${before.trim() ? `${before.trimEnd()}\n\n` : ""}\x60\x60\x60${TOOL_FENCE}\n${mark.body}\n\x60\x60\x60\n\n`;
    at = offset;
  }
  return `${out}${neutral(raw.slice(at)).replace(/^\s*/, "")}`.trimEnd();
}
