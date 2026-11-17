import { openDatabase } from "../../../../core/db/connection";
import { importPlan } from "../../../../core/plans/file";
import { passagesAround } from "../../../../core/sources/smartbook";
import { describe, expect, it } from "vitest";
import {
  defaultChoices,
  importFailure,
  importRequest,
  locatedData,
  parsePlanText,
  previewPlan,
  readPlanText,
} from "./importPreview";

const HELLO_SHA =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const file = parsePlanText(
  JSON.stringify({
    version: 2,
    title: "Fisica",
    topics: [{ title: "Moto", position: 0 }],
    nodes: [],
    cards: [{ front: "a", back: "b", topic: 0 }],
    passages: [],
    sources: [
      { id: "a", title: "Dispense", sha: HELLO_SHA, bytes: 5 },
      { id: "b", title: "Libro", sha: null, bytes: 9, data: "AAAA" },
    ],
  }),
)!;

describe("plan import preview", () => {
  it("rejects anything that is not a valid plan file", () => {
    expect(parsePlanText("{")).toBeNull();
    expect(parsePlanText('{"version":9}')).toBeNull();
    expect(file).not.toBeNull();
  });

  it("summarizes contents and separates embedded originals from missing ones", () => {
    const preview = previewPlan(file, [{ id: "lib", blobSha: HELLO_SHA }]);
    expect(preview.counts).toMatchObject({ topics: 1, cards: 1, lessons: 0 });
    expect(preview.progress).toBe(false);
    expect(preview.generalTopics).toBe(0);
    const draft = previewPlan(
      {
        ...file,
        topics: [
          { title: "Moto", position: 0, grounding: "general" },
          { title: "Old", position: 1, grounding: "general", archived: true },
        ],
      },
      [],
    );
    // Archived topics are history; only active general ones raise the notice.
    expect(draft.generalTopics).toBe(1);
    expect(preview.sources.map((s) => s.embedded)).toEqual([false, true]);
    expect(preview.missing).toHaveLength(1);
    expect(defaultChoices(preview)).toEqual({ 0: "library" });
    expect(defaultChoices(previewPlan(file, []))).toEqual({ 0: "excerpts" });
  });

  it("sends the library match and a verified located file, nothing else", async () => {
    const preview = previewPlan(file, [{ id: "lib", blobSha: HELLO_SHA }]);
    expect(importRequest(file, preview, { 0: "library" }, {})).toMatchObject({
      libraryFor: { "0": "lib" },
    });
    const kept = importRequest(file, preview, { 0: "excerpts" }, {});
    expect(kept).not.toHaveProperty("libraryFor");
    expect(await locatedData(file.sources![0]!, new Blob(["hello"]))).toBe(
      "aGVsbG8=",
    );
    expect(
      await locatedData(file.sources![0]!, new Blob(["hellp"])),
    ).toBeNull();
    expect(
      await locatedData(file.sources![0]!, new Blob(["hello!"])),
    ).toBeNull();
    const located = importRequest(
      file,
      preview,
      { 0: "file" },
      { 0: "aGVsbG8=" },
    );
    expect(located.sources![0]!.data).toBe("aGVsbG8=");
    expect(located).not.toHaveProperty("libraryFor");
  });
});

it("skips an original source while preserving readable cited quotes and their references", () => {
  const input = {
    ...file,
    sources: [file.sources![0]!],
    passages: [
      {
        id: "quote",
        sourceId: "a",
        documentId: "doc",
        version: 1,
        text: "hello",
        locator: { page: 1 },
        section: "Notes",
        charStart: 0,
        charEnd: 5,
        textSha: HELLO_SHA,
        sourceSha: HELLO_SHA,
      },
    ],
    documents: [{ id: "doc", sourceId: "a", version: 1, tree: {} }],
    topics: [{ title: "Moto", position: 0, passageIds: ["quote"] }],
    cards: [{ front: "What?", back: "hello", topic: 0, passageId: "quote" }],
  };
  const request = importRequest(
    input,
    previewPlan(input, []),
    { 0: "skip" },
    {},
  );
  expect(request.sources).toEqual([]);
  expect(request.documents).toEqual([]);
  expect(request.passages![0]).toMatchObject({
    sourceId: null,
    documentId: null,
    sourceSha: null,
  });
  const db = openDatabase(":memory:");
  importPlan(db, request);
  expect(db.prepare("SELECT count(*) AS n FROM sources").get()).toEqual({
    n: 0,
  });
  const quote = db.prepare("SELECT id FROM passages").get() as { id: string };
  expect(passagesAround(db, quote.id)).toMatchObject([
    { text: "hello", current: true },
  ]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

describe("why a file cannot be opened or imported", () => {
  it("tells a file that is not a plan from a plan that cannot be read", () => {
    expect(readPlanText("{")).toEqual({ reason: "not-a-plan" });
    expect(readPlanText("[]")).toEqual({ reason: "not-a-plan" });
    expect(readPlanText('{"title":"Fisica"}')).toEqual({ reason: "not-a-plan" });
    expect(readPlanText('{"version":3,"title":"Fisica","topics":[],"nodes":[],"cards":[]}')).toEqual({
      reason: "unknown-version",
    });
    expect(readPlanText('{"version":2,"title":7,"topics":[],"nodes":[],"cards":[]}')).toEqual({
      reason: "invalid-file",
    });
    const big = { title: "Libro", sha: null, bytes: 999 * 1024 * 1024 };
    expect(
      readPlanText(JSON.stringify({ version: 2, title: "F", topics: [], nodes: [], cards: [], sources: [big] })),
    ).toEqual({ reason: "oversized-source" });
    expect(readPlanText(JSON.stringify({ version: 2, title: "F", topics: [], nodes: [], cards: [] }))).toMatchObject({
      file: { title: "F" },
    });
  });

  it("reads the refusal the core sends, with the parts the plan can go without", () => {
    const refusal = (detail: string, without?: string) => ({
      code: "plan-file",
      messageKey: `shared.reason.${detail}`,
      params: without === undefined ? {} : { without },
      detail,
    });
    expect(importFailure(refusal("missing-topic"))).toEqual({ reason: "missing-topic", without: [] });
    expect(importFailure(refusal("bad-map", "maps"))).toEqual({ reason: "bad-map", without: ["maps"] });
    expect(importFailure(refusal("bad-exercise", "maps,exercises"))).toEqual({
      reason: "bad-exercise",
      without: ["exercises", "maps"],
    });
    // Anything else, or a reason this app has no sentence for, is a plain failure.
    expect(importFailure(refusal("made-up"))).toBeNull();
    expect(importFailure({ code: "internal", detail: "plan-file" })).toBeNull();
    expect(importFailure(new Error("boom"))).toBeNull();
    expect(importFailure(null)).toBeNull();
    expect(importFailure(refusal("bad-map", "everything"))).toEqual({ reason: "bad-map", without: [] });
  });
  it("lists the path in its order with what the file holds for each topic, and leaves out the ones set aside", () => {
    const quiz = { kind: "quiz" as const, body: { questions: [] }, passageIds: [], grounding: null, provider: null, model: null };
    const withPath = parsePlanText(
      JSON.stringify({
        version: 2,
        title: "Analisi",
        topics: [
          { title: "Secondo", position: 1 },
          { title: "Messo da parte", position: 2, archived: true },
          { title: "Primo", position: 0 },
        ],
        nodes: [],
        cards: [
          { front: "a", back: "b", topic: 2 },
          { front: "c", back: "d", topic: 2 },
          { front: "e", back: "f", topic: 0 },
        ],
        items: [
          { ...quiz, id: "q1", topic: 2 },
          { id: "l1", topic: 2, kind: "lesson", body: { markdown: "x" }, passageIds: [], grounding: null, provider: null, model: null },
          { id: "l2", topic: 2, kind: "lesson", body: { markdown: "y" }, passageIds: [], grounding: null, provider: null, model: null },
        ],
      }),
    )!;
    expect(previewPlan(withPath, []).path).toEqual([
      { title: "Primo", lessons: 2, quizzes: 1, cards: 2, maps: 0 },
      { title: "Secondo", lessons: 0, quizzes: 0, cards: 1, maps: 0 },
    ]);
  });

  it("reads the exam day from the sessions, the next one first, or from the older single date", () => {
    const day = (days: number) => Date.UTC(2027, 1, 2) + days * 86_400_000;
    const now = day(0);
    const sessions = (list: Array<{ date: number; time?: string; label?: string }>) => ({ ...file, sessions: list, examAt: null });
    expect(previewPlan(file, [], now).exam).toBeNull();
    expect(previewPlan({ ...file, examAt: day(9) }, [], now).exam).toEqual({ at: day(9), time: null, label: null });
    expect(
      previewPlan(sessions([{ date: day(20), label: "Orale" }, { date: day(3), time: "09:00", label: "Scritto" }]), [], now).exam,
    ).toEqual({ at: day(3), time: "09:00", label: "Scritto" });
    // Every session over: the last one, as the exam page counts days since it.
    expect(previewPlan(sessions([{ date: day(-9) }, { date: day(-2) }]), [], now).exam?.at).toBe(day(-2));
  });

  it("shows the exam the import will make: none for a file whose sessions are an empty list", () => {
    const day = Date.UTC(2027, 1, 2);
    const now = Date.UTC(2026, 10, 1);
    // An empty list of sessions is what the file says: core keeps it and makes no exam, whatever `examAt` holds.
    const empty = { ...file, sources: [], sessions: [], examAt: day };
    expect(previewPlan(empty, [], now).exam).toBeNull();
    const db = openDatabase(":memory:");
    const imported = importPlan(db, importRequest(empty, previewPlan(empty, []), defaultChoices(previewPlan(empty, [])), {}));
    expect(db.prepare("SELECT exam_at FROM plans WHERE id = ?").pluck().get(imported)).toBeNull();
    db.close();
    // Without a list the older single date stands, and a list with a session shows that session.
    expect(previewPlan({ ...file, examAt: day }, [], now).exam).toEqual({ at: day, time: null, label: null });
    expect(previewPlan({ ...file, sessions: [{ date: day, time: "09:00" }], examAt: null }, [], now).exam).toEqual({
      at: day,
      time: "09:00",
      label: null,
    });
  });

  it("says the progress comes when a card keeps its schedule, as the import stores it", () => {
    const schedule = { rating: "good" as const, state: { intervalDays: 3, ease: 2.5, dueAt: 1 }, at: 1 };
    const scheduled = { ...file, sources: [], cards: [{ ...file.cards[0]!, schedule }], progress: [] };
    expect(previewPlan(file, []).progress).toBe(false);
    expect(previewPlan(scheduled, []).progress).toBe(true);
    const db = openDatabase(":memory:");
    importPlan(db, importRequest(scheduled, previewPlan(scheduled, []), defaultChoices(previewPlan(scheduled, [])), {}));
    expect(db.prepare("SELECT count(*) AS n FROM card_reviews").get()).toEqual({ n: 1 });
    db.close();
  });

  it("keeps hostile and very long text exactly as the file has it, so the page can only show it as text", () => {
    const hostile = '<img src=x onerror="window.pwned=1"><script>alert(1)</script>';
    // The schema stops titles at 500 characters and the author at 200; a title with no space is the worst case for the layout.
    const long = "Q".repeat(500);
    const odd = parsePlanText(
      JSON.stringify({
        version: 2,
        title: long,
        author: hostile,
        topics: [{ title: long, position: 0 }],
        nodes: [],
        cards: [],
        sources: [{ id: "s", title: hostile, sha: null, bytes: 1 }],
      }),
    )!;
    const preview = previewPlan(odd, []);
    expect(preview.title).toBe(long);
    expect(preview.author).toBe(hostile);
    expect(preview.path[0]?.title).toBe(long);
    expect(preview.sources[0]?.title).toBe(hostile);
  });
});
