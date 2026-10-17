import { describe, expect, it } from "vitest";
import {
  addPendingFiles,
  attachable,
  draftKey,
  fileName,
  lastAskChat,
  readPendingFiles,
  takeBoardAttachment,
  writePendingFiles,
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

  it("keeps each chat's draft and picked files apart, as paths only", () => {
    const s = store({});
    writePendingFiles(s, "a", ["/tmp/uno.pdf"]);
    writePendingFiles(s, undefined, ["/tmp/nuovo.png"]);
    expect(readPendingFiles(s, "a")).toEqual(["/tmp/uno.pdf"]);
    expect(readPendingFiles(s, "b")).toEqual([]);
    expect(readPendingFiles(s)).toEqual(["/tmp/nuovo.png"]);
    expect(draftKey("a")).not.toBe(draftKey("b"));
    expect(draftKey()).toBe("pyxis-draft");
    writePendingFiles(s, "a", []);
    expect([...s.data.keys()]).toEqual(["pyxis-files"]);
  });

  it("reads no files from a value that is not a list of paths", () => {
    expect(readPendingFiles(store({ "pyxis-files:a": "{" }), "a")).toEqual([]);
    expect(readPendingFiles(store({ "pyxis-files:a": '[1,"/tmp/x.txt"]' }), "a")).toEqual(["/tmp/x.txt"]);
  });

  it("names the chat Ask last showed, or none for a new chat", () => {
    expect(lastAskChat(store({ "pyxis.lastDoorPath": '{"ask":"/ask/0199-abc","exams":"/exams"}' }))).toBe("0199-abc");
    expect(lastAskChat(store({ "pyxis.lastDoorPath": '{"ask":"/ask"}' }))).toBeUndefined();
    expect(lastAskChat(store({}))).toBeUndefined();
  });
});

describe("addPendingFiles", () => {
  it("adds each picked file once, keeping the order", () => {
    expect(
      addPendingFiles(["/a/foto.png"], ["/a/foto.png", "/a/notes.pdf"]),
    ).toEqual(["/a/foto.png", "/a/notes.pdf"]);
  });

  it("keeps dropped files a message can carry and counts the rest", () => {
    expect(
      attachable(["/a/notes.PDF", "C:\\Users\\me\\shot.png", "/a/book.ptsb", "/a/README", "/a/x.md"]),
    ).toEqual({ paths: ["/a/notes.PDF", "C:\\Users\\me\\shot.png", "/a/x.md"], skipped: 2 });
  });
});
