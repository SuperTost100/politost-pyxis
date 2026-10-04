import { openDatabase } from "../../../../core/db/connection";
import { importPlan } from "../../../../core/plans/file";
import { passagesAround } from "../../../../core/sources/smartbook";
import { describe, expect, it } from "vitest";
import {
  defaultChoices,
  importRequest,
  locatedData,
  parsePlanText,
  previewPlan,
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
