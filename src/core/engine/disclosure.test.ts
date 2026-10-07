import { expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createDisclosure, DISCLOSURE_REQUIRED } from "./disclosure";

it("refuses an unacknowledged provider at once and accepts it after acknowledgement", () => {
  const db = openDatabase(":memory:");
  try {
    const disclosure = createDisclosure(db);
    expect(disclosure.isAcknowledged("claude")).toBe(false);
    expect(() => disclosure.ensure("claude")).toThrow(DISCLOSURE_REQUIRED);
    expect(
      db
        .prepare("SELECT key FROM settings WHERE key LIKE 'engine-disclosure:%'")
        .all(),
    ).toEqual([]);
    disclosure.acknowledge(["claude"]);
    expect(() => disclosure.ensure("claude")).not.toThrow();
    // Another provider stays unacknowledged.
    expect(() => disclosure.ensure("codex")).toThrow(DISCLOSURE_REQUIRED);
  } finally {
    db.close();
  }
});

it("records several providers together and keeps an earlier acknowledgement", () => {
  const db = openDatabase(":memory:");
  try {
    const disclosure = createDisclosure(db);
    disclosure.acknowledge(["claude"]);
    disclosure.acknowledge(["claude", "codex", "openai-api"]);
    expect(
      db
        .prepare("SELECT key FROM settings WHERE key LIKE 'engine-disclosure:%' ORDER BY key")
        .all(),
    ).toEqual([
      { key: "engine-disclosure:claude" },
      { key: "engine-disclosure:codex" },
      { key: "engine-disclosure:openai-api" },
    ]);
    expect(disclosure.isAcknowledged("openai-api")).toBe(true);
    expect(disclosure.isAcknowledged("agent")).toBe(false);
  } finally {
    db.close();
  }
});

it("honours an aborted signal before anything else", () => {
  const db = openDatabase(":memory:");
  try {
    const disclosure = createDisclosure(db);
    disclosure.acknowledge(["claude"]);
    const controller = new AbortController();
    controller.abort();
    expect(() => disclosure.ensure("claude", controller.signal)).toThrow();
  } finally {
    db.close();
  }
});
