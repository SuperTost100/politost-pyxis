import { describe, expect, it } from "vitest";
import type { AttachmentView } from "../../../../shared/ipc";
import {
  attachFailure,
  attachable,
  attachmentLine,
  isLocalFile,
  refusedFile,
  draftKey,
  fileName,
  keepUnsentQuestion,
  lastAskChat,
  readPendingFiles,
  readPendingSubject,
  takeBoardAttachment,
  writePendingFiles,
  writePendingSubject,
} from "./attachments";

function store(entries: Record<string, string>) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("Ask attachments", () => {
  it("names a file from a Windows or POSIX path", () => {
    expect(fileName("C:\\Users\\sara\\Pictures\\board.png")).toBe("board.png");
    expect(fileName("/tmp/pyxis/board.png")).toBe("board.png");
    expect(fileName("notes.txt")).toBe("notes.txt");
  });

  it("takes the board file and its image together and leaves nothing behind", () => {
    const s = store({
      "pyxis-board-file": "/tmp/a.png",
      "pyxis-board-png": "data:image/png;base64,AAAA",
      "pyxis-board": "[]",
    });
    expect(takeBoardAttachment(s)).toEqual({
      path: "/tmp/a.png",
      preview: "data:image/png;base64,AAAA",
    });
    expect([...s.data.keys()]).toEqual(["pyxis-board"]);
  });

  it("drops an image that no attachment came with, such as a save-only board", () => {
    const s = store({ "pyxis-board-png": "data:image/png;base64,AAAA" });
    expect(takeBoardAttachment(s)).toBeNull();
    expect(s.data.size).toBe(0);
  });

  it("never previews a value that is not a PNG data URL", () => {
    const s = store({
      "pyxis-board-file": "/tmp/a.png",
      "pyxis-board-png": "https://example.test/x.png",
    });
    expect(takeBoardAttachment(s)).toEqual({ path: "/tmp/a.png" });
  });

  it("keeps each chat's draft and picked files apart, as core's ids and names only", () => {
    const s = store({});
    writePendingFiles(s, "a", [{ id: "f1", name: "uno.pdf" }]);
    writePendingFiles(s, undefined, [{ id: "f2", name: "nuovo.png" }]);
    expect(readPendingFiles(s, "a")).toEqual([{ id: "f1", name: "uno.pdf" }]);
    expect(readPendingFiles(s, "b")).toEqual([]);
    expect(readPendingFiles(s)).toEqual([{ id: "f2", name: "nuovo.png" }]);
    expect(draftKey("a")).not.toBe(draftKey("b"));
    expect(draftKey()).toBe("pyxis-draft");
    writePendingFiles(s, "a", []);
    expect([...s.data.keys()]).toEqual(["pyxis-files"]);
  });

  it("keeps an unsent question as its chat's draft, without replacing a draft already there", () => {
    const s = store({ "pyxis-draft:b": "bozza di b" });
    // A suggestion chip's question, whose text never was in the composer.
    keepUnsentQuestion(s, "a", "Spiegami la cinematica");
    expect(s.getItem(draftKey("a"))).toBe("Spiegami la cinematica");
    // A typed question is still that chat's draft: it stays as typed.
    keepUnsentQuestion(s, "b", "bozza di b");
    expect(s.getItem(draftKey("b"))).toBe("bozza di b");
    keepUnsentQuestion(s, undefined, "Che cos'è la velocità?");
    expect(s.getItem(draftKey())).toBe("Che cos'è la velocità?");
  });

  it("keeps a new chat's subject choice beside its draft, as the subject's id and name, until it is cleared", () => {
    const s = store({});
    expect(readPendingSubject(s)).toEqual({ kind: "auto" });
    writePendingSubject(s, { kind: "subject", id: "s-fis", name: "Fisica 2" });
    expect(readPendingSubject(s)).toEqual({ kind: "subject", id: "s-fis", name: "Fisica 2" });
    writePendingSubject(s, { kind: "library" });
    expect(readPendingSubject(s)).toEqual({ kind: "library" });
    // Letting Pyxis pick is the absence of a choice, so nothing is kept.
    writePendingSubject(s, { kind: "auto" });
    expect([...s.data.keys()]).toEqual([]);
    expect(readPendingSubject(store({ "pyxis-subject": "{" }))).toEqual({ kind: "auto" });
    expect(readPendingSubject(store({ "pyxis-subject": '{"kind":"subject"}' }))).toEqual({ kind: "auto" });
  });

  it("reads no files from a value that is not a list of files, and drops the paths an older build kept", () => {
    expect(readPendingFiles(store({ "pyxis-files:a": "{" }), "a")).toEqual([]);
    expect(readPendingFiles(store({ "pyxis-files:a": '[1,"/tmp/x.txt",{"id":"f","name":"x.txt"}]' }), "a")).toEqual([
      { id: "f", name: "x.txt" },
    ]);
  });

  it("does not keep a chip that never reached core", () => {
    const s = store({});
    writePendingFiles(s, "a", [
      { id: "f1", name: "uno.pdf" },
      { id: "local-1", name: "enorme.pdf" },
    ]);
    expect(readPendingFiles(s, "a")).toEqual([{ id: "f1", name: "uno.pdf" }]);
    expect(isLocalFile({ id: "local-1", name: "x" })).toBe(true);
    expect(isLocalFile({ id: "f1", name: "x" })).toBe(false);
  });

  it("names the chat the page was opened from, or none for a new chat", () => {
    const trail = (path: string, section: unknown) =>
      JSON.stringify({ visits: [{ key: "a", idx: 0, path, page: path, from: null, section }], current: "a" });
    expect(lastAskChat(store({ "pyxis.trail": trail("/tools/whiteboard", { chat: "0199-abc" }) }))).toBe("0199-abc");
    expect(lastAskChat(store({ "pyxis.trail": trail("/tools/whiteboard", "ask") }))).toBeUndefined();
    expect(lastAskChat(store({ "pyxis.trail": "{" }))).toBeUndefined();
    expect(lastAskChat(store({}))).toBeUndefined();
  });
});

describe("what a chip says", () => {
  const view = (extra: Partial<AttachmentView>): AttachmentView => ({
    id: "f",
    name: "dispensa.pdf",
    kind: "document",
    size: 1,
    state: "reading",
    ...extra,
  });

  it("says nothing for a file that is read, and how far the reading is while it goes", () => {
    expect(attachmentLine(view({ state: "ready" }))).toBeNull();
    expect(attachmentLine(view({}))).toEqual({ key: "ask.attach.reading" });
    expect(attachmentLine(view({ progress: 0.4 }))).toEqual({ key: "ask.attach.readingPercent", values: { percent: 40 } });
    expect(attachmentLine(view({ phase: "scan", page: 3, pages: 12 }))).toEqual({
      key: "ask.attach.scanPage",
      values: { page: 3, pages: 12 },
    });
    expect(attachmentLine(view({ phase: "scan" }))).toEqual({ key: "ask.attach.scan" });
    expect(attachmentLine(view({ state: "needs-data" }))).toEqual({ key: "ask.attach.needsData" });
  });

  it("gives each cause of a failure its own text, and the size limit the one of its kind", () => {
    const keys = (error: AttachmentView["error"], kind: AttachmentView["kind"] = "document") =>
      attachmentLine(view({ state: "failed", error, kind }))!.key;
    expect(keys("password")).toBe("ask.attach.error.password");
    expect(keys("unreadable")).toBe("ask.attach.error.unreadable");
    expect(keys("empty")).toBe("ask.attach.error.empty");
    expect(keys("too-many")).toBe("ask.attach.error.tooMany");
    expect(keys("cancelled")).toBe("ask.attach.error.cancelled");
    expect(keys("too-large")).toBe("ask.attach.error.tooLargeDocument");
    expect(keys("too-large", "photo")).toBe("ask.attach.error.tooLargePhoto");
  });

  it("makes a chip for a file core refused, with the reason its error code gives", () => {
    expect(attachFailure({ code: "source-too-big" })).toBe("too-large");
    expect(attachFailure({ code: "file-access-denied" })).toBe("denied");
    expect(attachFailure(new Error("x"))).toBe("unreadable");
    expect(refusedFile("local-1", "/a/Foto.JPG", "too-large")).toMatchObject({ name: "Foto.JPG", kind: "photo", state: "failed", error: "too-large" });
    expect(refusedFile("local-2", "C:\\a\\dispensa.pdf", "too-many")).toMatchObject({ name: "dispensa.pdf", kind: "document" });
  });
});

describe("what a message can carry", () => {
  it("keeps dropped files a message can carry and counts the rest", () => {
    expect(
      attachable(["/a/notes.PDF", "C:\\Users\\me\\shot.png", "/a/book.ptsb", "/a/README", "/a/x.md"]),
    ).toEqual({ paths: ["/a/notes.PDF", "C:\\Users\\me\\shot.png", "/a/x.md"], skipped: 2 });
  });
});
