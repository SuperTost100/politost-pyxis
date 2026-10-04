import { expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createDisclosure } from "./disclosure";

it("holds calls until provider acknowledgement and coalesces concurrent prompts", async () => {
  const db = openDatabase(":memory:");
  const prompts: string[] = [];
  const disclosure = createDisclosure(db, (provider, pending) => {
    if (pending) prompts.push(provider);
  });
  let resolved = false;
  const first = disclosure.ensure("claude").then(() => {
    resolved = true;
  });
  const second = disclosure.ensure("claude");
  await Promise.resolve();
  expect(resolved).toBe(false);
  expect(prompts).toEqual(["claude"]);
  disclosure.acknowledge("claude");
  await Promise.all([first, second]);
  await disclosure.ensure("claude");
  expect(prompts).toEqual(["claude"]);
  const controller = new AbortController();
  const cancelled = disclosure.ensure("codex", controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toThrow();
  expect(
    db
      .prepare("SELECT 1 FROM settings WHERE key = 'engine-disclosure:codex'")
      .get(),
  ).toBeUndefined();
  const denied = disclosure.ensure("codex");
  disclosure.cancel("codex");
  await expect(denied).rejects.toThrow("engine-disclosure-cancelled");
  db.close();
});

it("replays pending providers to a late listener and clears them on ack, cancel and abort without recording an ack", async () => {
  const db = openDatabase(":memory:");
  try {
    const disclosure = createDisclosure(db, () => {});
    expect(disclosure.pending()).toEqual([]);
    const a = disclosure.ensure("claude");
    const controller = new AbortController();
    const b = disclosure.ensure("codex", controller.signal);
    const c = disclosure.ensure("openai-api");
    expect(disclosure.pending().sort()).toEqual(["claude", "codex", "openai-api"]);
    disclosure.acknowledge("claude");
    await a;
    controller.abort();
    await expect(b).rejects.toThrow();
    disclosure.cancel("openai-api");
    await expect(c).rejects.toThrow("engine-disclosure-cancelled");
    expect(disclosure.pending()).toEqual([]);
    expect(
      db
        .prepare("SELECT key FROM settings WHERE key LIKE 'engine-disclosure:%'")
        .all(),
    ).toEqual([{ key: "engine-disclosure:claude" }]);
  } finally {
    db.close();
  }
});

it("dismisses the disclosure when the final waiting call aborts and distrusts false acknowledgements", async () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare(
      "INSERT INTO settings (key,value_json,updated_at) VALUES ('engine-disclosure:claude','false',1)",
    ).run();
    const states: boolean[] = [];
    const disclosure = createDisclosure(db, (_, pending) =>
      states.push(pending),
    );
    const first = new AbortController();
    const second = new AbortController();
    const a = disclosure.ensure("claude", first.signal);
    const b = disclosure.ensure("claude", second.signal);
    first.abort();
    await expect(a).rejects.toThrow();
    expect(states).toEqual([true]);
    second.abort();
    await expect(b).rejects.toThrow();
    expect(states).toEqual([true, false]);
  } finally {
    db.close();
  }
});
