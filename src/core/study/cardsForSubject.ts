import type Database from "better-sqlite3";
import { z } from "zod";
import { IpcError } from "../../shared/ipc";
import { NEW_CARDS } from "../../shared/limits";
import { generate, type GenerateInput } from "../engine/generate";
import { planLanguage, systemPrompt } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import { spread, subjectPassages, subjectSourceIds, SUBJECT_MAP } from "../maps/subject-sources";
import { interestsLine } from "../profile/context";
import { retrieveWithModel } from "../sources/retrieve";
import { cardIssues, cardOf, faces, norm } from "./cardsFromBook";
import type { ProposedCard } from "./cardsFromText";
import { requireTopic } from "./openLesson";

const TEMPLATE = "cards.subject";
/** Fronts the subject has already, sent so the model writes new ones; the newest first, at most this many. */
const AVOID_MAX = 80;
/** Passages a request reads: as many as a whole-subject map, each cut as short. */
const PASSAGES = SUBJECT_MAP.passages;
const PASSAGE_CHARS = SUBJECT_MAP.chars;

export type NewCardPlaces = {
  /** Every subject, in the student's order, with its exams and the topics a Pyxis request can aim at. */
  subjects: Array<{
    id: string;
    name: string;
    exams: Array<{ id: string; title: string }>;
    /** Topics by exam, each exam with at least one topic. */
    topics: Array<{ planId: string; planTitle: string; topics: Array<{ id: string; title: string }> }>;
    /** Readable sources Pyxis can write the subject's flashcards from. */
    sources: number;
  }>;
  /** False when no AI tool is set up for flashcards, so only writing them by hand works. */
  engine: boolean;
};

/** What the new-flashcard dialog offers: the subjects, their exams and topics, their material, and whether an AI tool can write. */
export function newCardPlaces(db: Database.Database): NewCardPlaces {
  const subjects = db
    .prepare(`SELECT id, name FROM subjects ORDER BY position, name COLLATE NOCASE, id`)
    .all() as Array<{ id: string; name: string }>;
  // Archived exams are left out, as in the new-map dialog.
  const exams = db
    .prepare(
      `SELECT id, title, subject_id FROM plans WHERE subject_id IS NOT NULL AND archived_at IS NULL
       ORDER BY updated_at DESC, id`,
    )
    .all() as Array<{ id: string; title: string; subject_id: string }>;
  const topics = db
    .prepare(
      `SELECT t.id, t.title, t.plan_id FROM topics t JOIN plans p ON p.id = t.plan_id
       WHERE t.archived_at IS NULL AND p.archived_at IS NULL AND p.subject_id IS NOT NULL
       ORDER BY t.position, t.created_at, t.id`,
    )
    .all() as Array<{ id: string; title: string; plan_id: string }>;
  let engine = true;
  try {
    selectionFor(db, "cards");
  } catch {
    engine = false;
  }
  return {
    subjects: subjects.map((subject) => {
      const own = exams.filter((exam) => exam.subject_id === subject.id);
      return {
        ...subject,
        exams: own.map(({ id, title }) => ({ id, title })),
        topics: own.flatMap((exam) => {
          const list = topics.filter((topic) => topic.plan_id === exam.id).map(({ id, title }) => ({ id, title }));
          return list.length ? [{ planId: exam.id, planTitle: exam.title, topics: list }] : [];
        }),
        sources: subjectSourceIds(db, subject.id).length,
      };
    }),
    engine,
  };
}

export type SubjectCardsInput = {
  subjectId: string;
  /** One topic of one of the subject's exams; without it the whole subject. */
  planId?: string;
  topicId?: string;
  /** "Su cosa?": what the student wants the flashcards about. */
  focus?: string;
  count: number;
};

type Passage = { id: string; text: string; section: string };

/**
 * The passages a request is written from. A topic reads its own passages, a subject the sources a whole-subject map
 * reads. With a focus, the retrieval that grounds a chat answer ranks them by it, and a focus that matches nothing in the
 * material is refused rather than answered from general knowledge. Without one, they are taken evenly across the material.
 */
async function passagesFor(
  db: Database.Database,
  input: SubjectCardsInput,
  signal?: AbortSignal,
): Promise<Passage[]> {
  const cut = (row: { id: string; text: string; section: string }) => ({ ...row, text: row.text.slice(0, PASSAGE_CHARS) });
  if (input.topicId) {
    const rows = db
      .prepare(
        `SELECT p.id, p.text, p.source_id, COALESCE(s.title || COALESCE(' › ' || p.section_path, ''), '') AS section
         FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id JOIN sources s ON s.id = p.source_id
         WHERE tp.topic_id = ? AND s.status != 'removed' ORDER BY p.created_at, p.id`,
      )
      .all(input.topicId) as Array<{ id: string; text: string; source_id: string; section: string }>;
    if (!rows.length) throw new IpcError("cards-no-material", "flashcards.new.errors.noTopicMaterial");
    if (!input.focus) return spread(rows, PASSAGES).map(cut);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const found = await retrieveWithModel(db, input.focus, {
      sourceIds: [...new Set(rows.map((row) => row.source_id))],
      limit: 200,
      signal,
    });
    const hits = found.hits.flatMap((hit) => (byId.has(hit.id) ? [byId.get(hit.id)!] : [])).slice(0, PASSAGES);
    if (!hits.length) throw new IpcError("cards-nothing-matched", "flashcards.new.errors.nothingMatched");
    return hits.map(cut);
  }
  const sourceIds = subjectSourceIds(db, input.subjectId);
  if (!sourceIds.length) throw new IpcError("cards-no-material", "flashcards.new.errors.noMaterial");
  if (!input.focus) return subjectPassages(db, input.subjectId);
  const found = await retrieveWithModel(db, input.focus, { sourceIds, limit: PASSAGES, signal });
  if (!found.hits.length) throw new IpcError("cards-nothing-matched", "flashcards.new.errors.nothingMatched");
  const titles = new Map(
    (
      db
        .prepare(`SELECT id, title FROM sources WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(sourceIds)) as Array<{ id: string; title: string }>
    ).map((row) => [row.id, row.title]),
  );
  return found.hits.map((hit) =>
    cut({
      id: hit.id,
      text: hit.text,
      section: [titles.get(hit.sourceId), hit.sectionPath].filter(Boolean).join(" › "),
    }),
  );
}

/** The fronts the subject's flashcards have already, compared as the saved ones are (case and spacing ignored). */
function subjectFronts(db: Database.Database, subjectId: string): string[] {
  return db
    .prepare(`SELECT front FROM cards WHERE subject_id = ? AND removed = 0 ORDER BY created_at DESC`)
    .pluck()
    .all(subjectId) as string[];
}

/**
 * Flashcards Pyxis proposes for a subject, or one topic of it, from the subject's own material, steered by what the
 * student asked for. Nothing is stored: the student checks them and saves them with `saveProposedCards`. Every card names
 * the passage that states its fact. A front the subject has already is dropped, and `repeats` says how many were.
 */
export async function proposeSubjectCards(
  db: Database.Database,
  input: SubjectCardsInput,
  run?: GenerateInput["run"],
  signal?: AbortSignal,
): Promise<{ cards: ProposedCard[]; provider: string; model: string; repeats: number }> {
  const subject = db.prepare("SELECT name FROM subjects WHERE id = ?").pluck().get(input.subjectId) as
    | string
    | undefined;
  if (subject === undefined) throw new Error("subject-missing");
  let topic: string | undefined;
  if (input.topicId || input.planId) {
    requireTopic(db, input.planId ?? "", input.topicId ?? "");
    const row = db
      .prepare(`SELECT t.title, p.subject_id FROM topics t JOIN plans p ON p.id = t.plan_id WHERE t.id = ?`)
      .get(input.topicId) as { title: string; subject_id: string | null };
    if (row.subject_id !== input.subjectId) throw new Error("plan-not-in-subject");
    topic = row.title;
  }
  const count = Math.min(Math.max(Math.trunc(input.count), 1), NEW_CARDS.max);
  const focus = input.focus?.trim() || undefined;
  // The engine first, so a student with no AI tool is told that, and not that the material is missing.
  const selection = selectionFor(db, "cards");
  const passages = await passagesFor(db, { ...input, focus }, signal);
  const known = new Map(passages.map((row) => [row.id, row.text]));
  const existing = subjectFronts(db, input.subjectId);
  const schema = z
    .object({ cards: z.array(cardOf(z.string())).max(count) })
    .superRefine((value, ctx) => {
      const seen = new Set<string>();
      value.cards.forEach((row, i) => {
        const issue = (message: string) => ctx.addIssue({ code: "custom", message, path: ["cards", i] });
        if (!known.has(row.passageId)) issue("Unknown passage ID");
        for (const message of cardIssues(row, seen, known.get(row.passageId) ?? "", "passage")) issue(message);
      });
    });
  const result = await generate({
    selection,
    run,
    signal,
    schema,
    system: [
      systemPrompt(TEMPLATE, { contentLanguage: planLanguage(db, input.planId ?? "") }),
      interestsLine(db),
    ]
      .filter(Boolean)
      .join("\n"),
    prompt: JSON.stringify({
      subject,
      ...(topic ? { topic } : {}),
      ...(focus ? { focus } : {}),
      count,
      avoid: existing.slice(0, AVOID_MAX),
      passages,
    }),
  });
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const data = result.data as z.infer<typeof schema>;
  const present = new Set(existing.map(norm));
  const cards: ProposedCard[] = [];
  for (const row of data.cards) {
    const card = faces(row);
    if (present.has(norm(card.front))) continue;
    cards.push({ ...card, passageId: row.passageId });
  }
  if (!data.cards.length) throw new IpcError("cards-nothing-matched", "flashcards.new.errors.nothingMatched");
  // Every card repeats one the subject has: nothing to check, so the dialog gets a way out, not an empty list.
  if (!cards.length) throw new IpcError("cards-all-repeats", "flashcards.new.errors.allRepeats");
  return { cards, provider: result.provider, model: result.model, repeats: data.cards.length - cards.length };
}
