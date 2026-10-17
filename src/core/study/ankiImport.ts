import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { IpcError } from "../../shared/ipc";
import { openZip } from "../sources/zip-bounded";
import { saveCard, setSuspended } from "./cards";
import { clozeAnswer } from "./cloze";
import { newCard, review, type Rating } from "./schedule";

/**
 * Reads an Anki package (.apkg) into Pyxis cards.
 *
 * Package: a ZIP holding the collection as `collection.anki21b` (zstd, the default export of Anki 2.1.50+),
 * `collection.anki21` or `collection.anki2` (older exports), plus numbered media files that are never read.
 * Mapping: one Pyxis card per Anki card. A cloze card keeps only its own deletion, as `{{c1::...}}`; the other
 * deletions of the note become plain text, so each Anki cloze card keeps its own history. A standard note type with at
 * least two fields maps field 1 to the front and field 2 to the back; its second card (the reverse) swaps them.
 * Everything else (one-field types, a third card, image occlusion, cards with no text left) is counted and skipped.
 * HTML is reduced to plain text with a little Markdown (bold, italic, code, lists, math); it is never kept.
 * History: the revlog is replayed through the FSRS scheduler in time order (Again/Hard/Good/Easy for ease 1 to 4), so
 * the state and due date come from FSRS, not from Anki's own interval. Manual reschedules (ease 0) are ignored.
 */

export type AnkiImportError =
  | "anki-not-package"
  | "anki-too-large"
  | "anki-modern-unsupported";

const fail = (code: AnkiImportError): never => {
  throw new Error(code);
};

const REFUSALS: Record<AnkiImportError, string> = {
  "anki-not-package": "cardImport.errors.notPackage",
  "anki-too-large": "cardImport.errors.tooLarge",
  "anki-modern-unsupported": "cardImport.errors.modern",
};

/** Turns a refusal of the reader into an IPC error the student can read; anything else passes through. */
export function ankiRefusal<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code in REFUSALS)
      throw new IpcError(code, REFUSALS[code as AnkiImportError]);
    throw error;
  }
}

/** The collection inside the package, and the whole package after inflating. Media is never inflated. */
const MAX_COLLECTION_BYTES = 192 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_NOTES = 50_000;
const MAX_CARDS = 100_000;
/** Reviews replayed per card; older ones are dropped. */
const MAX_REVIEWS_PER_CARD = 500;
const MAX_FIELD_CHARS = 4000;
const EARLIEST_REVIEW = Date.UTC(2000, 0, 1);

export type AnkiCard = {
  front: string;
  back: string;
  suspended: boolean;
  /** Oldest first. */
  reviews: Array<{ at: number; rating: Rating }>;
};

export type AnkiPackage = {
  format: "legacy" | "modern";
  cards: AnkiCard[];
  skipped: { unsupported: number; empty: number };
  /** Reviews in the whole collection with a usable button, whether or not they are read. */
  reviewCount: number;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Anki field HTML as plain text with light Markdown. */
export function ankiText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/\[sound:[^\]]*\]/g, "")
    .replace(/<br\s*\/?>|<\/(?:div|p|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/?(?:b|strong)\b[^>]*>/gi, "**")
    .replace(/<\/?(?:i|em)\b[^>]*>/gi, "*")
    .replace(/<\/?code\b[^>]*>/gi, "`")
    .replace(/<[^>]*>/g, "")
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, math: string) => `$${math.trim()}$`)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math: string) => `$$${math.trim()}$$`)
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1]?.toLowerCase() === "x"
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/ /g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\*{2}\s*\*{2}/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type NoteType = { cloze: boolean; fields: number };

/** Protobuf `NotetypeConfig.kind` (field 1, varint): 1 is cloze. Proto3 leaves out the default, a standard type. */
function modernKind(config: Buffer | null): boolean {
  return config !== null && config.length >= 2 && config[0] === 0x08 && config[1] === 1;
}

function readNoteTypes(
  collection: Database.Database,
  modern: boolean,
): Map<number, NoteType> {
  const types = new Map<number, NoteType>();
  if (modern) {
    // No ORDER BY or WHERE on a name column: Anki declares them with a collation SQLite does not have.
    const fields = new Map<number, number>();
    for (const row of collection
      .prepare("SELECT ntid FROM fields")
      .all() as Array<{ ntid: number }>)
      fields.set(row.ntid, (fields.get(row.ntid) ?? 0) + 1);
    for (const row of collection
      .prepare("SELECT id, config FROM notetypes")
      .all() as Array<{ id: number; config: Buffer | null }>)
      types.set(row.id, {
        cloze: modernKind(row.config),
        fields: fields.get(row.id) ?? 0,
      });
    return types;
  }
  const row = collection.prepare("SELECT models FROM col").get() as
    | { models: string }
    | undefined;
  const models = JSON.parse(row?.models || "{}") as Record<
    string,
    { id?: number | string; type?: number; flds?: unknown[] }
  >;
  for (const [key, model] of Object.entries(models))
    types.set(Number(model.id ?? key), {
      cloze: model.type === 1,
      fields: Array.isArray(model.flds) ? model.flds.length : 0,
    });
  return types;
}

/** Front and back for one Anki card, or why it cannot become one. */
function mapCard(
  type: NoteType,
  fields: string[],
  ord: number,
): { front: string; back: string } | "unsupported" | "empty" {
  if (type.fields < 2 || fields.length < 2) return "unsupported";
  const first = ankiText(fields[0]!);
  const second = ankiText(fields[1]!);
  if (type.cloze) {
    // The deletion this card hides is c<ord+1>; the others show their text.
    let found = false;
    const front = first.replace(
      /\{\{c(\d{1,3})::([\s\S]+?)(?:::([^{}]*?))?\}\}/g,
      (_, number: string, answer: string, hint?: string) => {
        if (Number(number) !== ord + 1) return answer;
        found = true;
        return `{{c1::${answer}${hint ? `::${hint}` : ""}}}`;
      },
    );
    if (/\{\{c\d+::image-occlusion:/.test(first)) return "empty";
    if (!found) return "unsupported";
    return { front, back: second || clozeAnswer(front) };
  }
  if (ord > 1) return "unsupported";
  const [front, back] = ord === 0 ? [first, second] : [second, first];
  if (!front || !back) return "empty";
  return { front, back };
}

const BUTTONS: Rating[] = ["again", "hard", "good", "easy"];

/** Unpacks the collection into its own folder, opens it read-only and hands it to `use`, then deletes the folder. */
function withCollection<T>(
  bytes: Uint8Array,
  use: (collection: Database.Database, modern: boolean) => T,
): T {
  let archive;
  try {
    archive = openZip(bytes, {
      maxEntries: MAX_ENTRIES,
      maxEntryBytes: MAX_COLLECTION_BYTES,
      maxTotalBytes: MAX_COLLECTION_BYTES,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "archive-too-large")
      return fail("anki-too-large");
    return fail("anki-not-package");
  }
  const modern = archive.has("collection.anki21b");
  const name = ["collection.anki21b", "collection.anki21", "collection.anki2"].find(
    (candidate) => archive.has(candidate),
  );
  if (!name) return fail("anki-not-package");
  // The legacy file next to a .anki21b is a stub that holds one "update Anki" note, so never fall back to it.
  if (modern && typeof zstdDecompressSync !== "function")
    return fail("anki-modern-unsupported");
  let data: Uint8Array;
  try {
    data = archive.read(name)!;
    if (modern)
      data = zstdDecompressSync(data, { maxOutputLength: MAX_COLLECTION_BYTES });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "archive-too-large" ||
        (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
    )
      return fail("anki-too-large");
    return fail("anki-not-package");
  }
  const folder = mkdtempSync(join(tmpdir(), "pyxis-anki-"));
  let collection: Database.Database | undefined;
  try {
    const file = join(folder, "collection.db");
    writeFileSync(file, data, { mode: 0o600 });
    try {
      collection = new Database(file, { readonly: true, fileMustExist: true });
      collection.prepare("SELECT COUNT(*) FROM notes").get();
    } catch {
      return fail("anki-not-package");
    }
    return use(collection, modern);
  } finally {
    collection?.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Reads the cards of a package. `history` also reads each card's reviews. */
export function readApkg(
  bytes: Uint8Array,
  options: { history?: boolean; now?: number } = {},
): AnkiPackage {
  const now = options.now ?? Date.now();
  return withCollection(bytes, (collection, modern) => {
    let types: Map<number, NoteType>;
    let counts: { notes: number; cards: number; reviews: number };
    try {
      types = readNoteTypes(collection, modern);
      counts = {
        notes: (collection.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n,
        cards: (collection.prepare("SELECT COUNT(*) AS n FROM cards").get() as { n: number }).n,
        reviews: (
          collection
            .prepare("SELECT COUNT(*) AS n FROM revlog WHERE ease BETWEEN 1 AND 4 AND type != 4")
            .get() as { n: number }
        ).n,
      };
    } catch {
      return fail("anki-not-package");
    }
    if (counts.notes > MAX_NOTES || counts.cards > MAX_CARDS)
      return fail("anki-too-large");
    const notes = new Map<number, { mid: number; fields: string[] }>();
    for (const row of collection
      .prepare("SELECT id, mid, flds FROM notes")
      .iterate() as Iterable<{ id: number; mid: number; flds: string }>)
      notes.set(row.id, { mid: row.mid, fields: row.flds.split("\x1f") });
    const reviewsOf = collection.prepare(
      `SELECT id, ease FROM revlog WHERE cid = ? AND ease BETWEEN 1 AND 4 AND type != 4
       ORDER BY id DESC LIMIT ${MAX_REVIEWS_PER_CARD}`,
    );
    const result: AnkiPackage = {
      format: modern ? "modern" : "legacy",
      cards: [],
      skipped: { unsupported: 0, empty: 0 },
      reviewCount: counts.reviews,
    };
    for (const card of collection
      .prepare("SELECT id, nid, ord, queue FROM cards ORDER BY id")
      .iterate() as Iterable<{ id: number; nid: number; ord: number; queue: number }>) {
      const note = notes.get(card.nid);
      const type = note && types.get(note.mid);
      const mapped = note && type ? mapCard(type, note.fields, card.ord) : "unsupported";
      if (mapped === "unsupported" || mapped === "empty") {
        result.skipped[mapped] += 1;
        continue;
      }
      if (
        mapped.front.length > MAX_FIELD_CHARS ||
        mapped.back.length > MAX_FIELD_CHARS
      ) {
        result.skipped.unsupported += 1;
        continue;
      }
      const reviews: AnkiCard["reviews"] = [];
      if (options.history) {
        for (const row of (
          reviewsOf.all(card.id) as Array<{ id: number; ease: number }>
        ).reverse()) {
          // Revlog ids are the time of the review in milliseconds. Odd ones are dropped.
          if (row.id < EARLIEST_REVIEW || row.id > now) continue;
          reviews.push({ at: row.id, rating: BUTTONS[row.ease - 1]! });
        }
      }
      result.cards.push({
        front: mapped.front,
        back: mapped.back,
        suspended: card.queue === -1,
        reviews,
      });
    }
    return result;
  });
}

export type AnkiImportResult = {
  imported: number;
  /** Already in the topic with the same front and back. */
  duplicates: number;
  unsupported: number;
  empty: number;
  /** Cards that kept review history, and the reviews replayed for them. */
  withHistory: number;
  reviews: number;
};

/** Adds the package's cards to a topic. All or nothing. */
export function importApkg(
  db: Database.Database,
  bytes: Uint8Array,
  input: { planId: string; topicId: string; history: boolean },
  now = Date.now(),
): AnkiImportResult {
  const topic = db
    .prepare("SELECT 1 FROM topics WHERE id = ? AND plan_id = ? AND archived_at IS NULL")
    .get(input.topicId, input.planId);
  if (!topic) throw new Error("topic-missing");
  const parsed = readApkg(bytes, { history: input.history, now });
  const result: AnkiImportResult = {
    imported: 0,
    duplicates: 0,
    unsupported: parsed.skipped.unsupported,
    empty: parsed.skipped.empty,
    withHistory: 0,
    reviews: 0,
  };
  const known = new Set(
    (
      db
        .prepare("SELECT front, back FROM cards WHERE plan_id = ? AND topic_id = ?")
        .all(input.planId, input.topicId) as Array<{ front: string; back: string }>
    ).map((card) => `${card.front}\u0000${card.back}`),
  );
  const addReview = db.prepare(
    `INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    parsed.cards.forEach((card, index) => {
      const key = `${card.front}\u0000${card.back}`;
      if (known.has(key)) {
        result.duplicates += 1;
        return;
      }
      known.add(key);
      // One millisecond apart, so the cards keep the order of the package.
      const { id } = saveCard(
        db,
        { planId: input.planId, topicId: input.topicId, front: card.front, back: card.back },
        now + index,
      );
      if (card.suspended) setSuspended(db, id, true);
      if (!card.reviews.length) return;
      let state = newCard(card.reviews[0]!.at);
      let last = 0;
      for (const item of card.reviews) {
        const at = Math.max(item.at, last + 1);
        last = at;
        state = review(state, item.rating, at);
        addReview.run(uuidv7(at), id, item.rating, JSON.stringify(state), at);
      }
      result.withHistory += 1;
      result.reviews += card.reviews.length;
    });
  })();
  result.imported = parsed.cards.length - result.duplicates;
  return result;
}
