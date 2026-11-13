import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { jsonSchema, type GenerateInput } from "../engine/generate";
import { IpcError } from "../../shared/ipc";
import {
  ESTIMATE_MAX_MINUTES,
  ESTIMATE_MIN_MINUTES,
  MAX_PARTS,
  OUTLINE_PROMPT_CHARS,
  checkOutline,
  estimateMinutes,
  fallbackOutline,
  liveOutline,
  outlinePassages,
  outlineReply,
  outlineRequest,
  partBounds,
  partOfItem,
  planParts,
  type OutlinePassage,
  type OutlineReply,
  type OutlineRequest,
  type PlannedPart,
} from "./parts";

/** Passages of `sizes` characters each, under the given headings (null for none). */
function passages(sizes: number[], sections: Array<string | null> = []): OutlinePassage[] {
  return sizes.map((size, index) => ({
    id: `ps${String(index + 1).padStart(3, "0")}`,
    text: "x".repeat(size),
    section: sections[index] ?? null,
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
    for (let round = 0; round < 500; round++) {
      const count = 1 + Math.floor(random() * 9);
      const parts = Array.from({ length: count }, (_, index): [string, string[]] => [
        random() < 0.05 ? "" : `Idea ${random() < 0.05 ? 0 : index}`,
        labels.filter(() => random() < 0.25).concat(random() < 0.2 ? ["P40"] : []),
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
      }
    }
    expect(accepted).toBeGreaterThan(20);
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
      { label: "P1", section: "2.1 Intorni", chars: 3_000 },
      { label: "P2", chars: 2_000 },
      { label: "P3", chars: 4_000 },
      { label: "P4", section: "2.2 Aperti", chars: 1_000 },
    ]);
    // A short topic sends each passage whole.
    expect(request.passages[3]!.excerpt).toBe("x".repeat(1_000));
  });

  it("cuts the excerpts so the list stays within the call bound, also with characters JSON escapes", () => {
    const many = Array.from({ length: 300 }, (_, index) => ({
      id: `p${index}`,
      text: `"Limite" \\ di f(x,y)\n${"è ".repeat(2_000)}`,
      section: index % 10 === 0 ? `2.${index / 10} Sezione` : null,
    }));
    const request = outlineRequest("Limiti", many, { target: 8, min: 7, max: 8 })!;
    expect(JSON.stringify(request.passages).length).toBeLessThanOrEqual(OUTLINE_PROMPT_CHARS);
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
      prompt_version: "outline-1",
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
    expect(second).toEqual({ ...first, problems: ["The reply had 1 parts with passages from the list. Use between 3 and 5."] });
    expect(outline.origin).toBe("model");
    expect(outline.parts.map((part) => part.title)).toEqual(["Uno", "Due", "Tre", "Ripasso del capitolo"]);
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
    expect(partOfItem(db, "written")).toEqual({ partId: outline.parts[0]!.id, outlineId: outline.id, position: 1, kind: "part" });
    expect(partOfItem(db, "old")).toBeNull();
    // A retired outline is not the live one, and the topic can be planned again.
    db.prepare("UPDATE lesson_outlines SET retired_at = 5").run();
    expect(liveOutline(db, "t")).toBeNull();
    const again = await planParts(db, { planId: "p", topicId: "t" });
    expect(again.id).not.toBe(outline.id);
  });

  it("reads a smartbook paragraph's title as its heading, and a page or slide as none", () => {
    const db = workspace([10, 10, 10, 10, 10], ["p. 3", "slide 2", "text", "1. Moti", "Capitolo 2"]);
    db.prepare("UPDATE passages SET locator_json = ? WHERE id = 'ps004'").run(JSON.stringify({ chapter: 1, title: "Velocità media" }));
    expect(outlinePassages(db, "t").map((passage) => passage.section)).toEqual([null, null, null, "Velocità media", "Capitolo 2"]);
  });
});
