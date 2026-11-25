import type Database from "better-sqlite3";
import { z } from "zod";
import type { DeleteProposalView } from "../../shared/ipc";
import { SCHEMA_VERSION } from "../db/migrate";
import { GIVEN_UP } from "../jobs/runner";
import { deleteMap, listMaps, readStoredMap, storeMap, type StoredMap } from "../maps/store";
import { unfinishedActivities } from "../plans/unfinished";
import { jobRow } from "./jobs";
import { chatExam } from "./proposePath";
import { digest, plainName, propose, ProposalStale, registerProposalKind, type ProposalContext, type ProposalKind } from "./proposals";
import { handedIn, matchTitle, quizTopic, restorableQuiz, restoreQuiz, undoQuiz, type QuizData, type QuizUndone } from "./quiz";
import type { Tool, ToolTurn } from "./server";

/**
 * `propose_delete`: the model proposes to delete something, and the student deletes it or not (`proposals.ts`). Only
 * what the chat's tools can also create may be proposed, and only in the chat's exam or subject: flashcards Pyxis made
 * (of an exam's topic, or those this chat's tools created), a concept map of the subject, or a quiz of the exam that was
 * not handed in. Never an exam, a source, a chat, a grade, or anything of the review history. What goes is found and
 * counted by the app.
 *
 * Every deletion can be undone from the chat, and the card says so instead of "it cannot be undone":
 * - flashcards leave the deck by their own soft delete, which keeps their reviews, marked with this proposal
 *   (`cards.removed_by`): «Annulla» brings back only cards this deletion removed and nobody restored or removed again
 *   since, and says how many. The cards the student wrote are never proposed, since deleting one deletes it for good;
 * - a map leaves Mappe whole, edits included, into the result's record, as «Annulla» on a map the chat made does, and
 *   comes back only while no map holds its id;
 * - a quiz leaves the exam with the answers given so far, into the result's record (`undoQuiz`), and comes back while
 *   its exam and its build can (`restorableQuiz`); a quiz with a grade is refused by `undoQuiz` itself.
 * A map's or a quiz's record lives with the chat's result row, so the outcome line says the undo is there while the chat is.
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

/** The most cards one deletion may take; more are deleted in Flashcard, where the student sees them. */
export const CARDS_PER_DELETION = 200;

type Cards = {
  kind: "flashcards";
  /** The exam and topic, or null for the cards this chat made. */
  planId: string | null;
  topicId: string | null;
  /** For the cards this chat made: the chat's exam or subject they are limited to. */
  scope: { planId: string } | { subjectId: string } | null;
  name: string | null;
  place: string;
  cardIds: string[];
  /** The cards' text, so an edit since makes the card stale. */
  contents: string;
  reviewed: number;
  handMade: number;
  others: number;
};
type MapTarget = { kind: "map"; subjectId: string; mapId: string; name: string; place: string; concepts: number; contents: string };
type QuizTarget = {
  kind: "quiz";
  planId: string;
  itemId: string;
  attemptId: string;
  name: string | null;
  place: string;
  count: number;
  answered: number;
  /** The quiz's questions, attempts and every answer given, with their contents. */
  contents: string;
};

export type DeleteProposal = Cards | MapTarget | QuizTarget;
export type DeleteRequest = z.infer<typeof deleteInput>;

type DeleteOutcome = { cards: string[] } | { map: StoredMap; schema: number } | { quiz: QuizUndone };

const TOOL = DELETE_TOOL;

const reviewedOf = (db: Database.Database, ids: readonly string[]) =>
  db
    .prepare("SELECT count(DISTINCT card_id) FROM card_reviews WHERE card_id IN (SELECT value FROM json_each(?))")
    .pluck()
    .get(JSON.stringify(ids)) as number;

const textOf = (db: Database.Database, ids: readonly string[]) =>
  digest(db.prepare("SELECT id, front, back FROM cards WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id").all(JSON.stringify(ids)));

/** The map as Mappe holds it now, or undefined once it is gone, with its subject or alone. */
function mapNow(db: Database.Database, subjectId: string, mapId: string): StoredMap | undefined {
  if (!db.prepare("SELECT 1 FROM subjects WHERE id = ?").get(subjectId)) return undefined;
  return listMaps(db, { subjectId }).some((map) => map.id === mapId) ? readStoredMap(db, { subjectId }, mapId) : undefined;
}

/** The cards of an exam topic that a deletion leaves: the ones the student wrote, and the exam's others. */
function stays(db: Database.Database, planId: string, topicId: string): { handMade: number; others: number } {
  return {
    handMade: db.prepare("SELECT count(*) FROM cards WHERE topic_id = ? AND removed = 0 AND seed_key IS NULL").pluck().get(topicId) as number,
    others: db
      .prepare("SELECT count(*) FROM cards WHERE plan_id = ? AND removed = 0 AND (topic_id IS NULL OR topic_id != ?)")
      .pluck()
      .get(planId, topicId) as number,
  };
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

function quizContents(db: Database.Database, itemId: string): string {
  return digest({
    item: db.prepare("SELECT body_json FROM items WHERE id = ?").pluck().get(itemId),
    attempts: db.prepare("SELECT id, submitted_at FROM attempts WHERE item_id = ? ORDER BY id").all(itemId),
    answers: db
      .prepare("SELECT id, attempt_id, payload_json, created_at FROM attempt_answers WHERE attempt_id IN (SELECT id FROM attempts WHERE item_id = ?) ORDER BY id")
      .all(itemId),
    grading: db
      .prepare("SELECT count(*) FROM jobs WHERE kind = 'quiz-grade' AND json_extract(params_json, '$.attemptId') IN (SELECT id FROM attempts WHERE item_id = ?)")
      .pluck()
      .get(itemId),
  });
}

/** The chat's subject: its exam's, else its own by name. */
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

const tooMany = (count: number) => ({
  refused: `That is ${count} flashcards, more than the ${CARDS_PER_DELETION} one deletion from the chat may take, so nothing was proposed. Tell the student to delete them in Flashcard, where they can see them.`,
});

/** What a deletion request means now, in the chat's place: what would go, counted, or why nothing can. */
function resolve(db: Database.Database, args: DeleteRequest, ctx: Omit<ProposalContext, "resultId">): DeleteProposal | { refused: string } {
  const where = ctx.place;
  if (args.kind === "flashcards") {
    if (args.made_in_chat) {
      // Only the cards in the chat's exam or subject now: a chat moved to another subject does not reach its old deck.
      const exam = where.planId ? chatExam(db, where) : null;
      if (exam && "refused" in exam) return exam;
      const subject = exam ? null : subjectOf(db, where);
      if (!exam && !subject) return { refused: "This chat has no exam or subject, so its cards cannot be found and nothing was proposed." };
      const made = (
        db
          .prepare(`SELECT data_json FROM chat_tool_results WHERE chat_id = ? AND tool = 'create_flashcards' AND undone_json IS NULL`)
          .pluck()
          .all(ctx.chatId) as string[]
      ).flatMap((json) => (JSON.parse(json) as { cardIds: string[] }).cardIds);
      const cardIds = db
        .prepare(
          `SELECT id FROM cards WHERE id IN (SELECT value FROM json_each(?)) AND removed = 0 AND seed_key IS NOT NULL
             AND ${exam ? "plan_id = ?" : "subject_id = ?"} ORDER BY id`,
        )
        .pluck()
        .all(JSON.stringify(made), exam ? exam.id : subject!.id) as string[];
      if (cardIds.length === 0) return { refused: "No flashcard your tools created in this chat is still in its deck, so nothing was proposed. Tell the student in one sentence." };
      if (cardIds.length > CARDS_PER_DELETION) return tooMany(cardIds.length);
      return {
        kind: "flashcards",
        planId: null,
        topicId: null,
        scope: exam ? { planId: exam.id } : { subjectId: subject!.id },
        name: null,
        place: plainName(exam ? exam.title : subject!.name),
        cardIds,
        contents: textOf(db, cardIds),
        reviewed: reviewedOf(db, cardIds),
        handMade: 0,
        others: 0,
      };
    }
    if (!args.topic) return { refused: "Name the topic whose flashcards to delete (`topic`), or set `made_in_chat`. Nothing was proposed." };
    const exam = chatExam(db, where);
    if ("refused" in exam) return exam;
    const topic = quizTopic(db, exam.id, args.topic);
    if (!topic) {
      const titles = db.prepare("SELECT title FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position").pluck().all(exam.id) as string[];
      return { refused: `No topic of ${exam.title} matches "${args.topic}", so nothing was proposed. Its topics are: ${listOf(titles)}.` };
    }
    const cardIds = db
      .prepare("SELECT id FROM cards WHERE topic_id = ? AND removed = 0 AND seed_key IS NOT NULL ORDER BY id")
      .pluck()
      .all(topic.id) as string[];
    const { handMade, others } = stays(db, exam.id, topic.id);
    if (cardIds.length === 0)
      return {
        refused: handMade
          ? `The flashcards of ${topic.title} were all written by the student, and Pyxis deletes only cards it made, so nothing was proposed. They can delete their own cards in Flashcard.`
          : `${topic.title} has no flashcards, so nothing was proposed. Tell the student in one sentence.`,
      };
    if (cardIds.length > CARDS_PER_DELETION) return tooMany(cardIds.length);
    return {
      kind: "flashcards",
      planId: exam.id,
      topicId: topic.id,
      scope: null,
      name: plainName(topic.title),
      place: plainName(exam.title),
      cardIds,
      contents: textOf(db, cardIds),
      reviewed: reviewedOf(db, cardIds),
      handMade,
      others,
    };
  }
  if (args.kind === "map") {
    if (where.planId) {
      const exam = chatExam(db, where);
      if ("refused" in exam) return exam;
    }
    const subject = subjectOf(db, where);
    if (!subject) return { refused: "This chat has no subject, so there is no map to delete and nothing was proposed." };
    const maps = listMaps(db, { subjectId: subject.id });
    if (maps.length === 0) return { refused: `${subject.name} has no concept maps, so nothing was proposed.` };
    const twins = args.topic ? maps.filter((entry) => matchTitle([entry], args.topic!)?.exact) : [];
    if (twins.length > 1)
      return {
        refused: `${twins.length} maps of ${subject.name} are called "${twins[0]!.title}", so nothing was proposed: the title does not say which one. Tell the student to delete the one they mean in Mappe, where they can see them.`,
      };
    const map = args.topic ? matchTitle(maps, args.topic) : maps.length === 1 ? { ...maps[0]!, exact: true } : null;
    if (!map)
      return { refused: `No single map of ${subject.name} matches${args.topic ? ` "${args.topic}"` : ""}, so nothing was proposed. Its maps are: ${listOf(maps.map((entry) => entry.title))}.` };
    const stored = mapNow(db, subject.id, map.id);
    if (!stored) return { refused: "That map is no longer in Mappe, so nothing was proposed." };
    return {
      kind: "map",
      subjectId: subject.id,
      mapId: map.id,
      name: plainName(map.title),
      place: plainName(subject.name),
      concepts: stored.graph.nodes.length,
      contents: digest(stored),
    };
  }
  const exam = chatExam(db, where);
  if ("refused" in exam) return exam;
  const open = unfinishedActivities(db, exam.id, ctx.now).flatMap((entry) => {
    if (entry.kind !== "quiz" || !entry.attemptId) return [];
    const itemId = db.prepare("SELECT item_id FROM attempts WHERE id = ?").pluck().get(entry.attemptId) as string | undefined;
    // A quiz with a grade is the student's, whichever attempt of it is open: it is never proposed.
    return itemId && !handedIn(db, itemId) ? [{ ...entry, itemId, title: entry.topicTitle ?? "" }] : [];
  });
  if (open.length === 0) return { refused: `${exam.title} has no quiz waiting to be handed in, so nothing was proposed. A quiz already handed in keeps its grade and cannot be deleted from the chat.` };
  // A quiz whose topic is the words exactly comes before ones whose topic only holds them (`matchTitle`).
  const titled = open.filter((entry) => entry.title);
  const exact = args.topic ? titled.filter((entry) => matchTitle([entry], args.topic!)?.exact) : [];
  const named = !args.topic ? open : exact.length ? exact : titled.filter((entry) => matchTitle([entry], args.topic!) !== null);
  if (named.length !== 1)
    return {
      refused: `${named.length === 0 ? "No" : "More than one"} unfinished quiz of ${exam.title} matches${args.topic ? ` "${args.topic}"` : ""}, so nothing was proposed. The unfinished quizzes are on: ${listOf(open.map((entry) => entry.title || "the whole exam"))}. The student can also delete them from the exam's unfinished list.`,
    };
  const quiz = named[0]!;
  return {
    kind: "quiz",
    planId: exam.id,
    itemId: quiz.itemId,
    attemptId: quiz.attemptId!,
    name: quiz.topicTitle === null ? null : plainName(quiz.topicTitle),
    place: plainName(exam.title),
    count: quiz.total,
    answered: quiz.answered,
    contents: quizContents(db, quiz.itemId),
  };
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

/** Whether «Annulla» can still bring back what the deletion took. */
function restorable(db: Database.Database, action: DeleteProposal, outcome: DeleteOutcome, resultId: string): boolean {
  if ("cards" in outcome)
    return !!db
      .prepare("SELECT 1 FROM cards WHERE removed_by = ? AND removed = 1 AND id IN (SELECT value FROM json_each(?)) LIMIT 1")
      .get(resultId, JSON.stringify(outcome.cards));
  if ("map" in outcome)
    return action.kind === "map" && outcome.schema <= SCHEMA_VERSION && !!db.prepare("SELECT 1 FROM subjects WHERE id = ?").get(action.subjectId) && !mapNow(db, action.subjectId, action.mapId);
  if (action.kind !== "quiz" || !restorableQuiz(db, quizData(action), outcome.quiz)) return false;
  // A build stopped by the deletion goes on when it comes back: a build given up for good since cannot.
  const stopped = outcome.quiz.stopped ? jobRow(db, outcome.quiz.stopped) : null;
  return !outcome.quiz.stopped || (!!stopped && stopped.dismissed !== GIVEN_UP);
}

const kind: ProposalKind<DeleteRequest, DeleteProposal> = {
  tool: TOOL,
  resolve,
  apply(db, action, ctx): DeleteOutcome {
    if (action.kind === "flashcards") {
      // The exact cards resolved a moment ago, marked as this proposal's removal, so its undo can tell them apart.
      const remove = db.prepare("UPDATE cards SET removed = 1, removed_by = ? WHERE id = ? AND removed = 0 AND seed_key IS NOT NULL");
      const removed = action.cardIds.filter((id) => remove.run(ctx.resultId, id).changes > 0);
      if (removed.length !== action.cardIds.length) throw new ProposalStale();
      return { cards: removed };
    }
    if (action.kind === "map") {
      const map = mapNow(db, action.subjectId, action.mapId);
      if (!map) throw new ProposalStale();
      deleteMap(db, { subjectId: action.subjectId }, action.mapId);
      return { map, schema: SCHEMA_VERSION };
    }
    if (handedIn(db, action.itemId) || !db.prepare("SELECT 1 FROM items WHERE id = ? AND plan_id = ?").get(action.itemId, action.planId))
      throw new ProposalStale();
    return { quiz: undoQuiz(db, quizData(action)) };
  },
  undo(db, action, outcome, ctx) {
    const done = outcome as DeleteOutcome;
    if (!restorable(db, action, done, ctx.resultId)) throw new ProposalStale();
    if ("cards" in done) {
      // Only the cards this deletion removed and nobody restored or removed again since (`removed_by`).
      const back = db
        .prepare("UPDATE cards SET removed = 0, removed_by = NULL WHERE removed = 1 AND removed_by = ? AND id IN (SELECT value FROM json_each(?))")
        .run(ctx.resultId, JSON.stringify(done.cards)).changes;
      return { back };
    }
    if ("map" in done) {
      storeMap(db, { subjectId: (action as MapTarget).subjectId }, done.map);
      return { back: 1 };
    }
    try {
      restoreQuiz(db, quizData(action as QuizTarget), done.quiz);
    } catch (err) {
      if (err instanceof Error && ["tool-restore-gone", "tool-busy", "tool-result-missing"].includes(err.message)) throw new ProposalStale();
      throw err;
    }
    return { back: 1 };
  },
  view(db, base, action, decision): DeleteProposalView {
    const outcome = decision?.state === "applied" ? (decision.outcome as DeleteOutcome) : null;
    const count =
      action.kind === "flashcards" ? (outcome && "cards" in outcome ? outcome.cards.length : action.cardIds.length) : action.kind === "map" ? action.concepts : action.count;
    const restored = decision?.state === "applied" ? (decision.restored as { back: number } | undefined) : undefined;
    return {
      ...base,
      tool: TOOL,
      kind: action.kind,
      name: action.name,
      place: action.place,
      count,
      reviewed: action.kind === "flashcards" ? action.reviewed : 0,
      handMade: action.kind === "flashcards" ? action.handMade : 0,
      others: action.kind === "flashcards" ? action.others : 0,
      answered: action.kind === "quiz" ? action.answered : 0,
      restorable: outcome ? restorable(db, action, outcome, base.id) : true,
      back: restored ? restored.back : null,
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
      if ((turn.tally[TOOL] ?? 0) >= 1)
        return {
          isError: true,
          text: "This answer already proposed a deletion, and one answer may propose one. Nothing more was proposed: the student can ask in their next message.",
        };
      const made = propose<DeleteRequest, DeleteProposal>(db, turn, TOOL, raw as DeleteRequest);
      if ("refused" in made) return { isError: true, text: made.refused };
      turn.tally[TOOL] = 1;
      return {
        text: `Shown to the student as a card to confirm: deleting ${describe(made.action)}. They have not decided yet, and nothing is deleted. In one short sentence say what you prepared and that nothing is deleted until they confirm on the card; never say it is deleted.`,
        shown: { resultId: made.resultId },
      };
    },
  };
}
