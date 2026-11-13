import { describe, expect, it } from "vitest";
import {
  citedRuns,
  clampPage,
  keepPages,
  keepPicture,
  loadingSlot,
  messageText,
  pageKey,
  pdfFailure,
  planPanel,
  readRange,
  type PanelSource,
} from "./sourcePanel";

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
  linked: false,
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

describe("the words of each message", () => {
  it("sends a moved linked file back to its folder, and a stored copy that is gone to Sostituisci", () => {
    const moved = source({ original: null, linked: true, missing: true });
    const gone = source({ original: null, linked: false, missing: true });
    expect(messageText("missing", moved)).toEqual({ title: "sources.viewer.missingTitle", body: "sources.viewer.missingBody" });
    expect(messageText("missing", gone)).toEqual({ title: "sources.viewer.missingStoredTitle", body: "sources.viewer.missingStored" });
    // A read that failed later says the same, whatever the panel saw first.
    expect(messageText("missing", source({ original: "linked", linked: true }))).toEqual(messageText("missing", moved));
    expect(messageText("missing", source({ original: "stored" }))).toEqual(messageText("missing", gone));
    expect(messageText("removed", gone)).toEqual({ title: "sources.panel.gone", body: "sources.viewer.removedBody" });
    expect(messageText("failed", gone)).toEqual({ title: "sources.viewer.failedTitle", body: "sources.viewer.failedBody" });
  });
});

describe("reading a PDF through core", () => {
  const CAP = 2 * 1024 * 1024;
  const file = Uint8Array.from({ length: CAP * 2 + 5000 }, (_, i) => i % 253);
  // Core answers at most CAP bytes a call, as sources.readOriginal does.
  const core = (start: number, length: number) => Promise.resolve({ bytes: file.slice(start, start + Math.min(length, CAP)) });

  it("reads a range longer than one call in pieces, up to its end", async () => {
    const asked: number[] = [];
    const bytes = await readRange((start, length) => (asked.push(start), core(start, length)), 65536, file.length);
    expect(bytes.length).toBe(file.length - 65536);
    expect(bytes[0]).toBe(65536 % 253);
    expect(bytes[bytes.length - 1]).toBe((file.length - 1) % 253);
    expect(asked).toEqual([65536, 65536 + CAP]);
  });

  it("stops at the file's end, and passes a failed read on", async () => {
    expect((await readRange(core, file.length - 10, file.length + 100)).length).toBe(10);
    const missing = { code: "source-file-missing", messageKey: "sources.fileMissing", params: {}, detail: "" };
    await expect(readRange(() => Promise.reject(missing), 0, 10)).rejects.toBe(missing);
  });

  it("tells a missing file from other failures by core's code", () => {
    expect(pdfFailure({ code: "source-file-missing", messageKey: "sources.fileMissing", params: {}, detail: "" })).toEqual({ error: "missing" });
    expect(pdfFailure({ code: "core-restarted", messageKey: "errors.coreRestarted", params: {}, detail: "" })).toEqual({
      error: "failed",
      detail: "core-restarted",
    });
    expect(pdfFailure(Object.assign(new Error("No password given"), { name: "PasswordException" }))).toEqual({ error: "locked" });
    expect(pdfFailure(new Error("Invalid PDF structure."))).toEqual({ error: "failed", detail: "Invalid PDF structure." });
  });

  it("keeps one picture a page, at the width drawn last", () => {
    const closed: string[] = [];
    const picture = (name: string) => ({ name, close: () => closed.push(name) });
    const pictures = new Map<string, ReturnType<typeof picture>>();
    keepPicture(pictures, 12, "12@800", picture("a"));
    keepPicture(pictures, 3, "3@800", picture("b"));
    // A resize passes through widths: each one replaces the page's picture before.
    keepPicture(pictures, 12, "12@790", picture("c"));
    keepPicture(pictures, 12, "12@780", picture("d"));
    expect([...pictures.keys()].sort()).toEqual(["12@780", "3@800"]);
    expect(closed).toEqual(["a", "c"]);
    // Page 1 is not page 12's prefix.
    keepPicture(pictures, 1, "1@780", picture("e"));
    expect(pictures.has("12@780")).toBe(true);
  });
});

describe("the life of a loading PDF", () => {
  const task = () => {
    let destroyed = 0;
    return { destroy: () => ((destroyed += 1), Promise.resolve()), get destroyed() { return destroyed; } };
  };

  it("destroys a task that starts after the panel moved on", () => {
    const slot = loadingSlot();
    slot.dispose();
    const late = task();
    expect(slot.hold(late)).toBe(false);
    expect(late.destroyed).toBe(1);
  });

  it("destroys a loading or loaded task once, when the panel moves on or a read fails", () => {
    const slot = loadingSlot();
    const loading = task();
    expect(slot.hold(loading)).toBe(true);
    slot.dispose();
    slot.dispose();
    expect(loading.destroyed).toBe(1);

    const failing = loadingSlot();
    const loaded = task();
    failing.hold(loaded);
    expect(failing.fail()).toBe(true);
    // Only the first failure is reported; the destroyed task's own errors that follow are not.
    expect(failing.fail()).toBe(false);
    expect(failing.closed).toBe(true);
    failing.dispose();
    expect(loaded.destroyed).toBe(1);
  });
});
