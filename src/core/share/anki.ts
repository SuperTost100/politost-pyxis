import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { strToU8, zipSync } from "fflate";
import { planExportLabels } from "./markdown";
import { safeFileName } from "../../shared/file-name";

const BASIC = 1600000000101;
const CLOZE = 1600000000102;

// Legacy package contract: https://github.com/ankitects/anki/tree/main/rslib/src/storage
const SCHEMA = `
CREATE TABLE col (id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL,
 scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL, usn integer NOT NULL,
 ls integer NOT NULL, conf text NOT NULL, models text NOT NULL, decks text NOT NULL,
 dconf text NOT NULL, tags text NOT NULL);
CREATE TABLE notes (id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL,
 mod integer NOT NULL, usn integer NOT NULL, tags text NOT NULL, flds text NOT NULL,
 sfld integer NOT NULL, csum integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
CREATE TABLE cards (id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL,
 ord integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL, type integer NOT NULL,
 queue integer NOT NULL, due integer NOT NULL, ivl integer NOT NULL, factor integer NOT NULL,
 reps integer NOT NULL, lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL,
 odid integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
CREATE TABLE revlog (id integer PRIMARY KEY, cid integer NOT NULL, usn integer NOT NULL,
 ease integer NOT NULL, ivl integer NOT NULL, lastIvl integer NOT NULL, factor integer NOT NULL,
 time integer NOT NULL, type integer NOT NULL);
CREATE TABLE graves (usn integer NOT NULL, oid integer NOT NULL, type integer NOT NULL);
CREATE INDEX ix_notes_usn ON notes(usn);
CREATE INDEX ix_cards_usn ON cards(usn);
CREATE INDEX ix_revlog_usn ON revlog(usn);
CREATE INDEX ix_cards_nid ON cards(nid);
CREATE INDEX ix_cards_sched ON cards(did, queue, due);
CREATE INDEX ix_revlog_cid ON revlog(cid);
CREATE INDEX ix_notes_csum ON notes(csum);`;

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("[", "&#91;");
}

function fieldHtml(text: string): string {
  text = text.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  // Anki renders these delimiters itself. No scripts, external fonts or media are needed.
  const math = /(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\$([^\n$]+?)\$|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;
  let result = "";
  let offset = 0;
  for (const match of text.matchAll(math)) {
    result += escapeHtml(text.slice(offset, match.index)).replaceAll("\n", "<br>");
    const display = match[1] !== undefined || match[4] !== undefined;
    const body = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").replaceAll("\n", " ")
      // Adjacent TeX braces would otherwise close an enclosing Anki cloze.
      .replace(/}(?=})/g, "} ");
    result += (display ? "\\[" : "\\(") + escapeHtml(body) + (display ? "\\]" : "\\)");
    offset = match.index + match[0].length;
  }
  return result + escapeHtml(text.slice(offset)).replaceAll("\n", "<br>");
}

function sortField(html: string): string {
  // Only fieldHtml's <br> and escaped entities occur here. Anki hashes the
  // decoded first field, including cloze markup and the MathJax delimiters.
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#91;": "[" };
  return html.replaceAll("<br>", "").replace(/&amp;|&lt;|&gt;|&#91;/g, (entity) => entities[entity] ?? entity)
    .replaceAll("\u00a0", " ");
}

function stableId(value: string): number {
  return 1000000000000 + createHash("sha256").update(value).digest().readUIntBE(0, 5) % 600000000000;
}

function model(id: number, cloze: boolean, deckId: number, mod: number) {
  const names = cloze ? ["Text", "Back Extra"] : ["Front", "Back"];
  return {
    id, name: `Pyxis ${cloze ? "Cloze" : "Basic"}`, type: cloze ? 1 : 0, mod, usn: -1,
    sortf: 0, did: deckId, latexPre: "", latexPost: "", latexsvg: false,
    css: ".card { font-family: Arial, sans-serif; font-size: 20px; line-height: 1.5; text-align: left; } .cloze { font-weight: bold; color: #2563eb; } .nightMode .cloze { color: #93c5fd; }",
    flds: names.map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: "Arial", size: 20 })),
    tmpls: [{ name: "Card 1", ord: 0, qfmt: cloze ? "{{cloze:Text}}" : "{{Front}}",
      afmt: cloze ? "{{cloze:Text}}<br>{{Back Extra}}" : '{{FrontSide}}<hr id="answer">{{Back}}',
      bqfmt: "", bafmt: "", did: null }],
    req: cloze ? [] : [[0, "any", [0]]],
  };
}

type Stored = { dueAt: number; intervalDays: number; fsrs?: { state: number; stability: number; difficulty: number; scheduled_days: number; reps: number; lapses: number } };

// FSRS states (ts-fsrs): 0 New, 1 Learning, 2 Review, 3 Relearning. Anki card types use the same numbers.
function ankiState(state: Stored, suspended: boolean, crt: number) {
  const fsrs = state.fsrs;
  const kind = fsrs ? fsrs.state : state.intervalDays > 0 ? 2 : 1;
  const days = Math.max(1, Math.round(fsrs?.scheduled_days ?? state.intervalDays));
  return {
    type: kind,
    queue: suspended ? -1 : kind === 2 ? 2 : 1,
    // A review is due on a day counted from the collection's creation day; a learning card at a time in seconds.
    due: kind === 2 ? Math.floor((state.dueAt / 1000 - crt) / 86400) : Math.floor(state.dueAt / 1000),
    ivl: kind === 2 || kind === 3 ? days : 0,
    left: kind === 2 ? 0 : 1001,
    reps: fsrs?.reps ?? 0,
    lapses: fsrs?.lapses ?? 0,
    data: fsrs && fsrs.stability > 0 ? JSON.stringify({ s: fsrs.stability, d: fsrs.difficulty }) : "",
  };
}

export function exportAnki(
  db: Database.Database,
  planId: string,
  options: { topicId?: string; now?: number; history?: boolean } = {},
): { bytes: Uint8Array; filename: string; noteCount: number; cardCount: number } {
  const plan = db.prepare("SELECT title FROM plans WHERE id = ?").get(planId) as { title: string } | undefined;
  if (!plan) throw new Error("plan-missing");
  const rows = db.prepare(`SELECT c.id, c.front, c.back, c.suspended, p.section_path AS source
    FROM cards c LEFT JOIN passages p ON p.id = c.passage_id
    WHERE c.plan_id = ? AND c.removed = 0 AND (? IS NULL OR c.topic_id = ?)
      AND (c.topic_id IS NULL OR NOT EXISTS (SELECT 1 FROM topics t WHERE t.id = c.topic_id AND t.archived_at IS NOT NULL))
    ORDER BY c.created_at, c.id`).all(planId, options.topicId ?? null, options.topicId ?? null) as
    Array<{ id: string; front: string; back: string; suspended: number; source: string | null }>;
  const labels = planExportLabels(db, planId);
  const now = options.now ?? Date.now();
  const mod = Math.floor(now / 1000);
  const reviewsOf = db.prepare("SELECT rating, state_json, reviewed_at FROM card_reviews WHERE card_id = ? ORDER BY reviewed_at, id");
  const history = new Map<string, Array<{ rating: string; state: Stored; at: number }>>();
  if (options.history)
    for (const row of rows)
      history.set(row.id, (reviewsOf.all(row.id) as Array<{ rating: string; state_json: string; reviewed_at: number }>)
        .map((review) => ({ rating: review.rating, state: JSON.parse(review.state_json) as Stored, at: review.reviewed_at })));
  // Day counts start on the UTC day of the first review, so no due day is negative.
  const first = Math.min(now, ...[...history.values()].map((list) => list[0]?.at ?? now));
  const crt = options.history ? Math.floor(first / 86400000) * 86400 : mod;
  const deckId = stableId(`deck:${planId}`);
  const deck = (id: number, name: string) => ({ id, name, mod, usn: -1, desc: "", dyn: 0,
    collapsed: false, browserCollapsed: false, conf: 1, extendNew: 0, extendRev: 0,
    newToday: [0, 0], revToday: [0, 0], lrnToday: [0, 0], timeToday: [0, 0] });
  const collection = new Database(":memory:");
  let cardCount = 0;
  try {
    collection.exec(SCHEMA);
    const dconf = { id: 1, name: "Default", mod, usn: 0, maxTaken: 60, autoplay: true,
      timer: 0, replayq: true, dyn: false,
      new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20 },
      rev: { bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200 },
      lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 } };
    collection.prepare("INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, '{}')")
      .run(crt, now, now, JSON.stringify({ nextPos: 1, curDeck: deckId, activeDecks: [deckId] }),
        JSON.stringify({ [BASIC]: model(BASIC, false, deckId, mod), [CLOZE]: model(CLOZE, true, deckId, mod) }),
        JSON.stringify({ 1: deck(1, "Default"), [deckId]: deck(deckId, `Pyxis ${plan.title.replaceAll("::", " ").trim() || "Cards"}`) }),
        JSON.stringify({ 1: dconf }));
    const note = collection.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, -1, ' pyxis ', ?, ?, ?, 0, '')");
    const card = collection.prepare("INSERT INTO cards VALUES (?, ?, ?, ?, ?, -1, ?, ?, ?, ?, 2500, ?, ?, ?, 0, 0, 0, ?)");
    const revlog = collection.prepare("INSERT INTO revlog VALUES (?, ?, -1, ?, ?, ?, 2500, 0, ?)");
    const usedLog = new Set<number>();
    const used = new Set<number>();
    const allocate = (key: string) => {
      let id = stableId(key);
      while (used.has(id)) id++;
      used.add(id);
      return id;
    };
    collection.transaction(() => {
      rows.forEach((row) => {
        const front = fieldHtml(row.front);
        const ords = [...new Set([...front.matchAll(/\{\{c([1-9]\d{0,3})::[\s\S]+?}}/g)]
          .map((match) => Number(match[1]) - 1))].sort((a, b) => a - b);
        const back = fieldHtml(row.back + (row.source?.trim() ? `\n\n${labels.source}: ${row.source.trim()}` : ""));
        const nid = allocate(`note:${row.id}`);
        const guid = createHash("sha256").update(`pyxis:${row.id}`).digest("base64url").slice(0, 22);
        const sort = sortField(front);
        const checksum = createHash("sha1").update(sort).digest().readUInt32BE(0);
        note.run(nid, guid, ords.length ? CLOZE : BASIC, mod, `${front}\x1f${back}`, sort, checksum);
        const reviews = history.get(row.id) ?? [];
        const latest = reviews.at(-1);
        (ords.length ? ords : [0]).forEach((ord, index) => {
          cardCount++;
          const cid = allocate(`card:${row.id}:${ord}`);
          // A cloze card holds all its deletions in Pyxis, so its one history goes to the first Anki card.
          const kept = index === 0 ? latest : undefined;
          const s = kept ? ankiState(kept.state, Boolean(row.suspended), crt)
            : { type: 0, queue: row.suspended ? -1 : 0, due: cardCount, ivl: 0, left: 0, reps: 0, lapses: 0, data: "" };
          card.run(cid, nid, deckId, ord, mod, s.type, s.queue, s.due, s.ivl, s.reps, s.lapses, s.left, s.data);
          if (index !== 0) return;
          reviews.forEach((item, at) => {
            const before = reviews[at - 1]?.state.fsrs;
            const review = item.state.fsrs;
            const learning = (state?: { state: number }) => !state || state.state !== 2;
            let id = item.at;
            while (usedLog.has(id)) id++;
            usedLog.add(id);
            // Interval after the review: days for a review card, negative seconds for a learning step.
            const after = learning(review) ? -Math.max(1, Math.round((item.state.dueAt - item.at) / 1000)) : Math.max(1, Math.round(review?.scheduled_days ?? 1));
            const was = learning(before) ? (before ? -Math.max(1, Math.round((reviews[at - 1]!.state.dueAt - reviews[at - 1]!.at) / 1000)) : 0) : Math.max(1, Math.round(before?.scheduled_days ?? 1));
            const kind = before?.state === 2 ? 1 : before?.state === 3 ? 2 : 0;
            revlog.run(id, cid, ["again", "hard", "good", "easy"].indexOf(item.rating) + 1, after, was, kind);
          });
        });
      });
      collection.prepare("UPDATE col SET conf = ?").run(JSON.stringify({
        nextPos: cardCount + 1, curDeck: deckId, activeDecks: [deckId],
      }));
    })();
    return {
      bytes: zipSync({ "collection.anki2": collection.serialize(), media: strToU8("{}") }),
      filename: `${safeFileName(plan.title, "cards")}.apkg`,
      noteCount: rows.length, cardCount,
    };
  } finally {
    collection.close();
  }
}
