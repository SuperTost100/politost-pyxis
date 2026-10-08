import type Database from "better-sqlite3";
import { appendEvent } from "../events";
import { recordStep } from "../plans/steps";
import {
  finalRecap,
  parseSmartText,
  smartQuestions,
  type SmartSegment,
} from "../../shared/smart-text";

type SmartItem = {
  id: string;
  plan_id: string;
  topic_id: string | null;
  kind: "lesson" | "intro";
};

/** The student's saved pick for each answered question of one lesson or introduction, by question id. */
export function smartAnswers(
  db: Database.Database,
  itemId: string,
): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT payload_json FROM learning_events
       WHERE item_id = ? AND kind = 'answer_given' AND json_extract(payload_json, '$.evidenceKind') = 'check'
       ORDER BY created_at, id`,
    )
    .all(itemId) as Array<{ payload_json: string }>;
  const answers: Record<string, number> = {};
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as {
      blockId?: string;
      pick?: number;
    };
    if (payload.blockId && typeof payload.pick === "number" && !(payload.blockId in answers))
      answers[payload.blockId] = payload.pick;
  }
  return answers;
}

/**
 * The questions whose answers finish the reading: the closing recap of a lesson. An introduction has only quick
 * checks, so answering all of them finishes it. Without these the student finishes with "Mark as done".
 */
export function finishingQuestions(
  segments: SmartSegment[],
  kind: "lesson" | "intro",
): string[] {
  const recap = finalRecap(segments);
  if (recap) return recap.questions.map((question) => question.id);
  return kind === "intro" ? [...smartQuestions(segments).keys()] : [];
}

/** Records the lesson or the introduction as read on the path, whichever topic it is on. */
export function completeReading(
  db: Database.Database,
  planId: string,
  kind: "lesson" | "intro",
  topicId: string | null,
) {
  try {
    recordStep(db, planId, { activity: kind, topicId });
  } catch (err) {
    // A lesson on a topic archived since keeps its answers; there is no path step to add.
    if (!(err instanceof Error) || err.message !== "topic-missing") throw err;
  }
}

/**
 * Records one answer to a quick check or recap question. It counts as light mastery evidence for the lesson's topic,
 * and the first answer stays: answering again returns the saved result. Answering the last finishing question
 * completes the reading.
 */
export function answerSmartCheck(
  db: Database.Database,
  input: { planId: string; itemId: string; blockId: string; pick: number },
  now = Date.now(),
): { correct: boolean; pick: number; finished: boolean } {
  const item = db
    .prepare(
      `SELECT id, plan_id, topic_id, kind, body_json FROM items WHERE id = ? AND plan_id = ? AND kind IN ('lesson', 'intro')`,
    )
    .get(input.itemId, input.planId) as
    | (SmartItem & { body_json: string })
    | undefined;
  if (!item) throw new Error("item-missing");
  const segments = parseSmartText(
    (JSON.parse(item.body_json) as { markdown?: string }).markdown ?? "",
  );
  const question = smartQuestions(segments).get(input.blockId);
  if (!question || input.pick < 0 || input.pick >= question.options.length)
    throw new Error("question-missing");
  return db.transaction(() => {
    const saved = smartAnswers(db, item.id);
    const pick = saved[input.blockId] ?? input.pick;
    const correct = pick === question.answer;
    if (saved[input.blockId] === undefined) {
      appendEvent(db, {
        kind: "answer_given",
        planId: item.plan_id,
        topicId: item.topic_id,
        itemId: item.id,
        payload: {
          blockId: input.blockId,
          pick,
          score: correct ? 1 : 0,
          evidenceKind: "check",
        },
        at: now,
      });
      saved[input.blockId] = pick;
    }
    const finishing = finishingQuestions(segments, item.kind);
    const finished =
      finishing.includes(input.blockId) &&
      finishing.every((id) => saved[id] !== undefined);
    if (finished) completeReading(db, item.plan_id, item.kind, item.topic_id);
    return { correct, pick, finished };
  })();
}

/** The sources and places a lesson was given, for its "Sources used" footer: each place opens the source viewer. */
export function smartSources(db: Database.Database, passageIds: string[]) {
  if (!passageIds.length) return [];
  const rows = db
    .prepare(
      `SELECT p.id, p.source_id, p.locator_json, p.section_path, s.title
       FROM passages p JOIN sources s ON s.id = p.source_id
       WHERE p.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(passageIds)) as Array<{
    id: string;
    source_id: string;
    locator_json: string | null;
    section_path: string | null;
    title: string;
  }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const sources = new Map<
    string,
    {
      sourceId: string;
      title: string;
      places: Array<{
        passageId: string;
        page?: number;
        slide?: number;
        chapter?: number;
        section?: string;
      }>;
      seen: Set<string>;
    }
  >();
  for (const id of passageIds) {
    const row = byId.get(id);
    if (!row) continue;
    const locator = row.locator_json
      ? (JSON.parse(row.locator_json) as {
          page?: number;
          slide?: number;
          chapter?: number;
        })
      : {};
    // The coarsest place the reader can open: a page, a slide, a chapter, else the section heading.
    const place =
      locator.page != null
        ? { page: locator.page }
        : locator.slide != null
          ? { slide: locator.slide }
          : locator.chapter != null
            ? { chapter: locator.chapter }
            : row.section_path
              ? { section: row.section_path.slice(0, 120) }
              : {};
    const source = sources.get(row.source_id) ?? {
      sourceId: row.source_id,
      title: row.title,
      places: [],
      seen: new Set<string>(),
    };
    sources.set(row.source_id, source);
    const key = JSON.stringify(place);
    if (source.seen.has(key)) continue;
    source.seen.add(key);
    source.places.push({ passageId: row.id, ...place });
  }
  return [...sources.values()].map(({ seen: _seen, ...source }) => ({
    ...source,
    places: source.places.sort(
      (a, b) =>
        (a.page ?? a.slide ?? a.chapter ?? 0) -
        (b.page ?? b.slide ?? b.chapter ?? 0),
    ),
  }));
}
