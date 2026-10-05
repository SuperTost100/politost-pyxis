import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { strToU8, zipSync } from "fflate";

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

export function exportAnki(
  db: Database.Database,
  planId: string,
  options: { topicId?: string; now?: number } = {},
): { bytes: Uint8Array; filename: string; noteCount: number; cardCount: number } {
  const plan = db.prepare("SELECT title FROM plans WHERE id = ?").get(planId) as { title: string } | undefined;
  if (!plan) throw new Error("plan-missing");
  const rows = db.prepare(`SELECT c.id, c.front, c.back, c.suspended, p.section_path AS source
    FROM cards c LEFT JOIN passages p ON p.id = c.passage_id
    WHERE c.plan_id = ? AND c.removed = 0 AND (? IS NULL OR c.topic_id = ?)
      AND (c.topic_id IS NULL OR NOT EXISTS (SELECT 1 FROM topics t WHERE t.id = c.topic_id AND t.archived_at IS NOT NULL))
    ORDER BY c.created_at, c.id`).all(planId, options.topicId ?? null, options.topicId ?? null) as
    Array<{ id: string; front: string; back: string; suspended: number; source: string | null }>;
  const now = options.now ?? Date.now();
  const mod = Math.floor(now / 1000);
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
      .run(mod, now, now, JSON.stringify({ nextPos: 1, curDeck: deckId, activeDecks: [deckId] }),
        JSON.stringify({ [BASIC]: model(BASIC, false, deckId, mod), [CLOZE]: model(CLOZE, true, deckId, mod) }),
        JSON.stringify({ 1: deck(1, "Default"), [deckId]: deck(deckId, `Pyxis ${plan.title.replaceAll("::", " ").trim() || "Cards"}`) }),
        JSON.stringify({ 1: dconf }));
    const note = collection.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, -1, ' pyxis ', ?, ?, ?, 0, '')");
    const card = collection.prepare("INSERT INTO cards VALUES (?, ?, ?, ?, ?, -1, 0, ?, ?, 0, 2500, 0, 0, 0, 0, 0, 0, '')");
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
        const back = fieldHtml(row.back + (row.source?.trim() ? `\n\nSource: ${row.source.trim()}` : ""));
        const nid = allocate(`note:${row.id}`);
        const guid = createHash("sha256").update(`pyxis:${row.id}`).digest("base64url").slice(0, 22);
        const sort = sortField(front);
        const checksum = createHash("sha1").update(sort).digest().readUInt32BE(0);
        note.run(nid, guid, ords.length ? CLOZE : BASIC, mod, `${front}\x1f${back}`, sort, checksum);
        for (const ord of ords.length ? ords : [0]) {
          cardCount++;
          card.run(allocate(`card:${row.id}:${ord}`), nid, deckId, ord, mod, row.suspended ? -1 : 0, cardCount);
        }
      });
      collection.prepare("UPDATE col SET conf = ?").run(JSON.stringify({
        nextPos: cardCount + 1, curDeck: deckId, activeDecks: [deckId],
      }));
    })();
    return {
      bytes: zipSync({ "collection.anki2": collection.serialize(), media: strToU8("{}") }),
      filename: `${plan.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim() || "cards"}.apkg`,
      noteCount: rows.length, cardCount,
    };
  } finally {
    collection.close();
  }
}
