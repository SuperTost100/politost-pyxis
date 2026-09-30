import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvent } from "./events";
import { openDatabase } from "./db/connection";

const opened: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const db of opened) db.close();
  opened.length = 0;
});

describe("learning events", () => {
  it("appends a row and does not offer an update", () => {
    const db = openDatabase(
      join(mkdtempSync(join(tmpdir(), "pyxis-ev-")), "pyxis.db"),
    );
    opened.push(db);
    const id = appendEvent(db, {
      kind: "lesson_opened",
      sessionId: "s1",
      payload: { route: "/lessons/1" },
      at: 10,
    });
    const row = db
      .prepare(`SELECT kind, payload_json FROM learning_events WHERE id = ?`)
      .get(id) as { kind: string; payload_json: string };
    expect(row.kind).toBe("lesson_opened");
    expect(JSON.parse(row.payload_json)).toEqual({ route: "/lessons/1" });
    expect(appendEvent.toString()).not.toMatch(/UPDATE/);
  });
});
