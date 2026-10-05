import { describe, expect, it } from "vitest";
import { fileName, takeBoardAttachment } from "./attachments";

function store(entries: Record<string, string>) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => void data.delete(key),
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
});
