import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { exportAnki } from "./anki";

function fixture() {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Fisica / 1', 'ready', 1, 1)").run();
  db.prepare("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('topic', 'plan', 'Moti', 0, 1)").run();
  const add = (id: string, front: string, back: string, suspended = 0, removed = 0) => {
    db.prepare(`INSERT INTO cards (id, plan_id, topic_id, front, back, suspended, removed, created_at)
      VALUES (?, 'plan', 'topic', ?, ?, ?, ?, 1)`).run(id, front, back, suspended, removed);
  };
  return { db, add };
}

function unpack(bytes: Uint8Array) {
  const zip = unzipSync(bytes);
  expect(Object.keys(zip).sort()).toEqual(["collection.anki2", "media"]);
  expect(JSON.parse(strFromU8(zip.media!))).toEqual({});
  return new Database(Buffer.from(zip["collection.anki2"]!));
}

describe("Anki package", () => {
  it("round trips legacy SQLite with Basic and numbered Cloze cards, fresh scheduling and math", () => {
    const { db, add } = fixture();
    add("basic", "Forza $F=ma$\nseconda riga", "$$\\frac{1}{\\frac{2}{3}}$$");
    add("cloze", "{{c1::$x^2$}} e {{c3::energia::hint}}, ancora {{c1::massa}}", "\\(E=mc^2\\)", 1);
    add("removed", "Hidden", "Hidden", 0, 1);
    const output = exportAnki(db, "plan", { now: 1800000000000 });
    expect(output.filename).toBe("Fisica   1.apkg");
    expect(output.noteCount).toBe(2);
    expect(output.cardCount).toBe(3);
    const col = unpack(output.bytes);
    try {
      expect(col.pragma("integrity_check", { simple: true })).toBe("ok");
      const metadata = col.prepare("SELECT * FROM col").get() as { ver: number; models: string; decks: string; dconf: string; conf: string };
      expect(metadata.ver).toBe(11);
      const models = Object.values(JSON.parse(metadata.models)) as Array<{ id: number; type: number; tmpls: Array<{ qfmt: string; afmt: string }> }>;
      expect(models.map((model) => model.type).sort()).toEqual([0, 1]);
      const cloze = models.find((model) => model.type === 1)!;
      expect(cloze.tmpls[0]!.qfmt).toBe("{{cloze:Text}}");
      expect(cloze.tmpls[0]!.afmt).toContain("{{Back Extra}}");
      const notes = col.prepare("SELECT * FROM notes ORDER BY mid").all() as Array<{ id: number; mid: number; flds: string; sfld: string; csum: number }>;
      expect(notes[0]!.flds).toBe("Forza \\(F=ma\\)<br>seconda riga\x1f\\[\\frac{1}{\\frac{2}{3} }\\]");
      expect(notes[1]!.flds).toContain("{{c1::\\(x^2\\)}}");
      expect(notes[1]!.flds).toContain("\\(E=mc^2\\)");
      expect(notes[0]!.sfld).toBe("Forza \\(F=ma\\)seconda riga");
      expect(notes[1]!.sfld).toBe("{{c1::\\(x^2\\)}} e {{c3::energia::hint}}, ancora {{c1::massa}}");
      for (const note of notes) {
        expect(note.csum).toBe(createHash("sha1").update(note.sfld).digest().readUInt32BE(0));
      }
      const cards = col.prepare("SELECT * FROM cards ORDER BY nid, ord").all() as Array<{ id: number; nid: number; did: number; ord: number; type: number; queue: number; reps: number }>;
      expect(cards.filter((card) => card.nid === notes[1]!.id).map((card) => card.ord)).toEqual([0, 2]);
      expect(new Set(cards.map((card) => card.id)).size).toBe(3);
      expect(JSON.parse(metadata.conf).nextPos).toBe(4);
      for (const card of cards) {
        expect(Number.isSafeInteger(card.id)).toBe(true);
        expect(notes.some((note) => note.id === card.nid)).toBe(true);
        expect(JSON.parse(metadata.decks)[card.did].conf).toBe(1);
        expect(JSON.parse(metadata.dconf)[1].new.initialFactor).toBe(2500);
        expect(card.type).toBe(0);
        expect(card.reps).toBe(0);
        expect(card.queue).toBe(card.nid === notes[1]!.id ? -1 : 0);
      }
      expect(col.prepare("SELECT COUNT(*) AS n FROM revlog").get()).toEqual({ n: 0 });
    } finally { col.close(); db.close(); }
  });

  it("escapes unsafe HTML, media tags, field separators and preserves line breaks", () => {
    const { db, add } = fixture();
    add("unsafe", '<script>alert(1)</script>\n<img src="https://example.com/x">', "[sound:remote.mp3]\r\n[anki:tts] & < >\x1fmore");
    const col = unpack(exportAnki(db, "plan").bytes);
    try {
      const { flds } = col.prepare("SELECT flds FROM notes").get() as { flds: string };
      expect(flds).not.toContain("<script>");
      expect(flds).not.toContain("<img");
      expect(flds).not.toContain("[sound:");
      expect(flds).not.toContain("[anki:");
      expect(flds).toContain("&#91;sound:remote.mp3]");
      expect(flds).toContain("<br>");
      expect(flds.split("\x1f")).toHaveLength(2);
    } finally { col.close(); db.close(); }
  });

  it("keeps note GUIDs and ids when exporting edits, supports topic scope and missing plans", () => {
    const { db, add } = fixture();
    add("one", "{{c1::A}}", "Answer");
    const first = unpack(exportAnki(db, "plan").bytes);
    db.prepare("UPDATE cards SET front = '{{c1::B}}' WHERE id = 'one'").run();
    const second = unpack(exportAnki(db, "plan", { topicId: "topic" }).bytes);
    try {
      expect(first.prepare("SELECT id, guid FROM notes").all()).toEqual(second.prepare("SELECT id, guid FROM notes").all());
      expect(first.prepare("SELECT id, nid, ord FROM cards").all()).toEqual(second.prepare("SELECT id, nid, ord FROM cards").all());
      expect(exportAnki(db, "plan", { topicId: "other" }).noteCount).toBe(0);
      expect(() => exportAnki(db, "missing")).toThrow("plan-missing");
    } finally { first.close(); second.close(); db.close(); }
  });
});
