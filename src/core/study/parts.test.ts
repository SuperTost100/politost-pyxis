import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { jsonSchema, type GenerateInput } from "../engine/generate";
import { isFigureFixCall } from "../engine/recorded-plan";
import type { FigureRunner } from "../math/figures";
import { figureKey } from "../../shared/smart-text";
import { IpcError } from "../../shared/ipc";
import { exportMarkdown } from "../share/markdown";
import { removePlanSource } from "../plans/views";
import { CONTEXT_CHARS, readLesson } from "./openLesson";
import {
  ESTIMATE_MAX_MINUTES,
  MATERIAL_HEADING_CHARS,
  ESTIMATE_MIN_MINUTES,
  MAX_PARTS,
  OUTLINE_LABEL_CHARS,
  OUTLINE_PROMPT_CHARS,
  checkOutline,
  estimateMinutes,
  fallbackOutline,
  liveOutline,
  outlinePassages,
  outlineReply,
  outlineRequest,
  partBounds,
  partMinutes,
  partShape,
  partsMarkdown,
  planParts,
  rewritePartSection,
  writePart,
  type OutlinePassage,
  type OutlineReply,
  type OutlineRequest,
  type PlannedPart,
} from "./parts";
import { partOfText } from "./partText";

/** Passages of `sizes` characters each, under the given headings (null for none), all from one file unless `files` says. */
function passages(
  sizes: number[],
  sections: Array<string | null> = [],
  files: Array<[string, string]> = [],
): OutlinePassage[] {
  return sizes.map((size, index) => ({
    id: `ps${String(index + 1).padStart(3, "0")}`,
    text: "x".repeat(size),
    section: sections[index] ?? null,
    fileId: files[index]?.[0] ?? "book",
    file: files[index]?.[1] ?? "Dispense",
  }));
}

/** What every outline must hold: one part at least, at most `MAX_PARTS`, every passage once and in reading order, titles set and distinct. */
function expectSound(parts: PlannedPart[], all: readonly OutlinePassage[], most = MAX_PARTS) {
  expect(parts.length).toBeGreaterThanOrEqual(1);
  expect(parts.length).toBeLessThanOrEqual(most);
  expect(parts.flatMap((part) => part.passageIds)).toEqual(all.map((passage) => passage.id));
  if (all.length > 0) for (const part of parts) expect(part.passageIds.length).toBeGreaterThan(0);
  const titles = parts.map((part) => part.title.toLowerCase().replace(/\s+/g, ""));
  for (const title of titles) expect(title).not.toBe("");
  expect(new Set(titles).size).toBe(titles.length);
  for (const part of parts) expect(part.title.length).toBeLessThanOrEqual(80);
}

const reply = (...parts: Array<[string, string[]]>): OutlineReply => ({
  lessonParts: parts.map(([title, labels]) => ({ title, about: `Dopo ${title} sai farlo.`, passages: labels })),
});

const ids = ["a", "b", "c", "d", "e", "f"];

describe("partBounds", () => {
  it("makes a topic of up to 7,000 characters, or of one passage, one part with no planning call", () => {
    expect(partBounds(0, 0)).toBeNull();
    expect(partBounds(7_000, 12)).toBeNull();
    expect(partBounds(90_000, 1)).toBeNull();
    expect(partBounds(7_001, 2)).toEqual({ target: 2, min: 2, max: 2 });
  });

  it("aims at one part per 6,000 characters, between 2 and 8, and lets the reply move it by one", () => {
    expect(partBounds(7_001, 20)).toEqual({ target: 2, min: 2, max: 3 });
    expect(partBounds(20_000, 20)).toEqual({ target: 3, min: 2, max: 4 });
    expect(partBounds(48_000, 20)).toEqual({ target: 8, min: 7, max: 8 });
    expect(partBounds(200_000, 300)).toEqual({ target: 8, min: 7, max: 8 });
  });

  it("never asks for more parts than the topic has passages", () => {
    expect(partBounds(48_000, 3)).toEqual({ target: 3, min: 2, max: 3 });
    expect(partBounds(48_000, 5)).toEqual({ target: 5, min: 4, max: 5 });
  });
});

describe("estimateMinutes", () => {
  it("reads the material at 1,500 characters a minute plus 3, between 4 and 8", () => {
    expect(estimateMinutes(0)).toBe(ESTIMATE_MIN_MINUTES);
    expect(estimateMinutes(3_000)).toBe(5);
    expect(estimateMinutes(6_000)).toBe(7);
    expect(estimateMinutes(500_000)).toBe(ESTIMATE_MAX_MINUTES);
  });
});

describe("outlineReply", () => {
  it("turns into a JSON schema the engines accept", () => {
    expect(() => jsonSchema(outlineReply)).not.toThrow();
  });

  it("refuses an empty title, a label that is not a passage label and more than 9 parts", () => {
    const ok = { lessonParts: [{ title: "Intorni", about: "", passages: ["P1"] }] };
    expect(outlineReply.safeParse(ok).success).toBe(true);
    expect(outlineReply.safeParse({ lessonParts: [{ title: "   ", about: "", passages: ["P1"] }] }).success).toBe(false);
    expect(outlineReply.safeParse({ lessonParts: [{ title: "Intorni", about: "", passages: ["intro"] }] }).success).toBe(false);
    expect(outlineReply.safeParse({ lessonParts: [] }).success).toBe(false);
    expect(outlineReply.safeParse({ lessonParts: Array(10).fill(ok.lessonParts[0]) }).success).toBe(false);
  });

  it("ignores minutes a reply writes: the code estimates them", () => {
    const parsed = outlineReply.parse({ lessonParts: [{ title: "Intorni", about: "", passages: ["P1"], minutes: 999 }] });
    expect(parsed.lessonParts[0]).toEqual({ title: "Intorni", about: "", passages: ["P1"] });
  });
});

describe("checkOutline", () => {
  const bounds = { min: 2, max: 3 };

  it("accepts a sound reply as it is", () => {
    const checked = checkOutline(reply(["Intorni", ["P1", "P2"]], ["Aperti", ["P3", "P4"]], ["Chiusi", ["P5", "P6"]]), ids, bounds);
    expect(checked).toEqual({
      ok: true,
      parts: [
        { title: "Intorni", about: "Dopo Intorni sai farlo.", passageIds: ["a", "b"] },
        { title: "Aperti", about: "Dopo Aperti sai farlo.", passageIds: ["c", "d"] },
        { title: "Chiusi", about: "Dopo Chiusi sai farlo.", passageIds: ["e", "f"] },
      ],
    });
  });

  it("drops a label that is not in the list", () => {
    const checked = checkOutline(reply(["Intorni", ["P1", "P9", "P2", "P3"]], ["Aperti", ["P4", "P05", "P5", "P6"]]), ids, bounds);
    expect(checked.ok && checked.parts.map((part) => part.passageIds)).toEqual([["a", "b", "c"], ["d", "e", "f"]]);
  });

  it("keeps a passage listed twice in the first part that lists it", () => {
    const checked = checkOutline(reply(["Intorni", ["P1", "P2", "P3"]], ["Aperti", ["P3", "P4", "P5", "P6"]]), ids, bounds);
    expect(checked.ok && checked.parts.map((part) => part.passageIds)).toEqual([["a", "b", "c"], ["d", "e", "f"]]);
  });

  it("gives a passage in no part to the part of the nearest earlier passage, or to the first part", () => {
    const checked = checkOutline(reply(["Intorni", ["P2"]], ["Aperti", ["P4", "P6"]]), ids, bounds);
    expect(checked.ok && checked.parts.map((part) => part.passageIds)).toEqual([["a", "b", "c"], ["d", "e", "f"]]);
  });

  it("sorts a part's passages into reading order and the parts by their first passage", () => {
    const checked = checkOutline(reply(["Chiusi", ["P6", "P5"]], ["Intorni", ["P2", "P1"]], ["Aperti", ["P4", "P3"]]), ids, bounds);
    expect(checked.ok && checked.parts.map((part) => [part.title, part.passageIds])).toEqual([
      ["Intorni", ["a", "b"]],
      ["Aperti", ["c", "d"]],
      ["Chiusi", ["e", "f"]],
    ]);
  });

  it("lets a part gather passages on its subject that are apart, as a book chapter and the slides on it", () => {
    // P1 and P3 are the book's and the slides' pages on neighbourhoods, P2 and P4 on open sets.
    const four = ["book-intorni", "book-aperti", "slides-intorni", "slides-aperti"];
    const checked = checkOutline(reply(["Aperti", ["P4", "P2"]], ["Intorni", ["P3", "P1"]]), four, { min: 2, max: 3 });
    expect(checked).toEqual({
      ok: true,
      parts: [
        { title: "Intorni", about: "Dopo Intorni sai farlo.", passageIds: ["book-intorni", "slides-intorni"] },
        { title: "Aperti", about: "Dopo Aperti sai farlo.", passageIds: ["book-aperti", "slides-aperti"] },
      ],
    });
  });

  it("drops a part left with no passage, and counts what is left", () => {
    const kept = checkOutline(reply(["Intorni", ["P1", "P2", "P3"]], ["Vuota", ["P2", "P77"]], ["Aperti", ["P4", "P5", "P6"]]), ids, bounds);
    expect(kept.ok && kept.parts.map((part) => part.title)).toEqual(["Intorni", "Aperti"]);
    const short = checkOutline(reply(["Intorni", ["P1", "P2"]], ["Vuota", ["P1", "P99"]]), ids, bounds);
    expect(short).toEqual({ ok: false, problems: ["The reply had 1 parts with passages from the list. Use between 2 and 3."] });
  });

  it("rejects too few and too many parts", () => {
    expect(checkOutline(reply(["Tutto", ["P1", "P2", "P3", "P4", "P5", "P6"]]), ids, bounds)).toEqual({
      ok: false,
      problems: ["The reply had 1 parts with passages from the list. Use between 2 and 3."],
    });
    const many = reply(...ids.map((_, index): [string, string[]] => [`Idea ${index + 1}`, [`P${index + 1}`]]));
    expect(checkOutline(many, ids, bounds)).toEqual({
      ok: false,
      problems: ["The reply had 6 parts with passages from the list. Use between 2 and 3."],
    });
    expect(checkOutline(many, ids, { min: 4, max: 4 })).toEqual({
      ok: false,
      problems: ["The reply had 6 parts with passages from the list. Use 4."],
    });
  });

  it("rejects an empty title and a title two parts share, ignoring case and spaces", () => {
    expect(checkOutline(reply(["  ", ["P1", "P2", "P3"]], ["Aperti", ["P4", "P5", "P6"]]), ids, bounds)).toEqual({
      ok: false,
      problems: ["A part has no title. Give every part a title."],
    });
    expect(
      checkOutline(reply(["Insiemi aperti", ["P1", "P2"]], ["insiemi  Aperti", ["P3", "P4"]], ["INSIEMIAPERTI", ["P5", "P6"]]), ids, bounds),
    ).toEqual({
      ok: false,
      problems: ['Two parts have the title "insiemi  Aperti". Give each part its own title.'],
    });
  });

  it("lists every broken rule at once", () => {
    const checked = checkOutline(reply(["Uno", ["P1"]], ["uno", ["P2"]], ["", ["P3"]], ["Due", ["P4"]]), ids, bounds);
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.problems).toHaveLength(3);
  });

  it("never accepts a reply that leaves a passage out, uses one twice or breaks the order", () => {
    // Replies made at random from a fixed seed: whatever is accepted gives every passage to one part, in order.
    let seed = 7;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const labels = Array.from({ length: 12 }, (_, index) => `P${index + 1}`);
    const twelve = labels.map((_, index) => `id${index}`);
    let accepted = 0;
    let interleaved = 0;
    for (let round = 0; round < 500; round++) {
      const count = 1 + Math.floor(random() * 9);
      // Half the replies deal the labels round the parts, as a reply that groups a book and its slides by subject does;
      // the others pick labels at random, with overlaps, gaps and unknown labels.
      const dealt = round % 2 === 0;
      const parts = Array.from({ length: count }, (_, index): [string, string[]] => [
        random() < 0.05 ? "" : `Idea ${random() < 0.05 ? 0 : index}`,
        (dealt
          ? labels.filter((_, at) => at % count === index && random() < 0.95)
          : labels.filter(() => random() < 0.25)
        ).concat(random() < 0.2 ? ["P40"] : []),
      ]);
      const checked = checkOutline(reply(...parts), twelve, { min: 3, max: 5 });
      if (!checked.ok) {
        expect(checked.problems.length).toBeGreaterThan(0);
        continue;
      }
      accepted += 1;
      expect(checked.parts.length).toBeGreaterThanOrEqual(3);
      expect(checked.parts.length).toBeLessThanOrEqual(5);
      expect(checked.parts.flatMap((part) => part.passageIds).sort()).toEqual([...twelve].sort());
      const firsts = checked.parts.map((part) => twelve.indexOf(part.passageIds[0]!));
      expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
      for (const part of checked.parts) {
        const order = part.passageIds.map((id) => twelve.indexOf(id));
        expect(order).toEqual([...order].sort((a, b) => a - b));
        if (order.some((at, index) => index > 0 && at !== order[index - 1]! + 1)) interleaved += 1;
      }
    }
    expect(accepted).toBeGreaterThan(20);
    expect(interleaved).toBeGreaterThan(20);
  });
});

describe("fallbackOutline", () => {
  it("makes a topic with no passages one part", () => {
    expect(fallbackOutline([], 4, "Italian")).toEqual([{ title: "Parte 1", about: "", passageIds: [] }]);
  });

  it("keeps a single passage, however long, as one part", () => {
    const one = passages([400]);
    expect(fallbackOutline(one, 3, "Italian")).toEqual([{ title: "Parte 1", about: "", passageIds: ["ps001"] }]);
    const huge = passages([250_000], ["3.4 Teorema di Weierstrass"]);
    const parts = fallbackOutline(huge, 8, "Italian");
    expect(parts).toEqual([{ title: "Teorema di Weierstrass", about: "", passageIds: ["ps001"] }]);
  });

  it("cuts hundreds of passages into the parts asked for, of similar size", () => {
    const many = passages(Array.from({ length: 400 }, (_, index) => 300 + ((index * 37) % 900)));
    const parts = fallbackOutline(many, 8, "English");
    expectSound(parts, many);
    expect(parts).toHaveLength(8);
    const size = (part: PlannedPart) => part.passageIds.reduce((sum, id) => sum + many.find((p) => p.id === id)!.text.length, 0);
    const sizes = parts.map(size);
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(1.2);
    expect(parts.map((part) => part.title)).toEqual(["Part 1", "Part 2", "Part 3", "Part 4", "Part 5", "Part 6", "Part 7", "Part 8"]);
  });

  it("never makes more parts than passages, nor an empty one", () => {
    const three = passages([20_000, 15_000, 30_000]);
    const parts = fallbackOutline(three, 8, "Italian");
    expectSound(parts, three);
    expect(parts).toHaveLength(3);
  });

  it("cuts where the section changes when that is within a quarter of the target size", () => {
    // Ten passages of 1,000 characters, sections of 4 and 6: the halves would cut after the fifth, the section after the fourth.
    const sections = ["2.1 Intorni", null, null, null, "2.2 Aperti e chiusi", null, null, null, null, null];
    const ten = passages(Array(10).fill(1_000), sections);
    const parts = fallbackOutline(ten, 2, "Italian");
    expect(parts.map((part) => [part.title, part.passageIds.length])).toEqual([
      ["Intorni", 4],
      ["Aperti e chiusi", 6],
    ]);
    // A section change ahead within the slack waits for it too: sections of 6 and 4 cut after the sixth.
    const later = passages(Array(10).fill(1_000), ["2.1 Intorni", null, null, null, null, null, "2.2 Aperti", null, null, null]);
    expect(fallbackOutline(later, 2, "Italian").map((part) => part.passageIds.length)).toEqual([6, 4]);
    // A section change far from the target does not move the cut.
    const far = passages(Array(10).fill(1_000), ["2.1 Intorni", null, "2.2 Aperti", null, null, null, null, null, null, null]);
    expect(fallbackOutline(far, 2, "Italian").map((part) => [part.title, part.passageIds.length])).toEqual([
      ["Intorni", 5],
      ["Parte 2", 5],
    ]);
  });

  it("names a repeated heading with its number and a part with no heading after its place", () => {
    const sections = ["1. Moti", null, null, "1. Moti", null, null, null, null, null];
    const nine = passages(Array(9).fill(1_000), sections);
    const parts = fallbackOutline(nine, 3, "Italian");
    expectSound(parts, nine);
    expect(parts.map((part) => part.title)).toEqual(["Moti", "Moti (2)", "Parte 3"]);
  });

  it("returns a sound outline for any topic and part count", () => {
    let seed = 11;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    for (let round = 0; round < 300; round++) {
      const length = Math.floor(random() * 60);
      const sizes = Array.from({ length }, () => 1 + Math.floor(random() * (random() < 0.1 ? 40_000 : 3_000)));
      const sections = sizes.map(() => (random() < 0.3 ? `${Math.floor(random() * 4)}.1 Sezione ${Math.floor(random() * 3)}` : null));
      const all = passages(sizes, sections);
      const count = Math.floor(random() * 12) - 1;
      const parts = fallbackOutline(all, count, random() < 0.5 ? "Italian" : "English");
      expectSound(parts, all, Math.max(1, Math.min(MAX_PARTS, count)));
    }
  });
});

describe("outlineRequest", () => {
  it("lists every passage with its label, its heading when it changes and its length", () => {
    const four = passages([3_000, 2_000, 4_000, 1_000], ["2.1 Intorni", "2.1 Intorni", null, "2.2 Aperti"]);
    const request = outlineRequest("Funzioni di più variabili", four, { target: 2, min: 2, max: 3 })!;
    expect(request.topic).toBe("Funzioni di più variabili");
    expect(request.parts).toEqual({ target: 2, min: 2, max: 3 });
    expect(request.passages.map(({ excerpt: _, ...entry }) => entry)).toEqual([
      { label: "P1", file: "Dispense", section: "2.1 Intorni", chars: 3_000 },
      { label: "P2", chars: 2_000 },
      { label: "P3", chars: 4_000 },
      { label: "P4", section: "2.2 Aperti", chars: 1_000 },
    ]);
    // A short topic sends each passage whole.
    expect(request.passages[3]!.excerpt).toBe("x".repeat(1_000));
  });

  it("names the file where it changes, and the heading again in the new file", () => {
    const files: Array<[string, string]> = [
      ["book", "Analisi 2"],
      ["book", "Analisi 2"],
      ["slides", "Slide del corso"],
      ["slides", "Slide del corso"],
      ["notes", "Slide del corso"],
    ];
    const five = passages([3_000, 3_000, 2_000, 2_000, 1_000], ["2.1 Intorni", null, "2.1 Intorni", null, null], files);
    const request = outlineRequest("Funzioni di più variabili", five, { target: 2, min: 2, max: 3 })!;
    expect(request.passages.map(({ excerpt: _, ...entry }) => entry)).toEqual([
      { label: "P1", file: "Analisi 2", section: "2.1 Intorni", chars: 3_000 },
      { label: "P2", chars: 3_000 },
      { label: "P3", file: "Slide del corso", section: "2.1 Intorni", chars: 2_000 },
      { label: "P4", chars: 2_000 },
      // Another file with the same name is still another file.
      { label: "P5", file: "Slide del corso", chars: 1_000 },
    ]);
    const long = passages([3_000, 3_000], ["2.1 Intorni", null], [["book", "x".repeat(500)], ["book", "x".repeat(500)]]);
    const cut = outlineRequest("Limiti", long, { target: 2, min: 2, max: 2 })!;
    expect(cut.passages[0]!.file).toBe(`${"x".repeat(OUTLINE_LABEL_CHARS - 1)}…`);
  });

  it("cuts the excerpts so the list stays within the call bound, also with characters JSON escapes", () => {
    const many = Array.from({ length: 300 }, (_, index) => ({
      id: `p${index}`,
      text: `"Limite" \\ di f(x,y)\n${"è ".repeat(2_000)}`,
      section: index % 10 === 0 ? `2.${index / 10} Sezione` : null,
      fileId: index < 150 ? "book" : "slides",
      file: index < 150 ? "Analisi Matematica 2, Bramanti Pagani Salsa" : "Slide del corso",
    }));
    const request = outlineRequest("Limiti", many, { target: 8, min: 7, max: 8 })!;
    expect(JSON.stringify(request).length).toBeLessThanOrEqual(OUTLINE_PROMPT_CHARS);
    const problems = Array.from({ length: 9 }, (_, index) => `Two parts have the title "${"Idea ".repeat(16)}${index}". Give each part its own title.`);
    const again = outlineRequest("Limiti", many, { target: 8, min: 7, max: 8 }, problems)!;
    expect(again.problems).toEqual(problems);
    expect(JSON.stringify(again).length).toBeLessThanOrEqual(OUTLINE_PROMPT_CHARS);
    expect(request.passages).toHaveLength(300);
    expect(request.passages[0]!.excerpt.length).toBeGreaterThan(5);
  });

  it("gives up when the labels alone would not fit, so the topic is cut without a call", () => {
    const tooMany = passages(Array(1_000).fill(100));
    expect(outlineRequest("Tutto", tooMany, { target: 8, min: 7, max: 8 })).toBeNull();
  });
});

/** A plan with one topic whose passages have these sizes and headings, and an engine set up. */
function workspace(sizes: number[], sections: Array<string | null> = [], language = "it") {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
    JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
  );
  db.exec(`
    INSERT INTO plans (id, title, status, content_language, created_at, updated_at) VALUES ('p', 'Analisi 2', 'ready', '${language}', 1, 1);
    INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t', 'p', 'Funzioni di più variabili', 0, 1);
    INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('s', 'pdf', 'Dispense', 'ready', 1, 1);
  `);
  const insert = db.prepare(
    "INSERT INTO passages (id, source_id, text, section_path, created_at) VALUES (?, 's', ?, ?, ?)",
  );
  const link = db.prepare("INSERT INTO topic_passages (topic_id, passage_id) VALUES ('t', ?)");
  sizes.forEach((size, index) => {
    const id = `ps${String(index + 1).padStart(3, "0")}`;
    insert.run(id, `${index + 1} `.padEnd(size, "x"), sections[index] ?? null, index + 1);
    link.run(id);
  });
  return db;
}

/** Recorded replies, answered in turn, and the calls that asked for them. */
function recorded(...replies: Array<unknown | Error | string>) {
  const calls: Array<{ system?: string; prompt: string }> = [];
  const run: GenerateInput["run"] = async (input) => {
    calls.push({ system: input.system, prompt: input.prompt });
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (next instanceof Error) throw next;
    if (typeof next === "string") return { text: next, provider: "claude", model: "test-model", inputTokens: 1 };
    return { structured: next, text: JSON.stringify(next), provider: "claude", model: "test-model", inputTokens: 1 };
  };
  return { calls, run, requests: () => calls.map((call) => JSON.parse(call.prompt) as OutlineRequest) };
}

const rows = (db: ReturnType<typeof workspace>) => ({
  outlines: db.prepare("SELECT COUNT(*) FROM lesson_outlines").pluck().get(),
  parts: db.prepare("SELECT COUNT(*) FROM lesson_parts").pluck().get(),
});

describe("planParts", () => {
  it("saves a topic of up to 7,000 characters as one part, with no call", async () => {
    const db = workspace([3_000, 3_500], ["2.1 Intorni", "2.2 Aperti"]);
    const engine = recorded(new Error("no call expected"));
    const outline = await planParts(db, { planId: "p", topicId: "t", run: engine.run });
    expect(engine.calls).toHaveLength(0);
    expect(outline).toMatchObject({ planId: "p", topicId: "t", origin: "single", wording: null, replacesItemId: null });
    expect(outline.parts).toEqual([
      expect.objectContaining({ position: 1, kind: "part", title: "Funzioni di più variabili", about: "", passageIds: ["ps001", "ps002"], minutes: 7, itemId: null, summary: null, doneAt: null }),
    ]);
    const row = db.prepare("SELECT engine_provider, prompt_template, grounding FROM lesson_outlines").get();
    expect(row).toEqual({ engine_provider: null, prompt_template: null, grounding: "sources" });
  });

  it("saves a topic with no passages as one part from general knowledge", async () => {
    const db = workspace([]);
    const outline = await planParts(db, { planId: "p", topicId: "t", run: recorded(new Error("no call")).run });
    expect(outline.origin).toBe("single");
    expect(outline.parts.map((part) => [part.title, part.passageIds, part.minutes])).toEqual([["Funzioni di più variabili", [], 4]]);
    expect(db.prepare("SELECT grounding FROM lesson_outlines").pluck().get()).toBe("general");
  });

  it("plans the parts with the model, adds the recap and estimates the minutes", async () => {
    // 24,000 characters in six passages: a target of 4 parts, 3 to 5 allowed.
    const db = workspace(Array(6).fill(4_000), ["2.1 Intorni", null, "2.2 Aperti", null, "2.3 Compatti", null]);
    const engine = recorded(
      reply(["Intorni e distanza", ["P1", "P2"]], ["Insiemi aperti", ["P3"]], ["Insiemi chiusi", ["P4"]], ["Compatti", ["P5", "P6"]]),
    );
    const outline = await planParts(db, { planId: "p", topicId: "t", run: engine.run });
    expect(engine.calls).toHaveLength(1);
    const request = engine.requests()[0]!;
    expect(request.parts).toEqual({ target: 4, min: 3, max: 5 });
    expect(request.passages.map((passage) => passage.label)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6"]);
    expect(request.problems).toBeUndefined();
    expect(engine.calls[0]!.system).toContain("Write all output in Italian.");
    expect(outline.origin).toBe("model");
    expect(outline.parts.map((part) => [part.position, part.kind, part.title, part.passageIds, part.minutes])).toEqual([
      [1, "part", "Intorni e distanza", ["ps001", "ps002"], 8],
      [2, "part", "Insiemi aperti", ["ps003"], 6],
      [3, "part", "Insiemi chiusi", ["ps004"], 6],
      [4, "part", "Compatti", ["ps005", "ps006"], 8],
      [5, "recap", "Ripasso del capitolo", [], 4],
    ]);
    expect(outline.parts[0]!.about).toBe("Dopo Intorni e distanza sai farlo.");
    expect(
      db.prepare("SELECT engine_provider, model_id, model_source, prompt_template, prompt_version, grounding FROM lesson_outlines").get(),
    ).toEqual({
      engine_provider: "claude",
      model_id: "test-model",
      model_source: "reported",
      prompt_template: "lesson.outline",
      prompt_version: "outline-2",
      grounding: "sources",
    });
    // Planning again returns the saved outline without a call.
    expect(await planParts(db, { planId: "p", topicId: "t", run: engine.run })).toEqual(outline);
    expect(engine.calls).toHaveLength(1);
  });

  it("adds no recap to two teaching parts", async () => {
    const db = workspace([4_000, 4_000]);
    const outline = await planParts(db, { planId: "p", topicId: "t", run: recorded(reply(["Uno", ["P1"]], ["Due", ["P2"]])).run });
    expect(outline.parts.map((part) => part.kind)).toEqual(["part", "part"]);
  });

  it("reads a reply with prose and a fence around the JSON", async () => {
    const db = workspace([4_000, 4_000]);
    const text = `Ecco il piano:\n\`\`\`json\n${JSON.stringify(reply(["Uno", ["P1"]], ["Due", ["P2"]]))}\n\`\`\`\nBuono studio!`;
    const outline = await planParts(db, { planId: "p", topicId: "t", run: recorded(text).run });
    expect(outline.origin).toBe("model");
    expect(outline.parts.map((part) => part.title)).toEqual(["Uno", "Due"]);
  });

  it("asks once more with the problems, and keeps the second reply when it is sound", async () => {
    const db = workspace(Array(6).fill(4_000));
    const engine = recorded(
      reply(["Tutto", ["P1", "P2", "P3", "P4", "P5", "P6"]]),
      reply(["Uno", ["P1", "P2"]], ["Due", ["P3", "P4"]], ["Tre", ["P5", "P6"]]),
    );
    const outline = await planParts(db, { planId: "p", topicId: "t", run: engine.run });
    expect(engine.calls).toHaveLength(2);
    const [first, second] = engine.requests();
    expect(first!.problems).toBeUndefined();
    expect(second!.problems).toEqual(["The reply had 1 parts with passages from the list. Use between 3 and 5."]);
    // The same request but for the problems: the excerpts may only be shorter, to leave room for them.
    const bare = (request: OutlineRequest) => request.passages.map(({ excerpt: _, ...entry }) => entry);
    expect([second!.topic, second!.parts, bare(second!)]).toEqual([first!.topic, first!.parts, bare(first!)]);
    second!.passages.forEach((entry, index) => expect(first!.passages[index]!.excerpt.startsWith(entry.excerpt)).toBe(true));
    // Each request goes out within the bound, as it is sent.
    for (const call of engine.calls) expect(call.prompt.length).toBeLessThanOrEqual(OUTLINE_PROMPT_CHARS);
    expect(outline.origin).toBe("model");
    expect(outline.parts.map((part) => part.title)).toEqual(["Uno", "Due", "Tre", "Ripasso del capitolo"]);
  });

  it("plans a topic whose headings and title are long with the model, within the bound", async () => {
    // 60 passages, each under its own heading of 1,000 characters: the headings alone would be 60,000 characters.
    const headings = Array.from({ length: 60 }, (_, index) => `${index + 1}.1 ${"Teorema di Weierstrass ".repeat(44)}`);
    const db = workspace(Array(60).fill(500), headings);
    db.prepare("UPDATE topics SET title = ?").run(`Funzioni ${"di più variabili ".repeat(2_000)}`);
    const parts = Array.from({ length: 5 }, (_, index): [string, string[]] => [
      `Idea ${index + 1}`,
      Array.from({ length: 12 }, (_, at) => `P${index * 12 + at + 1}`),
    ]);
    const first = reply(["Tutto", ["P1"]]);
    const engine = recorded(first, reply(...parts));
    const outline = await planParts(db, { planId: "p", topicId: "t", run: engine.run });
    expect(outline.origin).toBe("model");
    expect(engine.calls).toHaveLength(2);
    for (const call of engine.calls) expect(call.prompt.length).toBeLessThanOrEqual(OUTLINE_PROMPT_CHARS);
    const [request] = engine.requests();
    expect(Array.from(request!.topic)).toHaveLength(OUTLINE_LABEL_CHARS);
    expect(request!.topic.endsWith("…")).toBe(true);
    expect(request!.passages).toHaveLength(60);
    for (const entry of request!.passages) {
      expect(Array.from(entry.section!)).toHaveLength(OUTLINE_LABEL_CHARS);
      expect(entry.section!.endsWith("…")).toBe(true);
    }
  });

  it("cuts the topic in code after a second rejected reply", async () => {
    const db = workspace(Array(6).fill(4_000), ["2.1 Intorni", null, null, "2.2 Aperti", null, null]);
    const twice = reply(["Uguale", ["P1", "P2", "P3"]], ["uguale", ["P4", "P5"]], ["Altro", ["P6"]]);
    const engine = recorded(twice, twice);
    const outline = await planParts(db, { planId: "p", topicId: "t", run: engine.run });
    expect(engine.calls).toHaveLength(2);
    expect(outline.origin).toBe("fallback");
    expectSound(outline.parts.filter((part) => part.kind === "part"), outlinePassages(db, "t"));
    expect(outline.parts.filter((part) => part.kind === "part")).toHaveLength(4);
    expect(outline.parts.at(-1)!.kind).toBe("recap");
    expect(db.prepare("SELECT engine_provider, prompt_template FROM lesson_outlines").get()).toEqual({
      engine_provider: null,
      prompt_template: null,
    });
  });

  it("cuts the topic in code when the schema repair cannot fix the reply", async () => {
    const db = workspace(Array(6).fill(4_000));
    const ten = { lessonParts: Array.from({ length: 10 }, (_, index) => ({ title: `Idea ${index}`, about: "", passages: [`P${index + 1}`] })) };
    const engine = recorded(ten);
    const outline = await planParts(db, { planId: "p", topicId: "t", run: engine.run });
    // The first reply and the two schema repairs `generate` asks for.
    expect(engine.calls).toHaveLength(3);
    expect(outline.origin).toBe("fallback");
    expect(outline.parts.filter((part) => part.kind === "part").flatMap((part) => part.passageIds)).toEqual(
      outlinePassages(db, "t").map((passage) => passage.id),
    );
  });

  it("cuts a topic whose passage list cannot fit the call in code, without a call", async () => {
    const db = workspace(Array(800).fill(60));
    const engine = recorded(new Error("no call expected"));
    const outline = await planParts(db, { planId: "p", topicId: "t", run: engine.run });
    expect(engine.calls).toHaveLength(0);
    expect(outline.origin).toBe("fallback");
    expect(outline.parts.filter((part) => part.kind === "part")).toHaveLength(8);
  });

  it("names the fallback's parts and recap in English for English material", async () => {
    const db = workspace([4_000, 4_000, 4_000, 4_000], [], "en");
    const bad = reply(["Same", ["P1"]], ["Same", ["P2", "P3", "P4"]]);
    const engine = recorded(bad, bad);
    const outline = await planParts(db, { planId: "p", topicId: "t", run: engine.run });
    expect(engine.calls[0]!.system).toContain("Write all output in English.");
    expect(outline.parts.map((part) => part.title)).toEqual(["Part 1", "Part 2", "Part 3", "Chapter recap"]);
  });

  it("saves nothing when the engine fails, so the next open tries again", async () => {
    const db = workspace(Array(6).fill(4_000));
    const failing = recorded(new IpcError("signed-out", "engines.errors.signed-out", { provider: "claude" }));
    await expect(planParts(db, { planId: "p", topicId: "t", run: failing.run })).rejects.toMatchObject({
      messageKey: "engines.errors.signed-out",
    });
    expect(rows(db)).toEqual({ outlines: 0, parts: 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      planParts(db, { planId: "p", topicId: "t", run: recorded(reply(["Uno", ["P1"]])).run, signal: controller.signal }),
    ).rejects.toThrow();
    expect(rows(db)).toEqual({ outlines: 0, parts: 0 });
  });

  it("saves nothing on a cancel, also for a topic that needs no call or cannot be sent", async () => {
    const controller = new AbortController();
    controller.abort();
    for (const sizes of [[3_000], Array(800).fill(60)]) {
      const db = workspace(sizes);
      const engine = recorded(new Error("no call expected"));
      await expect(planParts(db, { planId: "p", topicId: "t", run: engine.run, signal: controller.signal })).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(engine.calls).toHaveLength(0);
      expect(rows(db)).toEqual({ outlines: 0, parts: 0 });
    }
  });

  it("refuses a topic of another plan", async () => {
    const db = workspace([1_000]);
    db.exec("INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('q', 'Altro', 'ready', 1, 1)");
    await expect(planParts(db, { planId: "q", topicId: "t" })).rejects.toThrow("topic-missing");
  });
});

describe("reading parts", () => {
  it("finds the live outline of a topic and the part a lesson item is", async () => {
    const db = workspace([3_000]);
    expect(liveOutline(db, "t")).toBeNull();
    const outline = await planParts(db, { planId: "p", topicId: "t" });
    db.exec(`
      INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES ('written', 'p', 't', 'lesson', '{}', 2),
        ('old', 'p', 't', 'lesson', '{}', 1);
      UPDATE lesson_parts SET item_id = 'written';
    `);
    expect(partOfText(db, "written")).toEqual({ partId: outline.parts[0]!.id, outlineId: outline.id, position: 1, kind: "part" });
    expect(partOfText(db, "old")).toBeNull();
    // A retired outline is not the live one, and the topic can be planned again.
    db.prepare("UPDATE lesson_outlines SET retired_at = 5").run();
    expect(liveOutline(db, "t")).toBeNull();
    const again = await planParts(db, { planId: "p", topicId: "t" });
    expect(again.id).not.toBe(outline.id);
  });

  it("reads each passage's file", () => {
    const db = workspace([10, 10]);
    db.exec(`
      INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('slides', 'pdf', 'Slide del corso', 'ready', 1, 1);
      UPDATE passages SET source_id = 'slides' WHERE id = 'ps002';
    `);
    expect(outlinePassages(db, "t").map((passage) => [passage.fileId, passage.file])).toEqual([
      ["s", "Dispense"],
      ["slides", "Slide del corso"],
    ]);
  });

  it("reads a smartbook paragraph's title as its heading, and a page or slide as none", () => {
    const db = workspace([10, 10, 10, 10, 10], ["p. 3", "slide 2", "text", "1. Moti", "Capitolo 2"]);
    db.prepare("UPDATE passages SET locator_json = ? WHERE id = 'ps004'").run(JSON.stringify({ chapter: 1, title: "Velocità media" }));
    expect(outlinePassages(db, "t").map((passage) => passage.section)).toEqual([null, null, null, "Velocità media", "Capitolo 2"]);
  });
});

const words = (tag: string, count: number) => Array.from({ length: count }, (_, i) => `parola${tag}n${i}`).join(" ");
const checkBlock = (tag: string) =>
  `\`\`\`pyxis-check\n${JSON.stringify({ question: `Domanda ${tag}?`, options: ["uno", "due", "tre"], answer: 1, explanation: "Perché." })}\n\`\`\``;
const takeawayBlock = (text: string) => `\`\`\`pyxis-takeaway\n${JSON.stringify({ text })}\n\`\`\``;
const section = (title: string, count = 150, tag = title) => `## ${title}\n\n${words(tag.replace(/\W/g, ""), count)}`;

/** A reply with the shape a teaching part must have. */
function partText(tag: string): string {
  return [
    "Riprendiamo da dove eravamo.",
    section(`Passo ${tag} primo`),
    section(`Passo ${tag} secondo`),
    checkBlock(tag),
    takeawayBlock(`Hai imparato il passo ${tag}.`),
  ].join("\n\n");
}

const recapQuestion = { question: "Quale?", options: ["a", "b", "c"], answer: 0 };
const recapBlock = (count: number) =>
  `\`\`\`pyxis-recap\n${JSON.stringify({ questions: Array(count).fill(recapQuestion) })}\n\`\`\``;
const recapText = (count = 3) =>
  ["## Riepilogo\n\n- uno\n- due\n- tre\n- quattro", recapBlock(count), takeawayBlock("Hai ripassato il capitolo.")].join(
    "\n\n",
  );

const first = { kind: "part", headings: [], last: false } as const;

describe("partShape", () => {
  it("accepts a sound part and keeps its takeaway as the summary", () => {
    const shape = partShape(partText("1"), first);
    expect(shape).toMatchObject({ ok: true, summary: "Hai imparato il passo 1.", question: true });
    if (!shape.ok) return;
    expect(shape.markdown).not.toContain("pyxis-takeaway");
    expect(shape.markdown.endsWith("```")).toBe(true);
    // 300 words of prose, 4 in the opening line, 6 in the headings, and the question with its options.
    expect(shape.words).toBe(300 + 4 + 6 + 2 + 3);
  });

  it("repairs a fence around the reply, a title, a recap block and checks before the last one", () => {
    const reply = [
      "```markdown",
      "# Insiemi aperti",
      "",
      "Riprendiamo.",
      section("Primo passo"),
      checkBlock("presto"),
      section("Secondo passo"),
      recapBlock(3),
      "```pyxis-check\n{not json at all\n```",
      checkBlock("finale"),
      takeawayBlock("Sai riconoscere un insieme aperto."),
      "```",
    ].join("\n\n");
    const shape = partShape(reply, first);
    expect(shape).toMatchObject({ ok: true, summary: "Sai riconoscere un insieme aperto.", question: true });
    if (!shape.ok) return;
    expect(shape.markdown.startsWith("Riprendiamo.")).toBe(true);
    expect(shape.markdown).not.toContain("# Insiemi aperti");
    expect(shape.markdown).not.toContain("pyxis-recap");
    expect(shape.markdown.match(/pyxis-check/g)).toHaveLength(1);
    expect(shape.markdown).toContain("Domanda finale?");
    expect(shape.markdown).not.toContain("Domanda presto?");
    expect(shape.markdown).not.toMatch(/\n{3,}/);
  });

  it.each([
    ["one section", [section("Solo", 300), checkBlock("a"), takeawayBlock("Fatto.")], /has 1 ## sections\. Write 2 or 3\./],
    [
      "four sections",
      [section("A", 80), section("B", 80), section("C", 80), section("D", 80), checkBlock("a"), takeawayBlock("Fatto.")],
      /has 4 ## sections/,
    ],
    ["no check", [section("A"), section("B"), takeawayBlock("Fatto.")], /does not end with one pyxis-check/],
    [
      "text after the check",
      [section("A"), section("B"), checkBlock("a"), "E adesso un'ultima cosa.", takeawayBlock("Fatto.")],
      /does not end with one pyxis-check/,
    ],
    ["too few words", [section("A", 100), section("B", 100), checkBlock("a"), takeawayBlock("Fatto.")], /words\. Write between 250/],
    ["too many words", [section("A", 750), section("B", 750), checkBlock("a"), takeawayBlock("Fatto.")], /words\. Write between 250/],
    ["no takeaway", [section("A"), section("B"), checkBlock("a")], /pyxis-takeaway block is missing/],
    ["a long takeaway", [section("A"), section("B"), checkBlock("a"), takeawayBlock("x ".repeat(200))], /399 characters/],
  ])("rejects a part with %s, naming that rule alone", (_, blocks, problem) => {
    const shape = partShape(blocks.join("\n\n"), first);
    expect(shape.ok).toBe(false);
    if (shape.ok) return;
    expect(shape.problems).toHaveLength(1);
    expect(shape.problems[0]).toMatch(problem);
  });

  it("rejects a heading another part already has, with case, accents and punctuation ignored", () => {
    const reply = [section("Insièmi APERTI!", 150, "a"), section("Chiusura", 150), checkBlock("a"), takeawayBlock("Fatto.")];
    const shape = partShape(reply.join("\n\n"), { ...first, headings: ["Insiemi aperti", "Distanza"] });
    expect(shape).toEqual({
      ok: false,
      problems: [
        'The section "Insièmi APERTI!" has the heading of a section of another part. Teach this part\'s own step, under a heading of its own.',
      ],
    });
  });

  it("wants one section and a recap of 3 questions in the recap part, and removes its checks", () => {
    const recap = { kind: "recap", headings: [], last: false } as const;
    const sound = partShape(recapText().replace("## Riepilogo", `${checkBlock("via")}\n\n## Riepilogo`), recap);
    expect(sound).toMatchObject({ ok: true, question: true, summary: "Hai ripassato il capitolo." });
    expect(sound.ok && sound.markdown).not.toContain("pyxis-check");
    expect(partShape(recapText(2), recap)).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/does not end with one pyxis-recap of 3 questions/)],
    });
    expect(partShape(`${section("Prima", 20)}\n\n${recapText()}`, recap)).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/has 2 ## sections\. Write exactly 1\./)],
    });
  });

  it("accepts a second reply a page can show, without its question or takeaway", () => {
    const last = { ...first, last: true };
    const bare = partShape(section("Solo", 300), last);
    expect(bare).toMatchObject({ ok: true, question: false, summary: null });
    const long = partShape([section("A"), section("B"), checkBlock("a"), takeawayBlock("parola ".repeat(80))].join("\n\n"), last);
    expect(long.ok && long.summary!.length).toBeLessThanOrEqual(300);
    expect(long.ok && long.summary!.endsWith("…")).toBe(true);
    expect(partShape(["A", "B", "C", "D", "E"].map((title) => section(title, 50)).join("\n\n"), last).ok).toBe(false);
    expect(partShape([section("A", 1_100), section("B", 1_000)].join("\n\n"), last).ok).toBe(false);
    expect(partShape("", last).ok).toBe(false);
  });
});

describe("partMinutes", () => {
  it("reads 200 words a minute, adds one for the question, and keeps 2 to 12", () => {
    expect(partMinutes(0)).toBe(2);
    expect(partMinutes(1_000)).toBe(6);
    expect(partMinutes(1_001)).toBe(7);
    expect(partMinutes(5_000)).toBe(12);
  });
});

describe("writePart", () => {
  /** Six passages of 4,000 characters, each starting with its own marker, planned in four parts and a recap. */
  async function planned() {
    const db = workspace(Array(6).fill(4_000));
    db.exec("UPDATE passages SET text = 'MARK-' || id || ' ' || text");
    await planParts(db, {
      planId: "p",
      topicId: "t",
      run: recorded(reply(["Uno", ["P1", "P2"]], ["Due", ["P3", "P4"]], ["Tre", ["P5"]], ["Quattro", ["P6"]])).run,
    });
    return db;
  }
  const write = (db: ReturnType<typeof workspace>, position: number, ...replies: string[]) => {
    const engine = recorded(...replies);
    return { engine, done: writePart(db, { planId: "p", topicId: "t", position, run: engine.run, python: null }) };
  };

  it("gives the call the outline, the written parts and only this part's passages, and saves the part", async () => {
    const db = await planned();
    await write(db, 1, partText("1")).done;
    const { engine, done } = write(db, 2, partText("2"));
    const outline = await done;
    expect(engine.calls).toHaveLength(1);
    const prompt = engine.calls[0]!.prompt;
    expect(prompt).toContain("Topic: Funzioni di più variabili\n\nPart 2 of 4.");
    expect(prompt).toContain(
      [
        "1. Uno: Dopo Uno sai farlo. (written)",
        "2. Due: Dopo Due sai farlo. (this part)",
        "3. Tre: Dopo Tre sai farlo.",
        "4. Quattro: Dopo Quattro sai farlo.",
        "5. Ripasso del capitolo (recap)",
      ].join("\n"),
    );
    expect(prompt).toContain(
      'Part 1, Uno (before this part). Sections: "Passo 1 primo", "Passo 1 secondo".\nWhat it taught: Hai imparato il passo 1.',
    );
    expect(prompt.match(/MARK-\w+/g)).toEqual(["MARK-ps003", "MARK-ps004"]);
    expect(engine.calls[0]!.system).toContain("You write one part of a lesson");

    const part = outline.parts[1]!;
    const shape = partShape(partText("2"), first);
    expect(part).toMatchObject({ summary: "Hai imparato il passo 2.", minutes: partMinutes(shape.ok ? shape.words : 0) });
    const item = db
      .prepare("SELECT kind, prompt_template, prompt_version, engine_provider, body_json FROM items WHERE id = ?")
      .get(part.itemId) as { kind: string; prompt_template: string; prompt_version: string; engine_provider: string; body_json: string };
    expect([item.kind, item.prompt_template, item.prompt_version, item.engine_provider]).toEqual([
      "lesson",
      "lesson.part",
      "part-1",
      "claude",
    ]);
    const body = JSON.parse(item.body_json) as { cacheKey: string; markdown: string };
    expect(JSON.parse(body.cacheKey)).toMatchObject({ kind: "lesson", scopeId: part.id, passageIds: ["ps003", "ps004"] });
    expect(body.markdown).not.toContain("pyxis-takeaway");
    expect(db.prepare("SELECT passage_id FROM item_passages WHERE item_id = ? ORDER BY passage_id").pluck().all(part.itemId)).toEqual([
      "ps003",
      "ps004",
    ]);
    // The topic's lesson as the old reader finds it is still the book text: parts are not lessons it shows.
    expect(readLesson(db, "p", "t")).not.toHaveProperty("provider");
    // A written part is not written again.
    const again = write(db, 2, "no call");
    await again.done;
    expect(again.engine.calls).toHaveLength(0);
  });

  it("asks once more with the problems, and keeps the second reply", async () => {
    const db = await planned();
    const { engine, done } = write(db, 1, section("Solo", 300), partText("1"));
    const outline = await done;
    expect(engine.calls).toHaveLength(2);
    const [ask, retry] = engine.calls.map((call) => call.prompt);
    expect(retry!.startsWith(ask!)).toBe(true);
    expect(retry!.slice(ask!.length)).toMatch(/^\n\nProblems with your previous reply:\n- The part has 1 ## sections\./);
    expect(outline.parts[0]!.itemId).not.toBeNull();
  });

  it("asks again when a heading repeats a heading of a written part", async () => {
    const db = await planned();
    await write(db, 1, partText("1")).done;
    const repeated = partText("2").replace("Passo 2 primo", "passo 1, primo");
    const { engine, done } = write(db, 2, repeated, partText("2"));
    await done;
    expect(engine.calls[1]!.prompt).toContain('- The section "passo 1, primo" has the heading of a section of another part.');
  });

  it("saves a second reply without its question, with the part's line as its summary", async () => {
    const db = await planned();
    const { engine, done } = write(db, 1, "Niente.", section("Solo", 300));
    const outline = await done;
    expect(engine.calls).toHaveLength(2);
    expect(outline.parts[0]).toMatchObject({ summary: "Dopo Uno sai farlo." });
    expect(outline.parts[0]!.itemId).not.toBeNull();
  });

  it("fails with lesson-part-invalid after two replies it cannot read, and saves nothing", async () => {
    const db = await planned();
    await expect(write(db, 1, "Niente.", "Ancora niente.").done).rejects.toThrow("lesson-part-invalid");
    expect(db.prepare("SELECT COUNT(*) FROM items").pluck().get()).toBe(0);
    expect(liveOutline(db, "t")!.parts.every((part) => part.itemId === null)).toBe(true);
  });

  it("keeps every passage of a long part, and both asks within the per-call bound", async () => {
    const db = workspace([30_000, 30_000, 30_000]);
    db.exec("UPDATE passages SET text = 'MARK-' || id || ' ' || text");
    await planParts(db, { planId: "p", topicId: "t", run: recorded(reply(["Uno", ["P1", "P2"]], ["Due", ["P3"]])).run });
    const { engine, done } = write(db, 1, "Niente.", partText("1"));
    await done;
    for (const call of engine.calls) {
      expect(call.prompt.length).toBeLessThanOrEqual(CONTEXT_CHARS);
      expect(call.prompt.match(/MARK-\w+/g)).toEqual(["MARK-ps001", "MARK-ps002"]);
    }
  });

  it("cuts headings longer than the bound to a label and keeps text of every passage", async () => {
    // Two passages under headings of 14,000 characters: one part, planned with no call.
    const db = workspace([3_000, 3_000], [`A ${"y".repeat(13_998)}`, `B ${"z".repeat(13_998)}`]);
    db.exec("UPDATE passages SET text = 'MARK-' || id || ' ' || text");
    await planParts(db, { planId: "p", topicId: "t" });
    const { engine, done } = write(db, 1, "Niente.", partText("1"));
    await done;
    for (const call of engine.calls) {
      expect(call.prompt.length).toBeLessThanOrEqual(CONTEXT_CHARS);
      expect(call.prompt.match(/MARK-\w+/g)).toEqual(["MARK-ps001", "MARK-ps002"]);
      const headings = call.prompt.match(/^### .*$/gm)!;
      expect(headings).toHaveLength(2);
      for (const heading of headings) expect(heading.length).toBeLessThanOrEqual(4 + MATERIAL_HEADING_CHARS);
    }
  });

  it("keeps text of every passage of a part with many long headings, within the bound", async () => {
    // Sixty short passages under headings of 1,000 characters: one part (6,000 characters of text), planned with no call.
    const count = 60;
    const db = workspace(
      Array(count).fill(100),
      Array.from({ length: count }, (_, i) => `Sezione ${i + 1} ${"y".repeat(1_000)}`),
    );
    db.exec("UPDATE passages SET text = 'MARK-' || id || ' ' || text");
    await planParts(db, { planId: "p", topicId: "t" });
    const { engine, done } = write(db, 1, "Niente.", partText("1"));
    await done;
    for (const call of engine.calls) {
      expect(call.prompt.length).toBeLessThanOrEqual(CONTEXT_CHARS);
      expect(call.prompt.match(/MARK-\w+/g)).toHaveLength(count);
    }
  });

  it("exports the sources of the written parts, not material removed before they were written", async () => {
    const db = await planned();
    db.exec(`
      UPDATE passages SET section_path = 'Sezione ' || id;
      INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('s2', 'pdf', 'Appunti', 'ready', 1, 1);
      UPDATE passages SET source_id = 's2' WHERE id IN ('ps003', 'ps004');
      INSERT INTO plan_sources (plan_id, source_id) VALUES ('p', 's'), ('p', 's2');
    `);
    removePlanSource(db, "p", "s2");
    await write(db, 1, partText("1")).done;
    await write(db, 2, partText("2")).done;
    expect(liveOutline(db, "t")!.parts[1]!.passageIds).toEqual(["ps003", "ps004"]);
    const lesson = exportMarkdown(db, { planId: "p", kind: "lesson", topicId: "t" }).markdown;
    expect(lesson).toContain("## Fonti\n\n- Sezione ps001\n- Sezione ps002\n");
    expect(lesson).not.toContain("Sezione ps003");
    expect(lesson).not.toContain("Sezione ps004");
  });

  it("writes the recap from the summaries of the written parts, with no material", async () => {
    const db = await planned();
    await write(db, 1, partText("1")).done;
    // A jump: part 3 is written before part 2.
    await write(db, 3, partText("3")).done;
    const { engine, done } = write(db, 5, recapText());
    const outline = await done;
    const prompt = engine.calls[0]!.prompt;
    expect(prompt).toContain("This is the recap part, after the 4 parts");
    expect(prompt).toContain("What it taught: Hai imparato il passo 1.");
    expect(prompt).toContain("Part 3, Tre (before this part)");
    expect(prompt).not.toContain("MARK-");
    expect(prompt).not.toContain("Material of this part");
    expect(outline.parts[4]).toMatchObject({ kind: "recap", summary: "Hai ripassato il capitolo." });
  });

  it("joins the written parts in order under their titles for export", async () => {
    const db = await planned();
    expect(partsMarkdown(db, "t")).toBeNull();
    await write(db, 3, partText("3")).done;
    await write(db, 1, partText("1")).done;
    const joined = partsMarkdown(db, "t")!;
    expect(joined.passageIds).toEqual(["ps001", "ps002", "ps005"]);
    expect(joined.markdown.match(/^#{2,3} .+$/gm)).toEqual([
      "## Uno",
      "### Passo 1 primo",
      "### Passo 1 secondo",
      "## Tre",
      "### Passo 3 primo",
      "### Passo 3 secondo",
    ]);
  });
});

describe("figures in a part", () => {
  const PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const broken = "raise ValueError('no axis')";
  const mended = "plt.plot([0, 1, 2])";
  const figureBlock = (code: string) =>
    ["```pyxis-figure", JSON.stringify({ caption: "Una retta.", code }), "```"].join("\n");
  // The sandbox stand-in: code that raises fails, the rest draws.
  const python: FigureRunner = async (code) => ({
    stdout: "",
    stderr: code.includes("raise ValueError") ? "ValueError: no axis\n" : "",
    images: code.includes("raise ValueError") ? [] : [PNG],
    timedOut: false,
    truncated: false,
  });
  const withFigure = (tag: string, code: string) =>
    partText(tag).replace("Riprendiamo da dove eravamo.", `Riprendiamo da dove eravamo.\n\n${figureBlock(code)}`);
  /** The part's reply, and the fix calls with the engine each one named; `fix` answers them. */
  function engineFor(reply: string, fix: string | Error) {
    const engine = recorded(reply);
    const fixes: Array<{ model: string; prompt: string }> = [];
    const run: GenerateInput["run"] = async (input) => {
      if (!isFigureFixCall(input.system)) return engine.run(input);
      fixes.push({ model: input.selection.model, prompt: input.prompt });
      if (fix instanceof Error) throw fix;
      return { text: JSON.stringify({ code: fix }), structured: { code: fix }, provider: "claude", model: "fixer", inputTokens: 1 };
    };
    return { engine, fixes, run };
  }
  async function planned() {
    const db = workspace(Array(6).fill(4_000));
    await planParts(db, {
      planId: "p",
      topicId: "t",
      run: recorded(reply(["Uno", ["P1", "P2"]], ["Due", ["P3", "P4"]], ["Tre", ["P5"]], ["Quattro", ["P6"]])).run,
    });
    return db;
  }
  const picked = { provider: "claude", model: "picked-model" } as const;

  it("corrects a figure that failed with one call on the engine the part was asked of, before the part is saved", async () => {
    const db = await planned();
    const { fixes, run } = engineFor(withFigure("1", broken), mended);
    const outline = await writePart(db, { planId: "p", topicId: "t", position: 1, run, python, selection: picked });
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.model).toBe("picked-model");
    expect(JSON.parse(fixes[0]!.prompt)).toMatchObject({ kind: "plot", caption: "Una retta.", code: broken });
    const body = JSON.parse(
      (db.prepare("SELECT body_json FROM items WHERE id = ?").get(outline.parts[0]!.itemId) as { body_json: string }).body_json,
    ) as { markdown: string; figures: Record<string, string> };
    expect(body.figures).toEqual({ [figureKey(mended)]: PNG });
    expect(body.markdown).toContain(figureBlock(mended));
    expect(body.markdown).not.toContain("no axis");
  });

  it("draws a part's figure with the code as the model wrote it, escapes of its Python strings included", async () => {
    const db = await planned();
    const labelled = "plt.plot([0, 1])\nplt.ylabel('Voltage\\n(V)')";
    const programs: string[] = [];
    const recording: FigureRunner = async (code, timeoutMs) => {
      programs.push(code);
      return python(code, timeoutMs);
    };
    const { run } = engineFor(withFigure("1", labelled), mended);
    const outline = await writePart(db, { planId: "p", topicId: "t", position: 1, run, python: recording });
    expect(programs.some((program) => program.includes("plt.ylabel('Voltage\\n(V)')"))).toBe(true);
    const body = JSON.parse(
      (db.prepare("SELECT body_json FROM items WHERE id = ?").get(outline.parts[0]!.itemId) as { body_json: string }).body_json,
    ) as { markdown: string; figures: Record<string, string> };
    expect(body.figures).toEqual({ [figureKey(labelled)]: PNG });
    expect(body.markdown).toContain(figureBlock(labelled));
  });

  it("saves nothing when Stop is pressed while a figure is being corrected, and leaves the part to be written again", async () => {
    const db = await planned();
    const stop = new AbortController();
    const { run } = engineFor(withFigure("1", broken), mended);
    const stopping: GenerateInput["run"] = async (input) => {
      if (!isFigureFixCall(input.system)) return run(input);
      stop.abort();
      throw new DOMException("aborted", "AbortError");
    };
    await expect(
      writePart(db, { planId: "p", topicId: "t", position: 1, run: stopping, python, signal: stop.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(db.prepare("SELECT COUNT(*) FROM lesson_parts WHERE item_id IS NOT NULL").pluck().get()).toBe(0);
    // The part is written the next time it is asked for.
    const outline = await writePart(db, { planId: "p", topicId: "t", position: 1, run, python });
    expect(outline.parts[0]!.itemId).toBeTruthy();
  });

  it("drops a figure whose fix failed and saves the part with its text whole", async () => {
    const db = await planned();
    const { fixes, run } = engineFor(withFigure("1", broken), new Error("the engine is out"));
    const outline = await writePart(db, { planId: "p", topicId: "t", position: 1, run, python });
    expect(fixes).toHaveLength(1);
    const body = JSON.parse(
      (db.prepare("SELECT body_json FROM items WHERE id = ?").get(outline.parts[0]!.itemId) as { body_json: string }).body_json,
    ) as { markdown: string; figures?: Record<string, string> };
    expect(body.figures ?? {}).toEqual({});
    expect(body.markdown).not.toContain("pyxis-figure");
    expect(body.markdown).toContain("Riprendiamo da dove eravamo.");
    expect(body.markdown).toContain("## Passo 1 secondo");
  });

  it("corrects a figure of a rewritten section the same way, and keeps the part's other figures", async () => {
    const db = await planned();
    const first = engineFor(withFigure("1", "plt.plot([5, 6])"), mended);
    await writePart(db, { planId: "p", topicId: "t", position: 1, run: first.run, python });
    expect(first.fixes).toHaveLength(0);
    const newSection = `${section("Passo 1 primo", 150, "Passo1primoNuovo")}\n\n${figureBlock(broken).replace("Una retta.", "Una curva.")}`;
    const second = engineFor(newSection, mended);
    const result = await rewritePartSection(db, {
      planId: "p",
      topicId: "t",
      position: 1,
      section: 0,
      run: second.run,
      python,
      selection: picked,
    });
    expect(second.fixes.map((call) => call.model)).toEqual(["picked-model"]);
    expect(Object.keys(result.figures ?? {}).sort()).toEqual([figureKey("plt.plot([5, 6])"), figureKey(mended)].sort());
    expect(result.markdown).toContain(figureBlock(mended).replace("Una retta.", "Una curva."));
  });
});

/** A tool that keeps what it is told, like Claude Code: it continues the session it is given and names a new one otherwise. */
function toolRun(...replies: Array<unknown | string>) {
  type Call = {
    prompt: string;
    followUp?: string;
    session?: { provider: string; id: string; cwd: string } | null;
    kept: boolean;
    system?: string;
  };
  const calls: Call[] = [];
  const gate: { hold?: Promise<void>; started?: () => void } = {};
  let opened = 0;
  const run: GenerateInput["run"] = async (input) => {
    calls.push({
      prompt: input.prompt,
      followUp: input.conversation?.followUp,
      session: input.conversation?.session,
      kept: Boolean(input.conversation),
      system: input.system,
    });
    // The reply is chosen by this call's place in the order, before it waits, so a call that waits keeps its own.
    const at = calls.length - 1;
    // Only the first call after the gate is set waits.
    const hold = gate.hold;
    gate.hold = undefined;
    if (hold) {
      gate.started?.();
      await hold;
    }
    const next = replies[Math.min(at, replies.length - 1)];
    if (next instanceof Error) throw next;
    const held = input.conversation?.session;
    // A call outside a conversation is not kept by the tool, so it names no session of ours.
    const id = !input.conversation ? "" : held ? held.id : `tool-session-${(opened += 1)}`;
    if (input.conversation) input.conversation.onSession?.(id, "claude", "/scratch");
    const session = input.conversation ? { sessionId: id, cwd: "/scratch", continued: Boolean(held) } : {};
    const common = { provider: "claude", model: "test-model", inputTokens: 1, ...session };
    return typeof next === "string"
      ? { text: next, ...common }
      : { structured: next, text: JSON.stringify(next), ...common };
  };
  return { calls, run, gate };
}

describe("a lesson in one tool session", () => {
  const outlineOf = reply(["Uno", ["P1", "P2"]], ["Due", ["P3", "P4"]], ["Tre", ["P5"]], ["Quattro", ["P6"]]);
  /** The outline planned in a call of its own, then each part written in the topic's session. */
  async function lesson(...partReplies: Array<string | Error>) {
    const db = workspace(Array(6).fill(4_000));
    db.exec("UPDATE passages SET text = 'MARK-' || id || ' ' || text");
    const tool = toolRun(outlineOf, ...partReplies);
    await planParts(db, { planId: "p", topicId: "t", run: tool.run });
    const write = (position: number) => writePart(db, { planId: "p", topicId: "t", position, run: tool.run, python: null });
    return { db, tool, write };
  }
  const session = (db: ReturnType<typeof workspace>) =>
    db.prepare("SELECT session_id, in_step, ended_at FROM tool_sessions WHERE owner = 'lesson:t'").all() as Array<{
      session_id: string;
      in_step: number;
      ended_at: number | null;
    }>;

  it("plans the outline in a call of its own, which no session holds, and opens the session with the first part", async () => {
    const { db, tool, write } = await lesson(partText("1"));
    // The outline has rules of its own, and a session keeps the rules it was opened under.
    expect(tool.calls[0]).toMatchObject({ kept: false });
    expect(session(db)).toEqual([]);
    await write(1);
    // The part opens the session and is asked in full: the plan, what is written and its own material.
    const call = tool.calls[1]!;
    expect(call.session).toBeNull();
    expect(call.prompt).toContain("Part 1 of 4.");
    expect(call.prompt).toContain("1. Uno: Dopo Uno sai farlo. (this part)");
    expect(call.prompt).toContain("No part is written yet.");
    expect(call.prompt.match(/MARK-\w+/g)).toEqual(["MARK-ps001", "MARK-ps002"]);
    expect(session(db)).toEqual([{ session_id: "tool-session-1", in_step: 1, ended_at: null }]);
    db.close();
  });

  it("does not name the parts it wrote itself, and asks each later part from its place and material", async () => {
    const { db, tool, write } = await lesson(partText("1"), partText("2"));
    await write(1);
    await write(2);
    const follow = tool.calls[2]!;
    expect(follow.session).toMatchObject({ id: "tool-session-1" });
    expect(follow.followUp).toContain("Part 2 of 4.");
    expect(follow.followUp).toContain("1. Uno: Dopo Uno sai farlo. (written)");
    expect(follow.followUp).toContain("The parts already written are in this conversation, as you wrote them.");
    expect(follow.followUp).not.toContain("What it taught");
    expect(follow.followUp).not.toContain("Earlier in this conversation");
    expect(follow.followUp!.match(/MARK-\w+/g)).toEqual(["MARK-ps003", "MARK-ps004"]);
    // Handed to a new session, the same call names what the lesson holds, as before.
    expect(follow.prompt).toContain("What it taught: Hai imparato il passo 1.");
    expect(follow.prompt).not.toContain("Earlier in this conversation");
    expect(session(db)).toHaveLength(1);
    db.close();
  });

  it("sends only the problems to the session that holds the part's first reply, and the whole request when none can", async () => {
    const { db, tool, write } = await lesson("Troppo poco.", partText("1"));
    await write(1);
    const retry = tool.calls[2]!;
    expect(retry.followUp).toMatch(/^Problems with your previous reply:\n- /);
    expect(retry.followUp).toContain("Write the part again.");
    expect(retry.followUp).not.toContain("MARK-");
    expect(retry.session).toMatchObject({ id: "tool-session-1" });
    // A session the tool lost gets the request itself with the problems, as a one-shot always does.
    expect(retry.prompt).toContain("MARK-ps001");
    expect(retry.prompt).toContain("Problems with your previous reply:");
    db.close();
  });

  it("tells the session what the lesson holds after a part that failed, and again once one is kept", async () => {
    const { db, tool, write } = await lesson(partText("1"), "Troppo poco.", "Ancora poco.", partText("2"), partText("3"));
    await write(1);
    await expect(write(2)).rejects.toThrow("lesson-part-invalid");
    // Two bad replies are in the session now: it is behind the lesson, which has only part 1.
    expect(session(db)[0]!.in_step).toBe(0);
    await write(2);
    const behind = tool.calls[4]!;
    expect(behind.session).toMatchObject({ id: "tool-session-1" });
    expect(behind.followUp).toContain("Earlier in this conversation you wrote parts of this lesson. This is what the lesson holds now.");
    expect(behind.followUp).toContain("What it taught: Hai imparato il passo 1.");
    // Part 2 is kept: part 3 needs only its place and material again.
    await write(3);
    const held = tool.calls[5]!;
    expect(held.followUp).toContain("The parts already written are in this conversation, as you wrote them.");
    expect(held.followUp).not.toContain("Earlier in this conversation");
    expect(session(db)).toHaveLength(1);
    db.close();
  });

  it("tells it what the lesson holds when a stop or a failure came before the reply was kept", async () => {
    const { db, tool, write } = await lesson(partText("1"), new Error("offline"), partText("2"));
    await write(1);
    await expect(write(2)).rejects.toThrow("offline");
    expect(session(db)[0]!.in_step).toBe(0);
    await write(2);
    expect(tool.calls[3]!.followUp).toContain("Earlier in this conversation you wrote parts of this lesson.");
    db.close();
  });

  it("tells it what the lesson holds when a part was changed outside the session", async () => {
    const { db, tool, write } = await lesson(partText("1"), partText("2"));
    await write(1);
    // A section of part 1 was rewritten on its own, or the student chose another level: the text is not the one written.
    db.prepare("UPDATE items SET body_json = json_set(body_json, '$.markdown', json_extract(body_json, '$.markdown') || ?) WHERE json_extract(body_json, '$.cacheKey') LIKE ?").run(
      "\n\nUna riga in più.",
      "%lesson%",
    );
    await write(2);
    expect(tool.calls[2]!.followUp).toContain("Earlier in this conversation you wrote parts of this lesson.");
    db.close();
  });

  it("drops the text of a part written again, in a session that holds it", async () => {
    const { db, tool, write } = await lesson(partText("1"), partText("1 bis"));
    await write(1);
    await writePart(db, { planId: "p", topicId: "t", position: 1, run: tool.run, python: null, rewrite: "again" });
    const again = tool.calls[2]!;
    expect(again.followUp).toContain("This part is written again. Drop the text you wrote for it before");
    expect(again.prompt).not.toContain("This part is written again");
    db.close();
  });

  it("lets a part asked for while another is written run on its own, with the whole request, and leaves the session behind", async () => {
    // Replies in the order of the calls: part 1, part 2 (in the session), part 4 (beside it), part 3.
    const { db, tool, write } = await lesson(partText("1"), partText("2"), partText("4"), partText("3"));
    await write(1);
    let release!: () => void;
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    tool.gate.hold = new Promise<void>((resolve) => (release = resolve));
    tool.gate.started = started;
    const two = write(2);
    await inFlight;
    // Part 2 is being written in the session. Part 4 does not wait for it.
    await write(4);
    const beside = tool.calls.at(-1)!;
    expect(beside.kept).toBe(false);
    expect(beside.prompt).toContain("Part 4 of 4.");
    expect(beside.prompt).toContain("Parts already written:");
    release();
    await two;
    // Each part holds its own text: the call that waited kept its own reply, and the one beside it its own.
    const text = (position: number) =>
      db
        .prepare(
          "SELECT json_extract(i.body_json, '$.markdown') FROM lesson_parts p JOIN items i ON i.id = p.item_id JOIN lesson_outlines o ON o.id = p.outline_id WHERE o.retired_at IS NULL AND p.position = ?",
        )
        .pluck()
        .get(position) as string;
    expect(text(2)).toContain("Passo 2 primo");
    expect(text(2)).not.toContain("Passo 4 primo");
    expect(text(4)).toContain("Passo 4 primo");
    // Part 4 is written, though the session never saw it: it is behind, and part 3 is asked with what the lesson holds.
    await write(3);
    expect(tool.calls.at(-1)!.followUp).toContain("Earlier in this conversation you wrote parts of this lesson.");
    expect(tool.calls.at(-1)!.followUp).toContain("Part 4");
    expect(session(db)).toHaveLength(1);
    db.close();
  });

  it("starts a new session for a part asked under other rules, such as another level, and ends the old one", async () => {
    const { db, tool, write } = await lesson(partText("1"), partText("2"), partText("3"));
    await write(1);
    await writePart(db, { planId: "p", topicId: "t", position: 2, wording: "technical", run: tool.run, python: null });
    // The first session keeps the rules it was opened under, so the part at the other level goes to a new one, whole.
    const other = tool.calls[2]!;
    expect(other.session).toBeNull();
    expect(other.prompt).toContain("Part 2 of 4.");
    expect(other.system).not.toBe(tool.calls[1]!.system);
    expect(db.prepare("SELECT session_id, ended_reason FROM tool_sessions WHERE owner = 'lesson:t' ORDER BY opened_at, rowid").all()).toEqual([
      { session_id: "tool-session-1", ended_reason: "instructions" },
      { session_id: "tool-session-2", ended_reason: null },
    ]);
    db.close();
  });

  it("builds the request and what the session knows from one state of the lesson, whatever changes while the figure runner is awaited", async () => {
    const { db, tool, write } = await lesson(partText("1"), partText("2"));
    await write(1);
    const two = write(2);
    // A heading of part 1 changes while part 2 starts, before anything of the lesson was read.
    db.prepare(
      "UPDATE items SET body_json = json_set(body_json, '$.markdown', replace(json_extract(body_json, '$.markdown'), 'Passo 1 primo', 'Titolo nuovo'))",
    ).run();
    await two;
    const call = tool.calls[2]!;
    // The session was behind that state, and the request it got says so with the heading as it is now.
    expect(call.followUp).toContain("Earlier in this conversation you wrote parts of this lesson.");
    expect(call.followUp).toContain("Titolo nuovo");
    expect(call.followUp).not.toContain("Passo 1 primo");
    // And the session is kept at that state plus part 2: the next part asks for its place and material only.
    expect(session(db)[0]!.in_step).toBe(1);
    db.close();
  });

  it("puts no session on a topic of one part, which makes no call to plan", async () => {
    const db = workspace([3_000, 3_500]);
    const tool = toolRun(partText("1"));
    await planParts(db, { planId: "p", topicId: "t", run: tool.run });
    expect(tool.calls).toHaveLength(0);
    expect(session(db)).toEqual([]);
    await writePart(db, { planId: "p", topicId: "t", position: 1, run: tool.run, python: null });
    expect(session(db)).toHaveLength(1);
    db.close();
  });
});
