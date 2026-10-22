import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { strToU8, unzipSync, zipSync } from "fflate";
import { constants, crc32, deflateRawSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { IpcError } from "../../shared/ipc";
import { openDatabase } from "../db/connection";
import { exportAnki } from "../share/anki";
import { ankiRefusal, ankiText, importApkg, readApkg } from "./ankiImport";
import { rateCard } from "./cards";
import { newCard, review } from "./schedule";

const BASIC = 1;
const CLOZE = 2;
const ONE_FIELD = 3;
const DAY = 86_400_000;

type Fixture = {
  notes: Array<{ id: number; mid: number; fields: string[] }>;
  cards: Array<{ id: number; nid: number; ord: number; queue?: number }>;
  revlog?: Array<{ cid: number; id: number; ease: number; type?: number }>;
};

/**
 * A ZIP whose one deflated entry inflates to `mib` MiB of zeros. One compressed MiB is repeated (each copy ends on a
 * full flush, so they chain), which builds the bomb in milliseconds instead of deflating hundreds of MiB in the test.
 */
function zeroBomb(name: string, mib: number): Uint8Array {
  const zeros = new Uint8Array(1024 * 1024);
  const block = deflateRawSync(zeros, { finishFlush: constants.Z_FULL_FLUSH });
  // An empty final block ends the stream.
  const data = Buffer.concat([...Array<Buffer>(mib).fill(block), Buffer.from([0x03, 0x00])]);
  let crc = 0;
  for (let i = 0; i < mib; i++) crc = crc32(zeros, crc);
  const file = Buffer.from(name);
  const sizes = (header: Buffer, at: number) => {
    header.writeUInt16LE(8, at); // deflate
    header.writeUInt32LE(crc, at + 6);
    header.writeUInt32LE(data.length, at + 10);
    header.writeUInt32LE(mib * zeros.length, at + 14);
    header.writeUInt16LE(file.length, at + 18);
  };
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  sizes(local, 8);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  sizes(central, 10);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + file.length, 12);
  end.writeUInt32LE(local.length + file.length + data.length, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}

const TABLES = `
CREATE TABLE col (id integer PRIMARY KEY, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer,
 ls integer, conf text, models text, decks text, dconf text, tags text);
CREATE TABLE notes (id integer PRIMARY KEY, guid text, mid integer, mod integer, usn integer, tags text, flds text,
 sfld integer, csum integer, flags integer, data text);
CREATE TABLE cards (id integer PRIMARY KEY, nid integer, did integer, ord integer, mod integer, usn integer, type integer,
 queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer,
 odid integer, flags integer, data text);
CREATE TABLE revlog (id integer PRIMARY KEY, cid integer, usn integer, ease integer, ivl integer, lastIvl integer,
 factor integer, time integer, type integer);`;

function fill(collection: Database.Database, data: Fixture) {
  const note = collection.prepare("INSERT INTO notes VALUES (?, 'g', ?, 0, 0, '', ?, '', 0, 0, '')");
  for (const row of data.notes) note.run(row.id, row.mid, row.fields.join("\x1f"));
  const card = collection.prepare("INSERT INTO cards VALUES (?, ?, 1, ?, 0, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, '')");
  for (const row of data.cards) card.run(row.id, row.nid, row.ord, row.queue ?? 0);
  const log = collection.prepare("INSERT INTO revlog VALUES (?, ?, 0, ?, 0, 0, 0, 0, ?)");
  for (const row of data.revlog ?? []) log.run(row.id, row.cid, row.ease, row.type ?? 1);
}

function legacyCollection(data: Fixture): Uint8Array {
  const collection = new Database(":memory:");
  try {
    collection.exec(TABLES);
    const model = (id: number, type: number, fields: string[]) => ({
      id, type, flds: fields.map((name, ord) => ({ name, ord })),
    });
    collection
      .prepare("INSERT INTO col VALUES (1, 0, 0, 0, 11, 0, 0, 0, '{}', ?, '{}', '{}', '{}')")
      .run(JSON.stringify({
        [BASIC]: model(BASIC, 0, ["Front", "Back"]),
        [CLOZE]: model(CLOZE, 1, ["Text", "Back Extra"]),
        [ONE_FIELD]: model(ONE_FIELD, 0, ["Only"]),
      }));
    fill(collection, data);
    return collection.serialize();
  } finally {
    collection.close();
  }
}

/** A package as Anki's "Support older Anki versions" export writes it. */
function legacyPackage(data: Fixture, entry = "collection.anki2"): Uint8Array {
  return zipSync({ [entry]: legacyCollection(data), media: strToU8('{"0":"x.png"}'), "0": new Uint8Array(10) });
}

/** The newer layout: notetypes and fields in tables, the file compressed with zstd. */
function modernPackage(data: Fixture): Uint8Array {
  const collection = new Database(":memory:");
  try {
    collection.exec(`${TABLES}
      CREATE TABLE notetypes (id integer PRIMARY KEY, name text, mtime_secs integer, usn integer, config blob);
      CREATE TABLE fields (ntid integer, ord integer, name text, config blob);`);
    collection.prepare("INSERT INTO col VALUES (1, 0, 0, 0, 18, 0, 0, 0, '', '', '', '', '')").run();
    const type = collection.prepare("INSERT INTO notetypes VALUES (?, 'n', 0, 0, ?)");
    type.run(BASIC, Buffer.alloc(0));
    type.run(CLOZE, Buffer.from([0x08, 0x01]));
    const field = collection.prepare("INSERT INTO fields VALUES (?, ?, 'f', x'')");
    for (const mid of [BASIC, CLOZE]) for (const ord of [0, 1]) field.run(mid, ord);
    fill(collection, data);
    // The legacy file beside it is the stub older Anki shows, with a single note that asks to update.
    return zipSync({
      "collection.anki21b": zstdCompressSync(collection.serialize()),
      "collection.anki2": legacyCollection({
        notes: [{ id: 99, mid: BASIC, fields: ["Please update to the latest Anki version", "Update"] }],
        cards: [{ id: 99, nid: 99, ord: 0 }],
      }),
      media: new Uint8Array(),
    });
  } finally {
    collection.close();
  }
}

function plan() {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Fisica', 'ready', 1, 1);
    INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('topic', 'plan', 'Moti', 0, 1);
    INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('other', 'Chimica', 'ready', 1, 1);
    INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t2', 'other', 'Atomi', 0, 1);`);
  return db;
}

const into = { planId: "plan", topicId: "topic", history: true };
const cardRows = (db: ReturnType<typeof plan>, planId = "plan") =>
  db.prepare("SELECT id, front, back, suspended FROM cards WHERE plan_id = ? ORDER BY created_at, id").all(planId) as
    Array<{ id: string; front: string; back: string; suspended: number }>;

describe("Anki text", () => {
  it("reduces HTML to plain text with light Markdown and never keeps a tag", () => {
    expect(ankiText("<div>Una <b>forza</b> &amp; <i>massa</i></div><div>seconda&nbsp;riga<br>terza</div>")).toBe(
      "Una **forza** & *massa*\nseconda riga\nterza",
    );
    expect(ankiText("<ul><li>uno</li><li>due</li></ul>")).toBe("- uno\n- due");
    expect(ankiText('<script>alert(1)</script><img src="x.png" onerror="alert(1)">[sound:a.mp3]Ciao<style>p{}</style>')).toBe("Ciao");
    expect(ankiText('<a href="javascript:alert(1)">link</a> <code>x</code>')).toBe("link `x`");
    expect(ankiText("\\(E=mc^2\\) e \\[a &lt; b\\]")).toBe("$E=mc^2$ e $$a < b$$");
    expect(ankiText("&#8364; &#x41; &unknown;")).toBe("€ A &unknown;");
    expect(ankiText("<b></b>vuoto")).toBe("vuoto");
  });
});

describe("Anki import", () => {
  it("imports basic and cloze notes from a legacy package into one topic", () => {
    const db = plan();
    const bytes = legacyPackage({
      notes: [
        { id: 1, mid: BASIC, fields: ["<b>Forza</b>?", "<div>F = m&middot;a</div>"] },
        { id: 2, mid: CLOZE, fields: ["La {{c1::massa::cosa}} e l'{{c2::energia}}", "Extra"] },
      ],
      cards: [
        { id: 10, nid: 1, ord: 0 },
        { id: 11, nid: 2, ord: 0 },
        { id: 12, nid: 2, ord: 1 },
      ],
    });
    const result = importApkg(db, bytes, { ...into, history: false }, 1_000);
    expect(result).toMatchObject({ imported: 3, duplicates: 0, unsupported: 0, empty: 0 });
    expect(cardRows(db).map(({ front, back }) => ({ front, back }))).toEqual([
      { front: "**Forza**?", back: "F = m&middot;a" },
      { front: "La {{c1::massa::cosa}} e l'energia", back: "Extra" },
      { front: "La massa e l'{{c1::energia}}", back: "Extra" },
    ]);
    // Every card belongs to the chosen topic and has no review yet.
    expect(db.prepare("SELECT COUNT(*) AS n FROM cards WHERE topic_id = 'topic'").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM card_reviews").get()).toEqual({ n: 0 });
  });

  it("falls back to the filled-in sentence when a cloze note has no extra text", () => {
    const db = plan();
    importApkg(db, legacyPackage({
      notes: [{ id: 1, mid: CLOZE, fields: ["{{c1::Roma}} è la capitale", ""] }],
      cards: [{ id: 1, nid: 1, ord: 0 }],
    }), into);
    expect(cardRows(db)[0]).toMatchObject({ front: "{{c1::Roma}} è la capitale", back: "**Roma** è la capitale" });
  });

  it("swaps the sides of a second card, and reads a package whose collection is the newer file name", () => {
    const db = plan();
    importApkg(db, legacyPackage({
      notes: [{ id: 1, mid: BASIC, fields: ["cane", "dog"] }],
      cards: [{ id: 1, nid: 1, ord: 0 }, { id: 2, nid: 1, ord: 1 }],
    }, "collection.anki21"), into);
    expect(cardRows(db).map(({ front, back }) => [front, back])).toEqual([["cane", "dog"], ["dog", "cane"]]);
  });

  it("counts what it skips: one-field types, media-only cards, image occlusion and orphan clozes", () => {
    const db = plan();
    const bytes = legacyPackage({
      notes: [
        { id: 1, mid: ONE_FIELD, fields: ["solo"] },
        { id: 2, mid: BASIC, fields: ['<img src="a.png">', "back"] },
        { id: 3, mid: BASIC, fields: ["front", '<img src="b.png">[sound:x.mp3]'] },
        { id: 4, mid: CLOZE, fields: ["{{c1::image-occlusion:rect:left=1}}", '<img src="c.png">'] },
        { id: 5, mid: CLOZE, fields: ["niente cloze qui", ""] },
        { id: 6, mid: BASIC, fields: ["ok", "yes"] },
        { id: 7, mid: 404, fields: ["a", "b"] },
        { id: 8, mid: BASIC, fields: ["x".repeat(5000), "y"] },
      ],
      cards: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: n, nid: n, ord: 0 })),
    });
    expect(readApkg(bytes)).toMatchObject({ skipped: { unsupported: 4, empty: 3 } });
    const result = importApkg(db, bytes, into);
    expect(result).toMatchObject({ imported: 1, unsupported: 4, empty: 3 });
    expect(cardRows(db)).toHaveLength(1);
  });

  it("does not add a card twice and keeps the suspended flag", () => {
    const db = plan();
    const bytes = legacyPackage({
      notes: [{ id: 1, mid: BASIC, fields: ["a", "b"] }, { id: 2, mid: BASIC, fields: ["c", "d"] }],
      cards: [{ id: 1, nid: 1, ord: 0, queue: -1 }, { id: 2, nid: 2, ord: 0 }],
    });
    importApkg(db, bytes, into);
    expect(cardRows(db).map((card) => card.suspended)).toEqual([1, 0]);
    expect(importApkg(db, bytes, into)).toMatchObject({ imported: 0, duplicates: 2 });
    expect(cardRows(db)).toHaveLength(2);
    // Another topic is not a duplicate.
    expect(importApkg(db, bytes, { planId: "other", topicId: "t2", history: true })).toMatchObject({ imported: 2 });
  });

  it("replays the review log through FSRS in time order and ignores manual reschedules", () => {
    const db = plan();
    const t0 = Date.UTC(2026, 0, 1);
    const log = [
      { cid: 1, id: t0 + 6 * DAY, ease: 4 },
      { cid: 1, id: t0, ease: 1, type: 0 },
      { cid: 1, id: t0 + DAY, ease: 3 },
      { cid: 1, id: t0 + 2 * DAY, ease: 0, type: 4 },
      { cid: 1, id: t0 + 3 * DAY, ease: 2 },
      { cid: 1, id: Date.UTC(2090, 0, 1), ease: 3 },
      { cid: 1, id: 12345, ease: 3 },
    ];
    const bytes = legacyPackage({
      notes: [{ id: 1, mid: BASIC, fields: ["a", "b"] }, { id: 2, mid: BASIC, fields: ["c", "d"] }],
      cards: [{ id: 1, nid: 1, ord: 0 }, { id: 2, nid: 2, ord: 0 }],
      revlog: log,
    });
    expect(readApkg(bytes).reviewCount).toBe(6);
    const result = importApkg(db, bytes, into, Date.UTC(2026, 5, 1));
    expect(result).toMatchObject({ withHistory: 1, reviews: 4 });
    const reviews = db.prepare("SELECT rating, state_json, reviewed_at FROM card_reviews ORDER BY reviewed_at").all() as
      Array<{ rating: string; state_json: string; reviewed_at: number }>;
    expect(reviews.map((row) => row.rating)).toEqual(["again", "good", "hard", "easy"]);
    expect(reviews.map((row) => row.reviewed_at)).toEqual([0, 1, 3, 6].map((day) => t0 + day * DAY));
    let expected = newCard(t0);
    for (const row of reviews) expected = review(expected, row.rating as "again", row.reviewed_at);
    expect(JSON.parse(reviews.at(-1)!.state_json)).toEqual(expected);
    expect(expected.fsrs!.reps).toBe(4);
    // The card's next review comes from the latest stored state, as for any card rated in Pyxis.
    const latest = db.prepare(
      "SELECT json_extract(state_json, '$.dueAt') AS due FROM card_reviews ORDER BY reviewed_at DESC LIMIT 1",
    ).get() as { due: number };
    expect(latest.due).toBe(expected.dueAt);
    // History off brings the cards only.
    const other = plan();
    importApkg(other, bytes, { ...into, history: false });
    expect(other.prepare("SELECT COUNT(*) AS n FROM card_reviews").get()).toEqual({ n: 0 });
  });

  it("reads the newer .anki21b layout, preferring it to the stub beside it", () => {
    plan();
    const bytes = modernPackage({
      notes: [
        { id: 1, mid: BASIC, fields: ["domanda", "risposta"] },
        { id: 2, mid: CLOZE, fields: ["{{c1::uno}} {{c2::due}}", ""] },
      ],
      cards: [{ id: 1, nid: 1, ord: 0 }, { id: 2, nid: 2, ord: 1 }],
      revlog: [{ cid: 1, id: Date.UTC(2026, 0, 1), ease: 3, type: 0 }],
    });
    const parsed = readApkg(bytes, { history: true });
    expect(parsed.format).toBe("modern");
    expect(parsed.cards.map((card) => card.front)).toEqual(["domanda", "uno {{c1::due}}"]);
    expect(parsed.cards[0]!.reviews).toEqual([{ at: Date.UTC(2026, 0, 1), rating: "good" }]);
  });

  it("refuses files that are not a usable package, and leaves no temporary folder", () => {
    const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("pyxis-anki-")).length;
    const before = leftovers();
    const refused = (bytes: Uint8Array, code: string) => {
      expect(() => readApkg(bytes)).toThrow(code);
      const error = (() => {
        try {
          ankiRefusal(() => readApkg(bytes));
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(IpcError);
      expect((error as IpcError).messageKey).toMatch(/^cardImport\.errors\./);
    };
    refused(strToU8("not a zip at all, just text, long enough to pass the header size check"), "anki-not-package");
    refused(zipSync({ media: strToU8("{}") }), "anki-not-package");
    refused(zipSync({ "collection.anki2": strToU8("this is not a database") }), "anki-not-package");
    refused(zipSync({ "collection.anki21b": strToU8("not zstd") }), "anki-not-package");
    const empty = new Database(":memory:");
    empty.exec("CREATE TABLE unrelated (x)");
    refused(zipSync({ "collection.anki2": empty.serialize() }), "anki-not-package");
    empty.close();
    expect(leftovers()).toBe(before);
  });

  it("refuses a collection with too many notes", () => {
    const notes = Array.from({ length: 50_001 }, (_, i) => ({ id: i + 1, mid: BASIC, fields: ["a", "b"] }));
    const bytes = legacyPackage({ notes, cards: notes.map((note) => ({ id: note.id, nid: note.id, ord: 0 })) });
    expect(() => readApkg(bytes)).toThrow("anki-too-large");
  });

  it("refuses an archive that inflates past the limit", () => {
    // One MiB past the 192 MiB the importer accepts. The importer stops counting there, so the refusal costs one
    // inflate to the limit and no more.
    const bomb = zeroBomb("collection.anki2", 193);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(() => readApkg(bomb)).toThrow("anki-too-large");
  });

  it("refuses an archived topic or another plan's topic", () => {
    const db = plan();
    const bytes = legacyPackage({ notes: [], cards: [] });
    expect(() => importApkg(db, bytes, { planId: "plan", topicId: "t2", history: false })).toThrow("topic-missing");
  });
});

describe("Anki export and import", () => {
  it("round trips cards, cloze numbering, suspension and review history", () => {
    const source = plan();
    const t0 = Date.UTC(2026, 2, 1);
    const add = (id: string, front: string, back: string, suspended = 0) =>
      source.prepare(`INSERT INTO cards (id, plan_id, topic_id, front, back, suspended, created_at)
        VALUES (?, 'plan', 'topic', ?, ?, ?, ?)`).run(id, front, back, suspended, t0 + Number(id.slice(1)));
    add("c1", "Forza $F=ma$", "Seconda legge\ndi Newton");
    add("c2", "{{c1::Roma}} e {{c2::Parigi}}", "Capitali");
    add("c3", "Sospesa", "Sì", 1);
    add("c4", "Mai vista", "Nuova");
    rateCard(source, "c1", "good", t0 + 1000);
    rateCard(source, "c1", "easy", t0 + 3 * DAY);
    rateCard(source, "c2", "again", t0 + 2000);
    const packed = exportAnki(source, "plan", { history: true, now: t0 + 5 * DAY });
    expect(packed.cardCount).toBe(5);

    const dir = new Database(Buffer.from(unzipSync(packed.bytes)["collection.anki2"]!));
    try {
      const card = dir.prepare("SELECT c.* FROM cards c JOIN notes n ON n.id = c.nid WHERE n.flds LIKE 'Forza%'").get() as
        { type: number; queue: number; due: number; ivl: number; reps: number; data: string };
      expect(card).toMatchObject({ type: 2, queue: 2, reps: 2 });
      expect(card.ivl).toBeGreaterThan(0);
      expect(card.due).toBeGreaterThan(0);
      expect(JSON.parse(card.data).s).toBeGreaterThan(0);
      expect((dir.prepare("SELECT ease FROM revlog ORDER BY id").all() as Array<{ ease: number }>).map((row) => row.ease)).toEqual([3, 1, 4]);
      expect(dir.prepare("SELECT COUNT(*) AS n FROM cards WHERE queue = -1").get()).toEqual({ n: 1 });
    } finally {
      dir.close();
    }

    const target = plan();
    const result = importApkg(target, packed.bytes, { planId: "other", topicId: "t2", history: true }, t0 + 6 * DAY);
    expect(result).toMatchObject({ imported: 5, duplicates: 0, unsupported: 0, empty: 0, withHistory: 2, reviews: 3 });
    // Anki numbers cards by hashed ids in a Pyxis export, so the order is not the original one.
    const got = cardRows(target, "other").sort((a, b) => (a.front < b.front ? -1 : 1));
    expect(got.map(({ front, back, suspended }) => ({ front, back, suspended }))).toEqual([
      { front: "Forza $F=ma$", back: "Seconda legge\ndi Newton", suspended: 0 },
      { front: "Mai vista", back: "Nuova", suspended: 0 },
      { front: "Roma e {{c1::Parigi}}", back: "Capitali", suspended: 0 },
      { front: "Sospesa", back: "Sì", suspended: 1 },
      { front: "{{c1::Roma}} e Parigi", back: "Capitali", suspended: 0 },
    ]);
    // Ratings and times of the first card come back, and the replayed state matches the original.
    const reviewsOf = (db: typeof source, card: string) =>
      db.prepare("SELECT rating, reviewed_at AS at, state_json AS state FROM card_reviews WHERE card_id = ? ORDER BY reviewed_at").all(card) as
        Array<{ rating: string; at: number; state: string }>;
    const original = reviewsOf(source, "c1");
    const copy = reviewsOf(target, got.find((card) => card.front.startsWith("Forza"))!.id);
    expect(copy.map((r) => [r.rating, r.at])).toEqual(original.map((r) => [r.rating, r.at]));
    expect(JSON.parse(copy.at(-1)!.state)).toEqual(JSON.parse(original.at(-1)!.state));
    // Without history the package holds only fresh cards.
    const plain = exportAnki(source, "plan", { now: t0 });
    expect(importApkg(plan(), plain.bytes, into)).toMatchObject({ withHistory: 0, reviews: 0 });
  });
});
