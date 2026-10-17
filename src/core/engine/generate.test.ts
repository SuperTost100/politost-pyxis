import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { IpcError } from "../../shared/ipc";
import { openDatabase } from "../db/connection";
import type { AutoProvider } from "./auto";
import { clearBench, clearSignOut, DEFAULT_LIMIT_MS } from "./bench";
import { generate, setFallbackListener } from "./generate";
import { FunnelError, type EngineResult } from "./funnel";
import { rememberReady, selectionFor } from "./selection";

const selection = { provider: "claude" as const, model: "claude-sonnet-4-6" };

function result(patch: Partial<EngineResult>): EngineResult {
  return {
    text: "",
    model: "claude-sonnet-4-6",
    provider: "claude",
    inputTokens: 12,
    ...patch,
  };
}

describe("generate engine failures", () => {
  const failing = (error: unknown) => () =>
    generate({
      selection,
      prompt: "hi",
      run: async () => {
        throw error;
      },
    });

  it("turns a signed-out engine into its own message with the raw text as detail", async () => {
    const error = await failing(
      new FunnelError("Please run /login", "not-logged-in"),
    )().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(IpcError);
    expect(error).toMatchObject({
      code: "not-logged-in",
      messageKey: "engines.errors.not-logged-in",
      detail: "Please run /login",
    });
  });

  it("separates a usage limit and a crashed CLI", async () => {
    await expect(
      failing(
        Object.assign(new Error("429 rate limit"), { code: "cli-failed" }),
      )(),
    ).rejects.toMatchObject({
      messageKey: "engines.errors.quota",
    });
    await expect(
      failing(new FunnelError("exit 1", "cli-failed"))(),
    ).rejects.toMatchObject({
      messageKey: "engines.errors.cli-failed",
    });
  });

  it("keeps a reply it cannot use as invalid output, not an engine error", async () => {
    const unusable = (text: string) =>
      generate({
        selection,
        prompt: "name a colour",
        schema: z.object({ colour: z.string() }),
        run: async () => result({ text }),
      });
    for (const text of ['{"colour": 3}', "not json at all", ""]) {
      const error = await unusable(text).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(IpcError);
      expect(error).toMatchObject({
        code: "invalid-output",
        messageKey: "errors.invalidOutput",
      });
    }
  });

  it("leaves a plain error that carries no engine code alone", async () => {
    const bug = new SyntaxError("Unexpected token");
    await expect(failing(bug)()).rejects.toBe(bug);
    const unrelated = Object.assign(new Error("disk"), { code: "ENOSPC" });
    await expect(failing(unrelated)()).rejects.toBe(unrelated);
  });

  it("leaves a cancelled call, an IpcError and a refused notice as they were", async () => {
    const abort = new DOMException("stopped", "AbortError");
    await expect(failing(abort)()).rejects.toBe(abort);
    const own = new IpcError("engine-missing", "engines.errors.engine-missing");
    await expect(failing(own)()).rejects.toBe(own);
    await expect(
      failing(new Error("engine-disclosure-required"))(),
    ).rejects.toMatchObject({
      message: "engine-disclosure-required",
      messageKey: "engines.errors.disclosure-required",
    });
  });
});

describe("generate", () => {
  it("repairs one bad structured answer", async () => {
    const calls: string[] = [];
    const followUps: Array<string | undefined> = [];
    const keys = new Set<string | undefined>();
    const output = await generate({
      selection,
      prompt: "name a colour",
      schema: z.object({ colour: z.string() }),
      run: async (input) => {
        expect(input.responseSchema?.schema.$schema).toBe(
          "http://json-schema.org/draft-07/schema#",
        );
        expect(input.responseSchema?.schema.additionalProperties).toBe(false);
        calls.push(input.prompt);
        followUps.push(input.conversation?.followUp);
        keys.add(input.conversation?.key);
        if (calls.length === 1)
          return result({ text: "blue", structuredError: "not json" });
        return result({
          structured: { colour: "blue" },
          text: '{"colour":"blue"}',
        });
      },
    });
    expect(calls).toHaveLength(2);
    // An engine that keeps no conversation gets the whole prompt with the bad answer.
    expect(calls[1]).toContain("name a colour");
    expect(calls[1]).toContain("blue");
    // One that keeps the conversation already holds the prompt, so it gets only the error and the bad answer.
    expect(keys.size).toBe(1);
    expect(followUps[0]).toBe("name a colour");
    expect(followUps[1]).not.toContain("name a colour");
    expect(followUps[1]).toContain("not json");
    expect(followUps[1]).toContain("blue");
    expect(output.data).toEqual({ colour: "blue" });
  });

  it("stops after two repair calls", async () => {
    let calls = 0;
    await expect(
      generate({
        selection,
        prompt: "name a colour",
        schema: z.object({ colour: z.string() }),
        run: async () => {
          calls += 1;
          return result({ text: "nope", structuredError: "not json" });
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-output" });
    expect(calls).toBe(3);
  });

  it("keeps the image attachments on every schema-repair retry", async () => {
    const attachments = [
      { type: "image" as const, mediaType: "image/png" as const, data: "aGk=" },
    ];
    const seen: unknown[] = [];
    let calls = 0;
    const output = await generate({
      selection,
      prompt: "read the board",
      schema: z.object({ text: z.string() }),
      attachments,
      run: async (input) => {
        seen.push(input.attachments);
        calls += 1;
        return calls < 3
          ? result({ text: "not json", structuredError: "bad" })
          : result({ structured: { text: "x^2" }, text: '{"text":"x^2"}' });
      },
    });
    expect(output.data).toEqual({ text: "x^2" });
    // The first call and both repairs carry the same picture. The run is a stub, so no provider is called.
    expect(seen).toEqual([attachments, attachments, attachments]);
  });
});

describe("switching engines on a usage limit or sign-out", () => {
  const ready: AutoProvider[] = [
    {
      id: "claude",
      kind: "cli",
      effort: true,
      models: [{ id: "claude-sonnet-5", efforts: [] }],
    },
    {
      id: "codex",
      kind: "cli",
      effort: true,
      models: [{ id: "gpt-5.6-terra", efforts: [] }],
    },
  ];
  const limited = Object.assign(new Error("You've hit your usage limit"), {
    code: "cli-failed",
    limit: { kind: "rate", detail: "You've hit your usage limit" },
  });

  function automaticChat() {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('chat', ?, 1)",
    ).run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5", auto: true }),
    );
    rememberReady(ready);
    return db;
  }

  afterEach(() => {
    rememberReady([]);
    setFallbackListener(undefined);
    clearBench();
    vi.useRealTimers();
  });

  /** Runs one automatic chat call and returns the engines it tried. */
  async function ask(db: ReturnType<typeof openDatabase>, failWith: unknown) {
    const asked: string[] = [];
    await generate({
      selection: selectionFor(db, "chat"),
      prompt: "hi",
      run: async (input) => {
        asked.push(input.selection.provider);
        if (input.selection.provider === "claude") throw failWith;
        return result({ text: "ciao", provider: "codex" });
      },
    });
    return asked;
  }

  it("skips a limited engine until its limit resets", async () => {
    vi.useFakeTimers();
    const db = automaticChat();
    const resetAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const until = Object.assign(new Error("limit"), {
      code: "cli-failed",
      limit: { kind: "quota", resetAt, detail: "weekly limit" },
    });
    expect(await ask(db, until)).toEqual(["claude", "codex"]);
    vi.setSystemTime(Date.now() + 59 * 60_000);
    expect(await ask(db, until)).toEqual(["codex"]);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect(await ask(db, until)).toEqual(["claude", "codex"]);
    db.close();
  });

  it("skips a limited engine for 30 minutes when the limit names no reset time", async () => {
    vi.useFakeTimers();
    const db = automaticChat();
    expect(await ask(db, limited)).toEqual(["claude", "codex"]);
    vi.setSystemTime(Date.now() + DEFAULT_LIMIT_MS - 1000);
    expect(await ask(db, limited)).toEqual(["codex"]);
    vi.setSystemTime(Date.now() + 2000);
    expect(await ask(db, limited)).toEqual(["claude", "codex"]);
    db.close();
  });

  it("skips a signed-out engine until a scan finds it signed in again", async () => {
    vi.useFakeTimers();
    const db = automaticChat();
    const out = new FunnelError("Please run /login", "not-logged-in");
    expect(await ask(db, out)).toEqual(["claude", "codex"]);
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    expect(await ask(db, out)).toEqual(["codex"]);
    clearSignOut("claude");
    expect(await ask(db, out)).toEqual(["claude", "codex"]);
    db.close();
  });

  it("does not skip a limited engine the student pinned", async () => {
    const db = automaticChat();
    await ask(db, limited);
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
    );
    let tried = "";
    await generate({
      selection: selectionFor(db, "chat"),
      prompt: "hi",
      run: async (input) => {
        tried = input.selection.provider;
        return result({ text: "ok" });
      },
    });
    expect(tried).toBe("claude");
    db.close();
  });

  it("answers once on the next ready engine and says which one", async () => {
    const db = automaticChat();
    const heard: unknown[] = [];
    setFallbackListener((event) => heard.push(event));
    const asked: string[] = [];
    const output = await generate({
      selection: selectionFor(db, "chat"),
      prompt: "hi",
      run: async (input) => {
        asked.push(input.selection.provider);
        if (input.selection.provider === "claude") throw limited;
        return result({ text: "ciao", provider: "codex", model: "gpt-5.6-terra" });
      },
    });
    expect(asked).toEqual(["claude", "codex"]);
    expect(output.text).toBe("ciao");
    expect(output.fallback).toEqual({ from: "Claude Code", to: "Codex", reason: "limit" });
    expect(heard).toEqual([output.fallback]);
    db.close();
  });

  it("also moves on when the engine was signed out", async () => {
    const db = automaticChat();
    const output = await generate({
      selection: selectionFor(db, "chat"),
      prompt: "hi",
      run: async (input) => {
        if (input.selection.provider === "claude")
          throw new FunnelError("Please run /login", "not-logged-in");
        return result({ text: "ciao", provider: "codex" });
      },
    });
    expect(output.fallback?.reason).toBe("signed-out");
    db.close();
  });

  it("retries at most once and then shows the second engine's error", async () => {
    const db = automaticChat();
    let calls = 0;
    const error = await generate({
      selection: selectionFor(db, "chat"),
      prompt: "hi",
      run: async () => {
        calls += 1;
        throw limited;
      },
    }).catch((err: unknown) => err);
    expect(calls).toBe(2);
    expect(error).toMatchObject({ messageKey: "engines.errors.quota" });
    db.close();
  });

  it("keeps an engine the student pinned, and other failures, as they were", async () => {
    const db = automaticChat();
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
    );
    let calls = 0;
    await expect(
      generate({
        selection: selectionFor(db, "chat"),
        prompt: "hi",
        run: async () => {
          calls += 1;
          throw limited;
        },
      }),
    ).rejects.toMatchObject({ messageKey: "engines.errors.quota" });
    expect(calls).toBe(1);
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5", auto: true }),
    );
    calls = 0;
    await expect(
      generate({
        selection: selectionFor(db, "chat"),
        prompt: "hi",
        run: async () => {
          calls += 1;
          throw new FunnelError("exit 1", "cli-failed");
        },
      }),
    ).rejects.toMatchObject({ messageKey: "engines.errors.cli-failed" });
    expect(calls).toBe(1);
    db.close();
  });

  it("does not switch after the student stopped the turn", async () => {
    const db = automaticChat();
    const controller = new AbortController();
    let calls = 0;
    await expect(
      generate({
        selection: selectionFor(db, "chat"),
        prompt: "hi",
        signal: controller.signal,
        run: async () => {
          calls += 1;
          controller.abort();
          throw limited;
        },
      }),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
    db.close();
  });

  it("does not move a turn with a picture to an engine that cannot see it", async () => {
    const db = automaticChat();
    rememberReady([
      ready[0]!,
      { id: "agent", kind: "cli", effort: true, models: [{ id: "gemini-3.8-flash", efforts: [] }] },
    ]);
    let calls = 0;
    await expect(
      generate({
        selection: selectionFor(db, "chat"),
        prompt: "hi",
        attachments: [{ type: "image", mediaType: "image/png", data: "aGk=" }],
        run: async () => {
          calls += 1;
          throw limited;
        },
      }),
    ).rejects.toMatchObject({ messageKey: "engines.errors.quota" });
    expect(calls).toBe(1);
    db.close();
  });
});
