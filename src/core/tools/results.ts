import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { removeCards, restoreCards } from "../study/cards";
import type { MadeResultView, ToolResultView } from "../../shared/ipc";
import { mapToolBlocks, TOOL_FENCE, toolBlockIds } from "../../shared/tool-blocks";
import { resumeToolJobs } from "./jobs";
import { dropMap, mapView, restoreMap, retryMap, undoMap, type MapData, type MapUndone } from "./map";
import { dropQuiz, quizView, restoreQuiz, retryQuiz, undoQuiz, type QuizData, type QuizUndone } from "./quiz";
import { isProposal, proposalView, unwithdrawProposal, withdrawProposal } from "./proposals";
import { deleteNote } from "./proposeDelete";
import { examNote } from "./proposeExam";
import { pathNote } from "./proposePath";

/**
 * What a chat tool did, stored with the reply that called it (`chat_tool_results`) and shown there as a ```pyxis-tool
 * block whose body is the row's id. The row outlives the turn: the chat shows it again when reopened, and «Annulla» and
 * «Ripristina» act on it later. Flashcards are kept here; maps and quizzes in `map.ts` and `quiz.ts`, whose results also
 * follow the job that makes them (`jobs.ts`).
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
  const { data, undone } = flashcardsRow(db, chatId, id);
  const next: FlashcardsData = {
    ...data,
    cardIds: [...data.cardIds, ...more.cardIds],
    duplicates: data.duplicates + more.duplicates,
    fronts: [...data.fronts, ...more.fronts].slice(0, LISTED),
  };
  // The student undid the result while the answer was still running: the later cards leave the deck with the others, and
  // the undo record holds them, so «Ripristina» brings back all of them.
  const removed = undone ? [...undone, ...removeCards(db, more.cardIds)] : null;
  db.prepare(`UPDATE chat_tool_results SET data_json = ?, undone_json = COALESCE(?, undone_json) WHERE id = ?`).run(
    JSON.stringify(next),
    removed ? JSON.stringify(removed) : null,
    id,
  );
}

type Row = { id: string; tool: string; data_json: string; undone_json: string | null };

function view(db: Database.Database, row: Row): ToolResultView | null {
  if (isProposal(row.tool)) return proposalView(db, row.id);
  const undone = row.undone_json ? (JSON.parse(row.undone_json) as unknown) : null;
  if (row.tool === "create_map") return mapView(db, row.id, JSON.parse(row.data_json) as MapData, undone as MapUndone | null);
  if (row.tool === "create_quiz") return quizView(db, row.id, JSON.parse(row.data_json) as QuizData, undone as QuizUndone | null);
  if (row.tool !== "create_flashcards") return null;
  const data = JSON.parse(row.data_json) as FlashcardsData;
  return {
    id: row.id,
    tool: "create_flashcards",
    count: data.cardIds.length,
    duplicates: data.duplicates,
    title: data.title,
    deck: data.deck,
    fronts: data.fronts,
    undone: undone ? (undone as string[]).length : null,
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
    const shown = view(db, row);
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

function resultRow(db: Database.Database, chatId: string, id: string): Row {
  const row = db
    .prepare(`SELECT id, tool, data_json, undone_json FROM chat_tool_results WHERE id = ? AND chat_id = ?`)
    .get(id, chatId) as Row | undefined;
  // A proposal is answered only through `decideProposal`, never undone, restored or retried as a made thing.
  if (!row || isProposal(row.tool)) throw new Error("tool-result-missing");
  return row;
}

function flashcardsRow(db: Database.Database, chatId: string, id: string): { data: FlashcardsData; undone: string[] | null } {
  const row = resultRow(db, chatId, id);
  if (row.tool !== "create_flashcards") throw new Error("tool-result-missing");
  return {
    data: JSON.parse(row.data_json) as FlashcardsData,
    undone: row.undone_json ? (JSON.parse(row.undone_json) as string[]) : null,
  };
}

/**
 * «Annulla»: what the result made leaves the app, and the record of what left is kept, so «Ripristina» brings back
 * exactly that. Cards leave the deck by their own soft delete, reviewed or not. A map leaves Mappe and a quiz leaves the
 * exam (`undoMap`, `undoQuiz`), and one still being made stops. A second undo changes nothing.
 */
export function undoToolResult(db: Database.Database, chatId: string, id: string): MadeResultView {
  return db.transaction(() => {
    const row = resultRow(db, chatId, id);
    if (row.undone_json === null) {
      const data = JSON.parse(row.data_json) as unknown;
      const undone =
        row.tool === "create_map"
          ? undoMap(db, data as MapData)
          : row.tool === "create_quiz"
            ? undoQuiz(db, data as QuizData)
            : removeCards(db, (data as FlashcardsData).cardIds);
      db.prepare(`UPDATE chat_tool_results SET undone_json = ? WHERE id = ?`).run(JSON.stringify(undone), id);
    }
    return toolView(db, chatId, id) as MadeResultView;
  })();
}

/** «Ripristina»: what the undo took away comes back, the cards with their reviews, a map or a quiz as it was. */
export function restoreToolResult(db: Database.Database, chatId: string, id: string): MadeResultView {
  return db.transaction(() => {
    const row = resultRow(db, chatId, id);
    if (row.undone_json !== null) {
      const data = JSON.parse(row.data_json) as unknown;
      const undone = JSON.parse(row.undone_json) as unknown;
      if (row.tool === "create_map") restoreMap(db, data as MapData, undone as MapUndone);
      else if (row.tool === "create_quiz") restoreQuiz(db, data as QuizData, undone as QuizUndone);
      else restoreCards(db, undone as string[]);
      db.prepare(`UPDATE chat_tool_results SET undone_json = NULL WHERE id = ?`).run(id);
    }
    return toolView(db, chatId, id) as MadeResultView;
  })();
}

/** «Riprova» or «Riprendi» on a map or a quiz whose job failed or stopped: the job goes on from where it was. */
export function retryToolResult(db: Database.Database, chatId: string, id: string): MadeResultView {
  return db.transaction(() => {
    const row = resultRow(db, chatId, id);
    if (row.undone_json !== null) throw new Error("tool-result-undone");
    if (row.tool === "create_map") retryMap(db, JSON.parse(row.data_json) as MapData);
    else if (row.tool === "create_quiz") retryQuiz(db, JSON.parse(row.data_json) as QuizData);
    else throw new Error("tool-result-missing");
    return toolView(db, chatId, id) as MadeResultView;
  })();
}

/**
 * A reply that is answered again takes what its tools did with it: each of `ids` that still stands is undone as «Annulla»
 * does it, before the new answer runs, so the new answer's cards are not taken for duplicates of the old ones, and a map
 * or a quiz still being made stops. A quiz the student handed in stays. Returns the ids it undid, which
 * `restoreToolResults` puts back if the old reply stays after all.
 */
export function takeBackToolResults(db: Database.Database, chatId: string, ids: readonly string[]): string[] {
  return ids.filter((id) => {
    const row = db.prepare(`SELECT tool, data_json, undone_json FROM chat_tool_results WHERE id = ? AND chat_id = ?`).get(id, chatId) as
      | { tool: string; data_json: string; undone_json: string | null }
      | undefined;
    if (!row || row.undone_json !== null) return false;
    // A pending proposal is withdrawn while the new answer is written; one the student decided on stays theirs.
    if (isProposal(row.tool)) return withdrawProposal(db, chatId, id);
    try {
      undoToolResult(db, chatId, id);
      return true;
    } catch (err) {
      if (err instanceof Error && err.message === "tool-handed-in") return false;
      throw err;
    }
  });
}

/** Puts back what `takeBackToolResults` undid, when the reply it was taken from stays on screen. */
export function restoreToolResults(db: Database.Database, chatId: string, ids: readonly string[]): void {
  for (const id of ids) {
    const tool = db.prepare(`SELECT tool FROM chat_tool_results WHERE id = ? AND chat_id = ?`).pluck().get(id, chatId) as string | undefined;
    if (tool && isProposal(tool)) {
      unwithdrawProposal(db, chatId, id);
      continue;
    }
    try {
      restoreToolResult(db, chatId, id);
    } catch (err) {
      // A map or a quiz whose job is still settling the stop the new answer gave it cannot go on yet. It stays undone,
      // and its line in the reply offers «Ripristina»; the earlier answer must still come back.
      if (!(err instanceof Error && ["tool-busy", "tool-restore-gone"].includes(err.message))) throw err;
    }
  }
}

/**
 * The results of the chat that no reply shows: a reply that was answered again, stopped or failed was discarded with them.
 * Their cards leave the deck as «Annulla» takes them, reviews kept. Their maps and quizzes go for good, with the jobs
 * that made them, except a quiz the student handed in; one already undone is purged with its row, since only the row
 * could bring it back. The rows go, so none points at a message that is gone. `keep` are rows to leave alone.
 */
export function dropStrayToolResults(db: Database.Database, chatId: string, keep: readonly string[] = []): void {
  db.transaction(() => {
    const stray = db
      .prepare(
        `SELECT id, tool, data_json, undone_json FROM chat_tool_results r
         WHERE r.chat_id = ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = r.message_id AND m.chat_id = r.chat_id)`,
      )
      .all(chatId) as Row[];
    for (const row of stray) {
      if (keep.includes(row.id)) continue;
      const data = JSON.parse(row.data_json) as unknown;
      // A proposal made nothing; one the student applied made the change as the student, which stays theirs.
      if (isProposal(row.tool)) {
        db.prepare(`DELETE FROM chat_tool_results WHERE id = ?`).run(row.id);
        continue;
      }
      if (row.tool === "create_map") dropMap(db, data as MapData, row.undone_json !== null);
      else if (row.tool === "create_quiz") dropQuiz(db, data as QuizData, row.undone_json !== null);
      else if (row.undone_json === null) removeCards(db, (data as FlashcardsData).cardIds);
      db.prepare(`DELETE FROM chat_tool_results WHERE id = ?`).run(row.id);
    }
  })();
}

/**
 * What core does with the chats' results when it starts, before the runner takes any job: a result no saved reply
 * names was made by a reply that Pyxis closed while it was written, so no card can show, open or undo it, and it goes
 * with what it made (`dropStrayToolResults`). Then the builds of the results that stand and that a restart cut off go
 * on (`resumeToolJobs`).
 */
export function startToolResults(db: Database.Database): void {
  const chats = db
    .prepare(
      `SELECT DISTINCT r.chat_id FROM chat_tool_results r
       WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = r.message_id AND m.chat_id = r.chat_id)`,
    )
    .pluck()
    .all() as string[];
  for (const chatId of chats) dropStrayToolResults(db, chatId);
  resumeToolJobs(db);
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
  if (view.tool === "propose_path_change") return pathNote(view);
  if (view.tool === "propose_exam") return examNote(view);
  if (view.tool === "propose_delete") return deleteNote(view);
  if (view.tool === "create_map") {
    const what = `the concept map "${view.topic}" in Mappe, under ${view.subject}`;
    if (view.undone) return `[Pyxis tool create_map: started ${what}; the student then undid it, so it is not in Mappe.]`;
    if (view.gone) return `[Pyxis tool create_map: created ${what}; the student later deleted it.]`;
    if (view.job === "done") return `[Pyxis tool create_map: created ${what}, with ${view.concepts} concepts in ${view.branches} branches.]`;
    if (view.job === "working") return `[Pyxis tool create_map: building ${what}; it is not finished yet.]`;
    return `[Pyxis tool create_map: started ${what}, but the build stopped before the map was made.]`;
  }
  if (view.tool === "create_quiz") {
    const what = `a quiz on "${view.topic}" in the exam ${view.exam}`;
    if (view.undone) return `[Pyxis tool create_quiz: started ${what}; the student then undid it, so it is not in the exam.]`;
    if (view.gone) return `[Pyxis tool create_quiz: created ${what}; the student later deleted it.]`;
    if (view.handedIn) return `[Pyxis tool create_quiz: created ${what}, with ${view.count} questions; the student has handed it in.]`;
    if (view.job === "done") return `[Pyxis tool create_quiz: created ${what}, with ${view.count} questions, for the student to take.]`;
    if (view.job === "working") return `[Pyxis tool create_quiz: writing ${what}; it is not finished yet.]`;
    return `[Pyxis tool create_quiz: started ${what}, but its writing stopped before it was finished.]`;
  }
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
  // Any fence in the tool's language, wherever it starts on its line: Markdown reads one inside a block quote or a list
  // item too.
  const neutral = (text: string) => text.replace(/((?:\x60{3,}|~{3,})[ \t]*)pyxis-tool\b/gi, "$1text");
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
