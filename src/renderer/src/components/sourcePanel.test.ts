import { describe, expect, it } from "vitest";
import { citedRuns, clampPage, keepPages, pageKey, planPanel, type PanelSource } from "./sourcePanel";

const source = (fields: Partial<PanelSource>): PanelSource => ({
  sourceId: "s",
  title: "Fisica I",
  kind: "pdf",
  status: "ready",
  state: "ready",
  errorJobId: null,
  original: "stored",
  mime: "application/pdf",
  size: 1000,
  missing: false,
  changed: false,
  originUrl: null,
  pages: 412,
  slides: null,
  passage: null,
  ...fields,
});
const cited = (fields: Partial<NonNullable<PanelSource["passage"]>>) => ({
  id: "p",
  text: "Il percorso inverso richiede un'integrazione.",
  sectionPath: "2.2 Moto rettilineo",
  page: null,
  slide: null,
  chapter: null,
  ...fields,
});

describe("what the panel shows for each kind and state", () => {
  it.each([
    ["a PDF at its cited page", source({ passage: cited({ page: 35 }) }), { body: { show: "pdf" }, unit: "page", start: 35, openFile: true }],
    ["a PDF from its cover", source({}), { body: { show: "pdf" }, unit: "page", start: 1 }],
    ["a scan still being read", source({ state: "reading", status: "ocr-queued", pages: null }), { body: { show: "pdf" }, reading: true }],
    ["a linked PDF", source({ original: "linked" }), { body: { show: "pdf" }, openFile: true }],
    ["a photo", source({ kind: "image", mime: "image/jpeg", pages: null }), { body: { show: "image" }, unit: null, openFile: true }],
    [
      "a HEIC photo, which the window can't draw",
      source({ kind: "image", mime: "image/heic", pages: null, passage: cited({}) }),
      { body: { show: "text", ownApp: "document" }, openFile: true },
    ],
    [
      "a Word file",
      source({ kind: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pages: null, passage: cited({}) }),
      { body: { show: "text", ownApp: "document" }, unit: null, openFile: true },
    ],
    [
      "slides at the cited slide",
      source({ kind: "pptx", pages: null, slides: 30, passage: cited({ slide: 12 }) }),
      { body: { show: "text", ownApp: "slides" }, unit: "slide", start: 12, count: 30 },
    ],
    [
      "a page saved from a link",
      source({ kind: "link", original: null, mime: null, pages: null, originUrl: "https://appunti.example.org/fourier", passage: cited({}) }),
      { body: { show: "text", ownApp: null }, openFile: false, address: "https://appunti.example.org/fourier" },
    ],
    [
      "a free book at its chapter",
      source({ kind: "smartbook", original: "stored", pages: null, passage: cited({ chapter: 3 }) }),
      { body: { show: "text", ownApp: null }, unit: "chapter", start: 3, openFile: false },
    ],
    ["pasted notes", source({ kind: "excerpt", original: null, pages: null }), { body: { show: "text", ownApp: null }, openFile: false }],
    [
      "a linked file that was moved",
      source({ original: null, missing: true, passage: cited({ page: 35 }) }),
      { body: { show: "message", reason: "missing" }, openFile: false },
    ],
    ["a locked PDF", source({ state: "locked", status: "failed", pages: null, errorJobId: "j" }), { body: { show: "message", reason: "locked" }, openFile: true }],
    [
      "a Word file still being read",
      source({ kind: "docx", state: "reading", status: "extracting", pages: null }),
      { body: { show: "message", reason: "reading" } },
    ],
    ["a file whose read failed", source({ kind: "docx", state: "failed", status: "failed", pages: null }), { body: { show: "message", reason: "failed" } }],
    [
      "a file removed from the Library",
      source({ state: "removed", status: "removed", passage: cited({ page: 35 }) }),
      { body: { show: "message", reason: "removed" }, openFile: false },
    ],
    [
      "a PDF whose stored copy is gone",
      source({ original: null, missing: true, pages: 412 }),
      { body: { show: "message", reason: "missing" } },
    ],
  ])("%s", (_name, input, expected) => {
    expect(planPanel(input)).toMatchObject(expected);
  });

  it("keeps a citation from an earlier version, and says so", () => {
    expect(planPanel(source({ changed: true, passage: cited({ page: 40 }) }))).toMatchObject({ changed: true, start: 40 });
  });
});

describe("paging", () => {
  it("stays within the file", () => {
    expect(clampPage(0, 412)).toBe(1);
    expect(clampPage(413, 412)).toBe(412);
    expect(clampPage(412.4, 412)).toBe(412);
    expect(clampPage(Number.NaN, 412)).toBe(1);
    // Before the count is known, only the start is fixed.
    expect(clampPage(900, null)).toBe(900);
  });

  it("moves by the arrows and Page Up and Down", () => {
    expect(["ArrowRight", "PageDown", "ArrowLeft", "PageUp", "Home", "End", "a"].map(pageKey)).toEqual([1, 1, -1, -1, "first", "last", null]);
  });

  it("keeps the page on screen and the two seen before it, never more", () => {
    let kept: number[] = [];
    const dropped: number[] = [];
    for (const page of [412, 413, 414, 415, 414, 1]) {
      const step = keepPages(kept, page);
      kept = step.kept;
      dropped.push(...step.dropped);
    }
    expect(kept).toEqual([1, 414, 415]);
    expect(dropped).toEqual([412, 413]);
  });
});

describe("the cited passage on a drawn page", () => {
  const runs = ["2.2 Moto rettilineo", "Il percorso inverso", "richiede un'integrazione.", "", "Scrivendo dx = v(t) dt"];
  it("finds the runs it covers, whatever the spacing and case", () => {
    expect(citedRuns(runs, "il  percorso inverso RICHIEDE un'integrazione.")).toEqual([1, 2]);
  });
  it("marks a passage that goes on to the next page by its opening words", () => {
    expect(citedRuns(runs, "Il percorso inverso richiede un'integrazione. Poi continua su un'altra pagina che qui non c'è")).toEqual([1, 2]);
  });
  it("marks nothing when the passage is not on the page", () => {
    expect(citedRuns(runs, "Il moto armonico")).toEqual([]);
    expect(citedRuns(runs, "")).toEqual([]);
  });
});
