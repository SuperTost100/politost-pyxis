import type Database from "better-sqlite3";
import { z } from "zod";
import { saveProposedCardIds } from "../study/cardsFromText";
import { addFlashcards, storeFlashcards } from "./results";
import type { Tool, ToolTurn } from "./server";

/** Cards one call may create. A longer list is refused whole, before anything is saved. */
export const CARDS_PER_CALL = 30;
/** Cards one reply may create over all its calls. */
export const CARDS_PER_TURN = 30;
/** Characters of a card's front and back, as the Flashcard editor's own limits allow with room to spare. */
const FRONT_MAX = 1000;
const BACK_MAX = 4000;
const TITLE_MAX = 80;

const oneLine = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform((text) => text.replace(/\s+/g, " ").trim().slice(0, max));

export const flashcardsInput = z
  .object({
    cards: z
      .array(
        z
          .object({
            front: z.string().trim().min(1).max(FRONT_MAX).describe("The question or prompt, in Markdown with LaTeX math."),
            back: z.string().trim().min(1).max(BACK_MAX).describe("The answer, in Markdown with LaTeX math."),
          })
          .strict(),
      )
      .min(1)
      .max(CARDS_PER_CALL),
    title: oneLine(TITLE_MAX)
      .optional()
      .describe('A few words in the student\'s language that complete "8 flashcards ...", such as "on Newton\'s laws".'),
  })
  .strict();

export const FLASHCARDS_DESCRIPTION = [
  "Adds flashcards to the student's deck in Pyxis, under the subject or exam of this chat.",
  "Call it only when the student asks for flashcards or accepts your offer to make them. Never call it on your own initiative or to answer a question.",
  "Write every card in the language of the conversation. Each card tests one thing: a definition, a law, a formula, a step or a typical mistake. `front` is a short question or prompt; `back` is the answer, short enough to recall (a formula or one to three sentences).",
  "Both are Markdown. Write math in LaTeX between $...$ (inline) or $$...$$ (display), as in your answers; no code blocks.",
  "Take the content from what the student asked about, the passages and the conversation, and do not repeat cards made earlier in this chat.",
  `Put all the cards of one request in a single call. At most ${CARDS_PER_CALL} cards per call and per answer: when the student asks for more, make ${CARDS_PER_TURN} and tell them they can ask for more in their next message.`,
  "Give `title` as a few words that complete \"N flashcards ...\" in the student's language, such as \"sui tre principi della dinamica\" or \"on Newton's laws\".",
  "The student sees the created cards in the chat: after the result, write one short sentence and do not list the cards again.",
].join(" ");

/** The chat's exam, or else its subject, as a place to file cards in, with the name the chat shows. Null for neither. */
function cardPlace(
  db: Database.Database,
  place: ReturnType<ToolTurn["place"]>,
): { planId: string; deck: string } | { subjectId: string; deck: string } | null {
  if (place.planId) {
    const plan = db.prepare(`SELECT title FROM plans WHERE id = ? AND archived_at IS NULL`).get(place.planId) as
      | { title: string }
      | undefined;
    if (plan) return { planId: place.planId, deck: plan.title };
  }
  if (place.subject) {
    const subject = db.prepare(`SELECT id, name FROM subjects WHERE name = ? COLLATE NOCASE`).get(place.subject.trim()) as
      | { id: string; name: string }
      | undefined;
    if (subject) return { subjectId: subject.id, deck: subject.name };
  }
  return null;
}

const TOOL_NAME = "create_flashcards";

export function flashcardsTool(db: Database.Database): Tool {
  return {
    name: TOOL_NAME,
    description: FLASHCARDS_DESCRIPTION,
    input: flashcardsInput,
    run(turn, raw) {
      const args = raw as z.infer<typeof flashcardsInput>;
      const used = turn.tally.cards ?? 0;
      if (used + args.cards.length > CARDS_PER_TURN)
        return {
          isError: true,
          text:
            used === 0
              ? `Too many cards: at most ${CARDS_PER_TURN} in one answer. Nothing was created.`
              : `This answer already created ${used} cards, and one answer may create at most ${CARDS_PER_TURN}. Nothing more was created: tell the student they can ask for more in their next message.`,
        };
      const where = cardPlace(db, turn.place());
      if (!where)
        return {
          isError: true,
          text: "This chat has no subject or exam, so the cards have nowhere to go and none was created. Tell the student to choose a subject for the chat (the subject button above the conversation) and ask again.",
        };
      const engine = turn.engine();
      turn.tally.cards = used + args.cards.length;
      const saved = db.transaction(() => {
        const result = saveProposedCardIds(db, {
          ...("planId" in where ? { planId: where.planId, topicId: null } : { subjectId: where.subjectId }),
          cards: args.cards.map((card) => ({ ...card, passageId: null })),
          provider: engine.provider,
          model: engine.model,
          prompt: "chat.tutor",
        });
        if (result.ids.length === 0) return { ...result, resultId: null };
        const fronts = (
          db
            .prepare(`SELECT front FROM cards WHERE id IN (SELECT value FROM json_each(?)) ORDER BY rowid LIMIT 3`)
            .all(JSON.stringify(result.ids)) as Array<{ front: string }>
        ).map((row) => row.front);
        // A model that splits one request over several calls still gets one card in the reply.
        const earlier = turn.kept[TOOL_NAME];
        if (earlier) {
          addFlashcards(db, turn.chatId, earlier, { cardIds: result.ids, duplicates: result.skipped, fronts });
          return { ...result, resultId: earlier };
        }
        const resultId = storeFlashcards(db, turn.chatId, {
          cardIds: result.ids,
          duplicates: result.skipped,
          title: args.title || null,
          deck: where.deck,
          fronts,
        });
        turn.kept[TOOL_NAME] = resultId;
        return { ...result, resultId };
      })();
      if (!saved.resultId)
        return {
          text: `All ${saved.skipped} cards were already in the deck of ${where.deck}, so none was added. Tell the student in one sentence.`,
        };
      const skipped = saved.skipped
        ? ` ${saved.skipped} ${saved.skipped === 1 ? "was" : "were"} already in the deck and skipped.`
        : "";
      return {
        text: `Created ${saved.saved} flashcard${saved.saved === 1 ? "" : "s"} in the deck of ${where.deck}.${skipped} The student sees them in the chat: write one short sentence and do not list them.`,
        shown: { resultId: saved.resultId },
      };
    },
  };
}
