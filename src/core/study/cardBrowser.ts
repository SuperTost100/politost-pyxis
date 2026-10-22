import type Database from "better-sqlite3";
import { foldText } from "../../shared/fold-text";
import { clozeAnswer } from "./cloze";
import type { ScheduleState } from "./schedule";

export type CardStatus = "all" | "due" | "suspended" | "removed" | "leech";

/** A card forgotten this many times (FSRS lapses) is a leech: the browser marks it and offers to rewrite or suspend it. */
const leechLapses = 6;

export type BrowsedCard = {
  id: string;
  front: string;
  back: string;
  planId: string;
  planTitle: string;
  topicId: string | null;
  topicTitle: string | null;
  subjectId: string | null;
  subjectName: string | null;
  suspended: boolean;
  removed: boolean;
  /** Written by the student rather than seeded from a source. Deleting one is permanent. */
  handMade: boolean;
  /** `new` has never been rated; `due` is ready now; `scheduled` waits for `dueAt`. */
  state: "new" | "due" | "scheduled";
  dueAt: number | null;
  /** Times the student forgot the card after learning it (FSRS lapses). */
  lapses: number;
  leech: boolean;
  /** The source passage the card was written from, to open it. */
  passageId: string | null;
  sourceId: string | null;
};

export type BrowseResult = {
  /** Cards matching every filter, before paging. */
  total: number;
  /** One page, in subject order. */
  cards: BrowsedCard[];
  /** Matches per subject across all pages, in display order; `subjectId: null` is "No subject". */
  groups: Array<{
    subjectId: string | null;
    subject: string | null;
    count: number;
  }>;
  /** Exams (in subject order) and topics that hold cards, for the filters. Not narrowed by the search or the filters. */
  plans: Array<{
    id: string;
    title: string;
    subjectId: string | null;
    subject: string | null;
  }>;
  topics: Array<{ id: string; planId: string; title: string }>;
};

type Row = {
  id: string;
  front: string;
  back: string;
  plan_id: string;
  plan_title: string;
  topic_id: string | null;
  topic_title: string | null;
  subject_id: string | null;
  subject_name: string | null;
  suspended: number;
  removed: number;
  seed_key: string | null;
  passage_id: string | null;
  source_id: string | null;
  state_json: string | null;
};

export { foldText };

/** What a student can read on the card, without cloze markup or emphasis marks. */
function searchable(front: string, back: string): string {
  return foldText(`${clozeAnswer(front)}\n${back}`).replaceAll("**", "");
}

/** Folds the text of cards that are new or changed since the last search (`search_text` is NULL for them). */
function fillSearchText(db: Database.Database): void {
  const pending = db
    .prepare(`SELECT id, front, back FROM cards WHERE search_text IS NULL`)
    .all() as Array<{ id: string; front: string; back: string }>;
  if (!pending.length) return;
  const store = db.prepare(`UPDATE cards SET search_text = ? WHERE id = ?`);
  db.transaction(() => {
    for (const card of pending)
      store.run(searchable(card.front, card.back), card.id);
  })();
}

const PAGE_MAX = 100;

/**
 * Cards across every exam, grouped by subject and ordered subject, exam, topic, creation.
 * Cards of an archived topic stay out, as in the review queue. Every word of the search has to
 * appear in the front or the back, compared on the folded copy in `cards.search_text`.
 */
export function browseCards(
  db: Database.Database,
  input: {
    query?: string;
    planId?: string;
    topicId?: string;
    status?: CardStatus;
    offset?: number;
    limit?: number;
  },
  now: number,
): BrowseResult {
  const status = input.status ?? "all";
  const words = foldText(input.query ?? "")
    .split(/\s+/)
    .filter(Boolean);
  fillSearchText(db);
  const rows = db
    .prepare(
      `SELECT c.id, c.front, c.back, c.plan_id, p.title AS plan_title,
        c.topic_id, t.title AS topic_title, s.id AS subject_id, s.name AS subject_name,
        c.suspended, c.removed, c.seed_key, c.passage_id,
        (SELECT ps.source_id FROM passages ps WHERE ps.id = c.passage_id) AS source_id,
        (SELECT cr.state_json FROM card_reviews cr
         WHERE cr.card_id = c.id ORDER BY cr.reviewed_at DESC, cr.rowid DESC LIMIT 1) AS state_json
       FROM cards c
       JOIN plans p ON p.id = c.plan_id
       LEFT JOIN topics t ON t.id = c.topic_id
       LEFT JOIN subjects s ON s.id = p.subject_id
       WHERE t.archived_at IS NULL
         AND p.archived_at IS NULL
         AND (? IS NULL OR c.plan_id = ?)
         AND (? IS NULL OR c.topic_id = ?)
         AND NOT EXISTS (SELECT 1 FROM json_each(?) w WHERE instr(c.search_text, w.value) = 0)
       ORDER BY s.id IS NULL, s.position, s.name COLLATE NOCASE, s.id,
         p.title COLLATE NOCASE, p.id,
         t.id IS NULL, t.position, t.id,
         c.created_at, c.rowid`,
    )
    .all(
      input.planId ?? null,
      input.planId ?? null,
      input.topicId ?? null,
      input.topicId ?? null,
      JSON.stringify(words),
    ) as Row[];

  const matches: BrowsedCard[] = [];
  for (const row of rows) {
    if (status === "removed" ? !row.removed : row.removed) continue;
    if (status === "suspended" && !row.suspended) continue;
    const saved = row.state_json
      ? (JSON.parse(row.state_json) as ScheduleState)
      : null;
    const dueAt = saved ? Number(saved.dueAt) : null;
    const state = dueAt == null ? "new" : dueAt <= now ? "due" : "scheduled";
    if (status === "due" && (row.suspended || state === "scheduled")) continue;
    const lapses = saved?.fsrs?.lapses ?? 0;
    const leech = lapses >= leechLapses;
    if (status === "leech" && !leech) continue;
    matches.push({
      id: row.id,
      front: row.front,
      back: row.back,
      planId: row.plan_id,
      planTitle: row.plan_title,
      topicId: row.topic_id,
      topicTitle: row.topic_title,
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      suspended: row.suspended === 1,
      removed: row.removed === 1,
      handMade: row.seed_key == null,
      state,
      dueAt,
      lapses,
      leech,
      passageId: row.passage_id,
      sourceId: row.source_id,
    });
  }

  const groups: BrowseResult["groups"] = [];
  for (const card of matches) {
    const last = groups.at(-1);
    if (last && last.subjectId === card.subjectId) last.count += 1;
    else
      groups.push({
        subjectId: card.subjectId,
        subject: card.subjectName,
        count: 1,
      });
  }

  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(PAGE_MAX, Math.max(1, input.limit ?? 25));
  return {
    total: matches.length,
    cards: matches.slice(offset, offset + limit),
    groups,
    ...browseFilters(db),
  };
}

function browseFilters(db: Database.Database) {
  const plans = db
    .prepare(
      `SELECT p.id, p.title, s.id AS subjectId, s.name AS subject
       FROM plans p LEFT JOIN subjects s ON s.id = p.subject_id
       WHERE p.archived_at IS NULL AND EXISTS (
         SELECT 1 FROM cards c LEFT JOIN topics t ON t.id = c.topic_id
         WHERE c.plan_id = p.id AND t.archived_at IS NULL)
       ORDER BY s.id IS NULL, s.position, s.name COLLATE NOCASE, s.id,
         p.title COLLATE NOCASE, p.id`,
    )
    .all() as BrowseResult["plans"];
  const topics = db
    .prepare(
      `SELECT t.id, t.plan_id AS planId, t.title FROM topics t
       WHERE t.archived_at IS NULL
         AND t.plan_id IN (SELECT id FROM plans WHERE archived_at IS NULL)
         AND EXISTS (SELECT 1 FROM cards c WHERE c.topic_id = t.id)
       ORDER BY t.plan_id, t.position, t.id`,
    )
    .all() as BrowseResult["topics"];
  return { plans, topics };
}
