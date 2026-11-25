import type Database from "better-sqlite3";
import { z } from "zod";
import type { DeleteProposalView } from "../../shared/ipc";
import { SCHEMA_VERSION } from "../db/migrate";
import { deleteMap, listMaps, readStoredMap, storeMap, type StoredMap } from "../maps/store";
import { unfinishedActivities } from "../plans/unfinished";
import { removeCards, restoreCards } from "../study/cards";
import { chatExam } from "./proposePath";
import { digest, registerProposalKind, storeProposal, type ProposalKind } from "./proposals";
import { handedIn, matchTitle, quizTopic, restoreQuiz, undoQuiz, type QuizData, type QuizUndone } from "./quiz";
import type { Tool, ToolTurn } from "./server";

/**
 * `propose_delete`: the model proposes to delete something, and the student deletes it or not (`proposals.ts`). Only
 * what the chat's tools can also create may be proposed, and only in the chat's exam or subject: flashcards Pyxis made
 * (of an exam's topic, or those this chat's tools created), a concept map of the subject, or a quiz of the exam that was
 * not handed in. Never an exam, a source, a chat, a grade, or anything of the review history. What goes is found and
 * counted by the app.
 *
 * Every deletion can be undone from the chat, and the card says so instead of "it cannot be undone":
 * - flashcards leave the deck by their own soft delete, which keeps their reviews (`removeCards`); the cards the
 *   student wrote are never proposed, since deleting one of those deletes it for good;
 * - a map leaves Mappe whole, edits included, into the result's record, as «Annulla» on a map the chat made does;
 * - a quiz leaves the exam with the answers given so far, into the result's record (`undoQuiz`); a quiz with a grade
 *   is refused by `undoQuiz` itself.
 */

export const DELETE_TOOL = "propose_delete";

export const deleteInput = z
  .object({
    kind: z.enum(["flashcards", "map", "quiz"]).describe("What to delete."),
    topic: z
      .string()
      .max(240)
      .transform((text) => text.replace(/\s+/g, " ").trim().slice(0, 120))
      .optional()
      .describe("For flashcards and a quiz, the exam topic they are on; for a map, its title."),
    made_in_chat: z
      .boolean()
      .optional()
      .describe("For flashcards: true for the cards your tools created in this chat, instead of a topic's."),
  })
  .strict();

export const DELETE_DESCRIPTION = [
  "Proposes to delete flashcards Pyxis made (of a topic of this chat's exam, or the ones you created in this chat), a concept map of this chat's subject, or a quiz of this chat's exam that the student has not handed in. It deletes nothing by itself: the student sees what would go, counted by Pyxis, as a card in your answer, and deletes it or not.",
  "Call it only when the student asks to delete such a thing. Never call it on your own initiative, and never to make room for something new unless they asked.",
  "Nothing else can be deleted from the chat: not an exam, a source, a chat, a grade, a quiz already handed in, or the review history. Say so plainly when asked.",
  "One proposal of this kind per answer. After the call, say in one short sentence that you prepared it and that nothing is deleted until the student confirms on the card. Never say it is deleted: you will be told what the student chose in their next message.",
].join(" ");

type Cards = {
  kind: "flashcards";
  /** The exam topic, or null for the cards this chat made. */
  planId: string | null;
  topicId: string | null;
  name: string | null;
  place: string;
  cardIds: string[];
  handMade: number;
  others: number;
};
type MapTarget = { kind: "map"; subjectId: string; mapId: string; name: string; place: string; concepts: number };
type QuizTarget = { kind: "quiz"; planId: string; itemId: string; attemptId: string; name: string | null; place: string; count: number };

export type DeleteProposal = Cards | MapTarget | QuizTarget;

type DeleteOutcome = { cards: string[] } | { map: StoredMap; schema: number } | { quiz: QuizUndone };

const TOOL = DELETE_TOOL;

/** Cards Pyxis made, still in the deck, of the topic or of this chat's results: the ones a deletion would take. */
function seededCards(db: Database.Database, chatId: string, target: Pick<Cards, "topicId" | "planId">): string[] {
  if (target.topicId)
    return db
      .prepare("SELECT id FROM cards WHERE topic_id = ? AND removed = 0 AND seed_key IS NOT NULL ORDER BY id")
      .pluck()
      .all(target.topicId) as string[];
  const made = (
    db
      .prepare(`SELECT data_json FROM chat_tool_results WHERE chat_id = ? AND tool = 'create_flashcards' AND undone_json IS NULL`)
      .pluck()
      .all(chatId) as string[]
  ).flatMap((json) => (JSON.parse(json) as { cardIds: string[] }).cardIds);
  return db
    .prepare("SELECT id FROM cards WHERE id IN (SELECT value FROM json_each(?)) AND removed = 0 AND seed_key IS NOT NULL ORDER BY id")
    .pluck()
    .all(JSON.stringify(made)) as string[];
}

const reviewedOf = (db: Database.Database, ids: readonly string[]) =>
  db
    .prepare("SELECT count(DISTINCT card_id) FROM card_reviews WHERE card_id IN (SELECT value FROM json_each(?))")
    .pluck()
    .get(JSON.stringify(ids)) as number;

/** The chat this proposal was made in, kept beside it, since cards "made in this chat" are found by it. */
type Stored = DeleteProposal & { chatId: string };

function fingerprint(db: Database.Database, stored: Stored): string | null {
  if (stored.kind === "flashcards") {
    const ids = seededCards(db, stored.chatId, stored);
    return digest({ ids, reviewed: reviewedOf(db, ids) });
  }
  if (stored.kind === "map") {
    if (!db.prepare("SELECT 1 FROM subjects WHERE id = ?").get(stored.subjectId)) return null;
    const map = readStoredMap(db, { subjectId: stored.subjectId }, stored.mapId);
    return map ? digest(map) : null;
  }
  const item = db.prepare("SELECT body_json FROM items WHERE id = ? AND plan_id = ?").get(stored.itemId, stored.planId) as
    | { body_json: string }
    | undefined;
  if (!item) return null;
  return digest({
    item: item.body_json,
    attempts: db.prepare("SELECT id, submitted_at FROM attempts WHERE item_id = ? ORDER BY id").all(stored.itemId),
    answers: db
      .prepare("SELECT count(*) FROM attempt_answers WHERE attempt_id IN (SELECT id FROM attempts WHERE item_id = ?)")
      .pluck()
      .get(stored.itemId),
    handedIn: handedIn(db, stored.itemId),
  });
}

/** The quiz's record as `undoQuiz` and `restoreQuiz` read it. */
const quizData = (target: QuizTarget): QuizData => ({
  planId: target.planId,
  exam: target.place,
  topic: target.name ?? "",
  topicId: null,
  attemptId: target.attemptId,
  itemId: target.itemId,
  count: target.count,
});

function subjectOf(db: Database.Database, where: ReturnType<ToolTurn["place"]>): { id: string; name: string } | null {
  if (where.planId) {
    const row = db
      .prepare(`SELECT s.id, s.name FROM plans p JOIN subjects s ON s.id = p.subject_id WHERE p.id = ?`)
      .get(where.planId) as { id: string; name: string } | undefined;
    if (row) return row;
  }
  if (!where.subject) return null;
  return (db.prepare(`SELECT id, name FROM subjects WHERE name = ? COLLATE NOCASE`).get(where.subject.trim()) as
    | { id: string; name: string }
    | undefined) ?? null;
}

const listOf = (titles: string[]) => titles.map((title) => `"${title}"`).join(", ");

/** What the model asked to delete, found and counted in the chat's place, or why nothing was proposed. */
function resolve(db: Database.Database, turn: ToolTurn, args: z.infer<typeof deleteInput>): DeleteProposal | { refused: string } {
  const where = turn.place();
  if (args.kind === "flashcards") {
    if (args.made_in_chat) {
      const cardIds = seededCards(db, turn.chatId, { topicId: null, planId: null });
      if (cardIds.length === 0) return { refused: "No flashcard your tools created in this chat is still in the deck, so nothing was proposed. Tell the student in one sentence." };
      const exam = where.planId ? (db.prepare("SELECT title FROM plans WHERE id = ?").pluck().get(where.planId) as string | undefined) : undefined;
      return { kind: "flashcards", planId: null, topicId: null, name: null, place: exam ?? where.subject ?? "", cardIds, handMade: 0, others: 0 };
    }
    if (!args.topic) return { refused: "Name the topic whose flashcards to delete (`topic`), or set `made_in_chat`. Nothing was proposed." };
    const exam = chatExam(db, where);
    if ("refused" in exam) return exam;
    const topic = quizTopic(db, exam.id, args.topic);
    if (!topic) {
      const titles = db.prepare("SELECT title FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position").pluck().all(exam.id) as string[];
      return { refused: `No topic of ${exam.title} matches "${args.topic}", so nothing was proposed. Its topics are: ${listOf(titles)}.` };
    }
    const cardIds = seededCards(db, turn.chatId, { topicId: topic.id, planId: exam.id });
    const handMade = db.prepare("SELECT count(*) FROM cards WHERE topic_id = ? AND removed = 0 AND seed_key IS NULL").pluck().get(topic.id) as number;
    if (cardIds.length === 0)
      return {
        refused: handMade
          ? `The flashcards of ${topic.title} were all written by the student, and Pyxis deletes only cards it made, so nothing was proposed. They can delete their own cards in Flashcard.`
          : `${topic.title} has no flashcards, so nothing was proposed. Tell the student in one sentence.`,
      };
    const others = db
      .prepare("SELECT count(*) FROM cards WHERE plan_id = ? AND removed = 0 AND (topic_id IS NULL OR topic_id != ?)")
      .pluck()
      .get(exam.id, topic.id) as number;
    return { kind: "flashcards", planId: exam.id, topicId: topic.id, name: topic.title, place: exam.title, cardIds, handMade, others };
  }
  if (args.kind === "map") {
    const subject = subjectOf(db, where);
    if (!subject) return { refused: "This chat has no subject, so there is no map to delete and nothing was proposed." };
    const maps = listMaps(db, { subjectId: subject.id });
    if (maps.length === 0) return { refused: `${subject.name} has no concept maps, so nothing was proposed.` };
    const map = args.topic ? matchTitle(maps, args.topic) : maps.length === 1 ? { ...maps[0]!, exact: true } : null;
    if (!map)
      return { refused: `No single map of ${subject.name} matches${args.topic ? ` "${args.topic}"` : ""}, so nothing was proposed. Its maps are: ${listOf(maps.map((entry) => entry.title))}.` };
    const stored = readStoredMap(db, { subjectId: subject.id }, map.id)!;
    return { kind: "map", subjectId: subject.id, mapId: map.id, name: map.title, place: subject.name, concepts: stored.graph.nodes.length };
  }
  const exam = chatExam(db, where);
  if ("refused" in exam) return exam;
  const open = unfinishedActivities(db, exam.id).flatMap((entry) => {
    if (entry.kind !== "quiz" || !entry.attemptId) return [];
    const itemId = db.prepare("SELECT item_id FROM attempts WHERE id = ?").pluck().get(entry.attemptId) as string | undefined;
    // A quiz with a grade is the student's, whichever attempt of it is open: it is never proposed.
    return itemId && !handedIn(db, itemId) ? [{ ...entry, itemId, title: entry.topicTitle ?? "" }] : [];
  });
  if (open.length === 0) return { refused: `${exam.title} has no quiz waiting to be handed in, so nothing was proposed. A quiz already handed in keeps its grade and cannot be deleted from the chat.` };
  const named = args.topic ? open.filter((entry) => entry.title && matchTitle([entry], args.topic!) !== null) : open;
  if (named.length !== 1)
    return {
      refused: `${named.length === 0 ? "No" : "More than one"} unfinished quiz of ${exam.title} matches${args.topic ? ` "${args.topic}"` : ""}, so nothing was proposed. The unfinished quizzes are on: ${listOf(open.map((entry) => entry.title || "the whole exam"))}. The student can also delete them from the exam's unfinished list.`,
    };
  const quiz = named[0]!;
  return { kind: "quiz", planId: exam.id, itemId: quiz.itemId, attemptId: quiz.attemptId!, name: quiz.topicTitle, place: exam.title, count: quiz.total };
}

function describe(proposal: DeleteProposal): string {
  if (proposal.kind === "flashcards")
    return `${proposal.cardIds.length} flashcard${proposal.cardIds.length === 1 ? "" : "s"} ${proposal.name ? `of ${proposal.name}` : "created in this chat"}, in ${proposal.place}`;
  if (proposal.kind === "map") return `the concept map "${proposal.name}" of ${proposal.place}`;
  return `the unfinished quiz ${proposal.name ? `on ${proposal.name}` : "on the whole exam"} of ${proposal.place}`;
}

export function deleteNote(view: DeleteProposalView): string {
  const what =
    view.kind === "flashcards"
      ? `deleting ${view.count} flashcard${view.count === 1 ? "" : "s"}${view.name ? ` of ${view.name}` : " created in this chat"}`
      : view.kind === "map"
        ? `deleting the concept map "${view.name}"`
        : `deleting the unfinished quiz${view.name ? ` on ${view.name}` : ""}`;
  if (view.state === "applied") return `[Pyxis tool ${TOOL}: you proposed ${what}; the student confirmed, and it is deleted.]`;
  if (view.state === "restored") return `[Pyxis tool ${TOOL}: you proposed ${what}; the student deleted it, then undid the deletion, so it is back.]`;
  if (view.state === "declined") return `[Pyxis tool ${TOOL}: you proposed ${what}; the student chose not to, so nothing was deleted.]`;
  if (view.state === "stale") return `[Pyxis tool ${TOOL}: you proposed ${what}; it changed before the student decided, so nothing was deleted.]`;
  if (view.state === "expired") return `[Pyxis tool ${TOOL}: you proposed ${what}; a later proposal replaced it, so nothing was deleted through it.]`;
  return `[Pyxis tool ${TOOL}: you proposed ${what}; it is shown to the student, who has not decided yet, and nothing is deleted.]`;
}

const kind: ProposalKind<Stored> = {
  tool: TOOL,
  fingerprint,
  apply(db, stored): DeleteOutcome {
    if (stored.kind === "flashcards") return { cards: removeCards(db, stored.cardIds) };
    if (stored.kind === "map") {
      const map = readStoredMap(db, { subjectId: stored.subjectId }, stored.mapId)!;
      deleteMap(db, { subjectId: stored.subjectId }, stored.mapId);
      return { map, schema: SCHEMA_VERSION };
    }
    return { quiz: undoQuiz(db, quizData(stored)) };
  },
  undo(db, stored, outcome) {
    const done = outcome as DeleteOutcome;
    if ("cards" in done) restoreCards(db, done.cards);
    else if ("map" in done) {
      if (stored.kind !== "map" || !db.prepare("SELECT 1 FROM subjects WHERE id = ?").get(stored.subjectId) || done.schema > SCHEMA_VERSION)
        throw new Error("tool-restore-gone");
      storeMap(db, { subjectId: stored.subjectId }, done.map);
    } else if (stored.kind === "quiz") restoreQuiz(db, quizData(stored), done.quiz);
  },
  view(db, base, stored, outcome): DeleteProposalView {
    const done = outcome as DeleteOutcome | null;
    const count =
      stored.kind === "flashcards" ? (done && "cards" in done ? done.cards.length : stored.cardIds.length) : stored.kind === "map" ? stored.concepts : stored.count;
    const answered =
      stored.kind === "quiz" && !done
        ? (unfinishedActivities(db, stored.planId).find((entry) => entry.attemptId === stored.attemptId)?.answered ?? 0)
        : 0;
    const restorable =
      stored.kind === "map"
        ? !!db.prepare("SELECT 1 FROM subjects WHERE id = ?").get(stored.subjectId)
        : stored.kind === "quiz"
          ? !!db.prepare("SELECT 1 FROM plans WHERE id = ?").get(stored.planId)
          : true;
    return {
      ...base,
      tool: TOOL,
      kind: stored.kind,
      name: stored.name,
      place: stored.place,
      count,
      reviewed: stored.kind === "flashcards" ? reviewedOf(db, stored.cardIds) : 0,
      handMade: stored.kind === "flashcards" ? stored.handMade : 0,
      others: stored.kind === "flashcards" ? stored.others : 0,
      answered,
      restorable,
    };
  },
};
registerProposalKind(kind);

export function proposeDeleteTool(db: Database.Database): Tool {
  return {
    name: TOOL,
    description: DELETE_DESCRIPTION,
    input: deleteInput,
    run(turn, raw) {
      const args = raw as z.infer<typeof deleteInput>;
      if ((turn.tally[TOOL] ?? 0) >= 1)
        return {
          isError: true,
          text: "This answer already proposed a deletion, and one answer may propose one. Nothing more was proposed: the student can ask in their next message.",
        };
      const found = resolve(db, turn, args);
      if ("refused" in found) return { isError: true, text: found.refused };
      turn.tally[TOOL] = 1;
      const stored: Stored = { ...found, chatId: turn.chatId };
      const resultId = storeProposal(db, turn.chatId, TOOL, stored, fingerprint(db, stored)!);
      return {
        text: `Shown to the student as a card to confirm: deleting ${describe(found)}. They have not decided yet, and nothing is deleted. In one short sentence say what you prepared and that nothing is deleted until they confirm on the card; never say it is deleted.`,
        shown: { resultId },
      };
    },
  };
}
