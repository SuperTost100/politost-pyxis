import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { IpcError } from "../../shared/ipc";
import { openDatabase } from "../db/connection";
import type { AutoProvider } from "./auto";
import {
  clearBench,
  clearSignOut,
  DEFAULT_LIMIT_MS,
  isBenched,
  isModelBenched,
  isSignedOut,
  MODEL_REFUSED_MS,
} from "./bench";
import { forgetModels, rememberModels } from "./efforts";
import { refuseImages } from "./test-images";
import { generate, setFallbackListener, type GenerateInput } from "./generate";
import { FunnelError, type EngineResult } from "./funnel";
import { chooseJobEngine, FIRST_PLAN_WAIT_MS, forgetFirstPlan, rememberOrder, rememberReady, selectionFor } from "./selection";
import { currentUsageScope, withUsageScope } from "./usage";

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

describe("generate with code in the answer", () => {
  const schema = z.object({ code: z.string(), note: z.string() });

  it("reads a tab in a verbatim field as a tab, and still repairs the LaTeX in the others", async () => {
    // As JSON: `\\t` before `plt` is a tab, and `\\theta` in the note is a model's single-backslash LaTeX.
    const text = '{"code":"if True:\\n\\tplt.plot([1])","note":"L\'angolo $\\theta$"}';
    const output = await generate({
      selection,
      prompt: "q",
      schema,
      verbatim: ["code"],
      run: async () => result({ text }),
    });
    expect(output.data).toEqual({ code: "if True:\n\tplt.plot([1])", note: "L'angolo $\\theta$" });
  });
});

describe("generate with LaTeX in the answer", () => {
  const schema = z.object({ stem: z.string(), note: z.string() });
  const wanted = { stem: "$m\\vec{g}\\sin\\theta$", note: "Riga uno\nriga due con $\\frac{a}{b}$" };

  it("restores the backslashes a model's single-backslash JSON turned into control characters", async () => {
    // Single backslashes: \v and \s are not JSON at all; \t, \n and \f are, and read as a tab, a line break and a form feed.
    const text = '{"stem":"$m\\vec{g}\\sin\\theta$","note":"Riga uno\\nriga due con $\\frac{a}{b}$"}';
    expect(() => JSON.parse(text)).toThrow();
    const output = await generate({
      selection,
      prompt: "q",
      schema,
      run: async () => result({ text }),
    });
    expect(output.data).toEqual({ stem: "$m\\vec{g}\\sin\\theta$", note: wanted.note });
  });

  it("repairs the same damage in an answer the engine already parsed", async () => {
    const output = await generate({
      selection,
      prompt: "q",
      schema,
      run: async () =>
        result({ structured: { stem: "$m\vec{g}\\sin\theta$", note: "Riga uno\nriga due con $\frac{a}{b}$" }, text: "" }),
    });
    expect(output.data).toEqual(wanted);
  });
});

describe("generate with a field that holds code", () => {
  const schema = z.object({ stem: z.string(), note: z.string() });
  // `note` is Python: the backslash and the n of a string literal are not a line break. `stem` is prose with LaTeX that the
  // model wrote with one backslash, which became a form feed and "rac" when it was read.
  const python = "plt.ylabel('Voltage\\n(V)')";
  const broken = "$\frac{a}{b}$";
  const whole = "$\\frac{a}{b}$";

  it("keeps the named fields as the model wrote them and repairs the rest, in a structured answer and in JSON text", async () => {
    const structured = await generate({
      selection,
      prompt: "q",
      schema,
      verbatim: ["note"],
      run: async () => result({ structured: { stem: broken, note: python }, text: "" }),
    });
    expect(structured.data).toEqual({ stem: whole, note: python });
    const text = await generate({
      selection,
      prompt: "q",
      schema,
      verbatim: ["note"],
      run: async () => result({ text: JSON.stringify({ stem: broken, note: python }) }),
    });
    expect(text.data).toEqual({ stem: whole, note: python });
    // Without the option the same answer is repaired, which is what breaks code: a line break where the escape was.
    const repaired = await generate({
      selection,
      prompt: "q",
      schema,
      run: async () => result({ structured: { stem: broken, note: python }, text: "" }),
    });
    expect(repaired.data).toEqual({ stem: whole, note: "plt.ylabel('Voltage\n(V)')" });
  });
});

describe("generate", () => {
  it("sends a union of shapes as anyOf, which strict schemas accept", async () => {
    let sent: unknown;
    await generate({
      selection,
      prompt: "one question",
      schema: z.object({
        questions: z.array(
          z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("tf"), correct: z.boolean() }),
            z.object({ kind: z.literal("open"), reference: z.string() }),
          ]),
        ),
      }),
      run: async (input) => {
        sent = input.responseSchema?.schema;
        return result({ structured: { questions: [{ kind: "tf", correct: true }] } });
      },
    });
    // Codex and the OpenAI API answer 400 to a strict schema with oneOf, so every quiz and card batch failed there.
    expect(JSON.stringify(sent)).not.toContain('"oneOf"');
    const items = (sent as { properties: { questions: { items: { anyOf: Array<{ additionalProperties: boolean }> } } } })
      .properties.questions.items;
    expect(items.anyOf).toHaveLength(2);
    expect(items.anyOf.every((shape) => shape.additionalProperties === false)).toBe(true);
  });

  it("requires every key, sends an optional one as nullable and reads its null as absent", async () => {
    let sent: unknown;
    const output = await generate({
      selection,
      prompt: "cards",
      schema: z.object({
        cards: z.array(
          z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("basic"), front: z.string(), hint: z.string().optional() }),
            z.object({ kind: z.literal("cloze"), text: z.string(), hint: z.string() }),
          ]),
        ),
        skipped: z.array(z.string()).optional(),
        parent: z.string().nullable(),
      }),
      run: async (input) => {
        sent = input.responseSchema?.schema;
        return result({
          structured: {
            cards: [
              { kind: "basic", front: "f'(x)", hint: null },
              { kind: "cloze", text: "(e^x)' = {{e^x}}", hint: "esponenziale" },
            ],
            skipped: null,
            parent: null,
          },
        });
      },
    });
    // Codex and the OpenAI API answer 400 to a strict schema whose `required` leaves out a key, so every flashcard
    // batch failed there on `skipped`.
    const root = sent as {
      required: string[];
      properties: { skipped: { anyOf: unknown[] }; cards: { items: { anyOf: Array<{ required: string[] }> } } };
    };
    expect(root.required).toEqual(["cards", "skipped", "parent"]);
    expect(root.properties.skipped.anyOf).toContainEqual({ type: "null" });
    expect(root.properties.cards.items.anyOf.map((shape) => shape.required)).toEqual([
      ["kind", "front", "hint"],
      ["kind", "text", "hint"],
    ]);
    // A null for an optional key means the model left it out; a null for a nullable key stays.
    expect(output.data).toEqual({
      cards: [
        { kind: "basic", front: "f'(x)" },
        { kind: "cloze", text: "(e^x)' = {{e^x}}", hint: "esponenziale" },
      ],
      parent: null,
    });
  });

  it("repairs one bad structured answer with the whole prompt, in a call of its own", async () => {
    const calls: string[] = [];
    const conversations: unknown[] = [];
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
        conversations.push(input.conversation);
        if (calls.length === 1)
          return result({ text: "blue", structuredError: "not json" });
        return result({
          structured: { colour: "blue" },
          text: '{"colour":"blue"}',
        });
      },
    });
    expect(calls).toHaveLength(2);
    // A call outside a conversation is not kept by the tool, so the repair cannot continue it: it carries the whole
    // prompt with the bad answer.
    expect(calls[1]).toContain("name a colour");
    expect(calls[1]).toContain("blue");
    expect(calls[1]).toContain("not json");
    expect(conversations).toEqual([undefined, undefined]);
    expect(output.data).toEqual({ colour: "blue" });
  });

  it("repairs a structured answer inside a conversation in the session it ran in, with only the error", async () => {
    const seen: Array<{ prompt: string; followUp?: string; session?: unknown }> = [];
    const output = await generate({
      selection,
      prompt: "whole outline request",
      followUpFor: () => "outline request",
      schema: z.object({ colour: z.string() }),
      conversation: { key: "lesson:t1", followUp: "", session: null, cliOnly: true },
      run: async (input) => {
        seen.push({ prompt: input.prompt, followUp: input.conversation?.followUp, session: input.conversation?.session });
        return seen.length === 1
          ? { ...result({ text: "blue", structuredError: "not json" }), sessionId: "s-9", cwd: "/scratch" }
          : result({ structured: { colour: "blue" }, text: '{"colour":"blue"}' });
      },
    });
    expect(output.data).toEqual({ colour: "blue" });
    expect(seen[0]!.session).toBeNull();
    // The second call resumes the session the first one opened and sends only the validation error and the bad answer.
    expect(seen[1]!.session).toEqual({ provider: "claude", id: "s-9", cwd: "/scratch" });
    expect(seen[1]!.followUp).toContain("not json");
    expect(seen[1]!.followUp).not.toContain("outline request");
    // Were the session lost, the whole request goes again with the bad answer.
    expect(seen[1]!.prompt).toContain("whole outline request");
  });

  it("repairs a structured answer inside a conversation with the whole prompt when an engine that keeps no session answered it", async () => {
    const seen: Array<{ prompt: string; followUp?: string; session?: unknown }> = [];
    const output = await generate({
      selection,
      prompt: "whole outline request",
      followUpFor: () => "outline request",
      schema: z.object({ colour: z.string() }),
      // The conversation holds a session that never saw this request: an API provider answered the first call.
      conversation: { key: "lesson:t1", followUp: "", session: { provider: "claude", id: "stored", cwd: "/scratch" }, cliOnly: true },
      run: async (input) => {
        seen.push({ prompt: input.prompt, followUp: input.conversation?.followUp, session: input.conversation?.session });
        return seen.length === 1
          ? result({ text: "blue", structuredError: "not json", provider: "anthropic-api" })
          : result({ structured: { colour: "blue" }, text: '{"colour":"blue"}' });
      },
    });
    expect(output.data).toEqual({ colour: "blue" });
    // The stored session is not resumed with only the error: it never received the request or the invalid reply.
    expect(seen[1]!.session).toBeNull();
    expect(seen[1]!.prompt).toContain("whole outline request");
    expect(seen[1]!.prompt).toContain("not json");
  });

  it("gives a repair the pictures the first call carried, when the caller decides them by the engine", async () => {
    const picture = { type: "image" as const, mediaType: "image/png" as const, data: "aGk=" };
    const decided: string[] = [];
    const attachments: unknown[] = [];
    const output = await generate({
      selection,
      prompt: "read the board",
      schema: z.object({ text: z.string() }),
      attachmentsFor: (engine) => {
        decided.push(engine.provider);
        return [picture];
      },
      run: async (input) => {
        attachments.push(input.attachments);
        return attachments.length === 1
          ? result({ text: "not json", structuredError: "bad" })
          : result({ structured: { text: "x^2" }, text: '{"text":"x^2"}' });
      },
    });
    expect(output.data).toEqual({ text: "x^2" });
    // Decided once for the engine, and the repair carries the same set.
    expect(decided).toEqual(["claude"]);
    expect(attachments).toEqual([[picture], [picture]]);
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
    expect(output.fallback).toEqual({ from: "Claude", to: "ChatGPT", reason: "limit" });
    expect(heard).toEqual([output.fallback]);
    db.close();
  });

  it("asks each engine at its own lowest effort when the call says so: a quiz that falls back from Claude to Gemini", async () => {
    const levels = [{ id: "low" }, { id: "medium" }, { id: "high" }];
    rememberModels("claude", [{ id: "claude-sonnet-5", efforts: levels }]);
    rememberModels("antigravity", [{ id: "gemini-4-hydrogen", efforts: levels }]);
    rememberReady([
      { id: "claude", kind: "cli", effort: true, models: [{ id: "claude-sonnet-5", efforts: levels }] },
      { id: "antigravity", kind: "cli", effort: true, models: [{ id: "gemini-4-hydrogen", efforts: levels }] },
    ]);
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('lesson', ?, 1)").run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5", auto: true }),
    );
    const asked: Array<[string, string | undefined]> = [];
    await generate({
      selection: selectionFor(db, "lesson"),
      prompt: "hi",
      lowEffort: "quiz",
      run: async (input) => {
        asked.push([input.selection.provider, input.selection.effort]);
        if (input.selection.provider === "claude") throw limited;
        return result({ text: "ok", provider: "antigravity", model: "gemini-4-hydrogen" });
      },
    });
    // Claude keeps the lesson's level for a quiz; Gemini, which the call fell back to, runs it at its lowest.
    expect(asked).toEqual([
      ["claude", "medium"],
      ["antigravity", "low"],
    ]);
    forgetModels();
    db.close();
  });

  it("builds the prompt again for the engine that answers instead, so a smaller window gets a smaller one", async () => {
    const db = automaticChat();
    const prompts: string[] = [];
    await generate({
      selection: selectionFor(db, "chat"),
      prompt: "built for the planned engine",
      promptFor: (provider) => `built for ${provider}`,
      run: async (input) => {
        prompts.push(`${input.selection.provider}: ${input.prompt}`);
        if (input.selection.provider === "claude") throw limited;
        return result({ text: "ciao", provider: "codex", model: "gpt-5.6-terra" });
      },
    });
    expect(prompts).toEqual(["claude: built for claude", "codex: built for codex"]);
    db.close();
  });

  it("builds the prompt only when the engine reads it", async () => {
    const db = automaticChat();
    let built = 0;
    await generate({
      selection: selectionFor(db, "chat"),
      prompt: "",
      promptFor: () => {
        built += 1;
        return "whole prompt";
      },
      run: async () => result({ text: "ok" }),
    });
    expect(built).toBe(0);
    db.close();
  });

  it("tells the listener which job the refused call belonged to", async () => {
    const db = automaticChat();
    const heard: Array<string | undefined> = [];
    setFallbackListener(() => heard.push(currentUsageScope()?.jobId));
    const call = () =>
      generate({
        selection: selectionFor(db, "chat"),
        prompt: "hi",
        run: async (input) => {
          if (input.selection.provider === "claude") throw limited;
          return result({ text: "ciao", provider: "codex" });
        },
      });
    await withUsageScope({ jobId: "job-1", kind: "cards-build" }, call);
    db.close();
    expect(heard).toEqual(["job-1"]);
  });

  // A subscription that leaves out the model Pyxis chose.
  const notIncluded = new FunnelError(
    "Claude Sonnet 5.5 is not included in your subscription.",
    "cli-failed",
  );

  it("moves on when the subscription does not include the model, and says so", async () => {
    const db = automaticChat();
    const heard: unknown[] = [];
    setFallbackListener((event) => heard.push(event));
    const output = await generate({
      selection: selectionFor(db, "chat"),
      prompt: "hi",
      run: async (input) => {
        if (input.selection.provider === "claude") throw notIncluded;
        return result({ text: "ciao", provider: "codex" });
      },
    });
    expect(output.text).toBe("ciao");
    expect(output.fallback).toEqual({ from: "Claude", to: "ChatGPT", reason: "model" });
    expect(heard).toEqual([output.fallback]);
    db.close();
  });

  it("skips only the refused model, for a day", async () => {
    vi.useFakeTimers();
    const db = automaticChat();
    expect(await ask(db, notIncluded)).toEqual(["claude", "codex"]);
    expect(await ask(db, notIncluded)).toEqual(["codex"]);
    expect(isModelBenched("claude", "claude-sonnet-5")).toBe(true);
    expect(isModelBenched("claude", "claude-haiku-5")).toBe(false);
    expect(isBenched("claude")).toBe(false);
    vi.setSystemTime(Date.now() + MODEL_REFUSED_MS + 1000);
    expect(await ask(db, notIncluded)).toEqual(["claude", "codex"]);
    db.close();
  });

  it("tries the same engine's other model when it is the only one ready", async () => {
    const db = automaticChat();
    rememberReady([
      {
        id: "claude",
        kind: "cli",
        effort: true,
        models: [
          { id: "claude-sonnet-5", efforts: [] },
          { id: "claude-haiku-5", efforts: [] },
        ],
      },
    ]);
    const asked: string[] = [];
    const output = await generate({
      selection: selectionFor(db, "chat"),
      prompt: "hi",
      run: async (input) => {
        asked.push(`${input.selection.provider}/${input.selection.model}`);
        if (input.selection.model === "claude-sonnet-5") throw notIncluded;
        return result({ text: "ciao", model: input.selection.model });
      },
    });
    expect(asked).toEqual(["claude/claude-sonnet-5", "claude/claude-haiku-5"]);
    expect(output.text).toBe("ciao");
    expect(output.fallback).toEqual({
      from: "Claude",
      to: "Claude (Claude Haiku 5)",
      reason: "model",
    });
    db.close();
  });

  it("names the refusal when the student pinned the model", async () => {
    const db = automaticChat();
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
    );
    await expect(
      generate({
        selection: selectionFor(db, "chat"),
        prompt: "hi",
        run: async () => {
          throw notIncluded;
        },
      }),
    ).rejects.toMatchObject({ messageKey: "engines.errors.model-not-included" });
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

  it("marks the engine it moved to as signed out when that one refuses the sign-in too", async () => {
    const db = automaticChat();
    const out = new FunnelError("Please run /login", "not-logged-in");
    await expect(
      generate({
        selection: selectionFor(db, "chat"),
        prompt: "hi",
        run: async () => {
          throw out;
        },
      }),
    ).rejects.toMatchObject({ messageKey: "engines.errors.not-logged-in" });
    expect(isSignedOut("claude")).toBe(true);
    // Settings would otherwise keep showing it as ready while every call to it fails.
    expect(isSignedOut("codex")).toBe(true);
    db.close();
  });

  it("shows the second engine's error when it is out too and no third one is ready", async () => {
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

  it("keeps a job's picture off the tool the student chose for it when that tool cannot see it", async () => {
    refuseImages("antigravity");
    const db = automaticChat();
    rememberReady([
      ready[0]!,
      { id: "antigravity", kind: "cli", effort: true, images: false, models: [{ id: "gemini-4-hydrogen", efforts: [] }] },
    ]);
    const asked: string[] = [];
    const call = (jobId: string, attachments?: GenerateInput["attachments"]) =>
      withUsageScope({ jobId, kind: "source-import-vision" }, () =>
        generate({
          selection: selectionFor(db, "chat"),
          prompt: "hi",
          attachments,
          run: async (input) => {
            asked.push(input.selection.provider);
            return result({ text: "ok", provider: input.selection.provider });
          },
        }),
      );
    // A job told to go on with Gemini goes there with text, as before.
    chooseJobEngine("job-text", "antigravity");
    await call("job-text");
    expect(asked).toEqual(["antigravity"]);
    // With a picture it stays on the tool it was on, as an automatic move would not leave it for one that cannot see.
    chooseJobEngine("job-picture", "antigravity");
    await call("job-picture", [{ type: "image", mediaType: "image/png", data: "aGk=" }]);
    expect(asked).toEqual(["antigravity", "claude"]);
    db.close();
  });

  it("does not move a turn with a picture to an engine that cannot see it", async () => {
    refuseImages("antigravity");
    const db = automaticChat();
    rememberReady([
      ready[0]!,
      { id: "antigravity", kind: "cli", effort: true, images: false, models: [{ id: "gemini-4-hydrogen", efforts: [] }] },
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

describe("a chosen engine whose subscription refuses the model", () => {
  /** Antigravity's models as `agy models` lists them, with the other makers' mixed in. */
  const gemini: AutoProvider = {
    id: "antigravity",
    kind: "cli",
    effort: true,
    images: false,
    models: [
      "claude-opus-5-5",
      "gemini-4-neon",
      "gpt-oss-120b-medium",
      "gemini-4-hydrogen",
      "claude-sonnet-5-5",
      "gemini-4-argon",
      "gemini-4-carbon",
    ].map((id) => ({ id, efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }] })),
  };
  /** A plan that leaves one model out. */
  const refusal = (model: string) =>
    Object.assign(new Error(`agy exited (1) without a result. ${model} is not included in your subscription.`), {
      code: "cli-failed",
    });

  /** The plan task on Antigravity alone, as "Scelgo io" with only Gemini ticked leaves it. */
  function geminiOnly(model = "gemini-4-carbon") {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('plan', ?, 1)",
    ).run(
      JSON.stringify({ provider: "antigravity", model, effort: "high", auto: true }),
    );
    rememberReady([gemini]);
    return db;
  }

  afterEach(() => {
    rememberReady([]);
    setFallbackListener(undefined);
    clearBench();
    forgetModels();
  });

  it("moves a job's saved selection to the engine's next model of the role", async () => {
    const db = geminiOnly();
    // A background job keeps its selection in its saved parameters, so it comes back as plain JSON.
    const saved = JSON.parse(JSON.stringify(selectionFor(db, "plan"))) as ReturnType<
      typeof selectionFor
    >;
    const asked: string[] = [];
    const output = await generate({
      selection: saved,
      prompt: "hi",
      run: async (input) => {
        asked.push(input.selection.model);
        if (input.selection.model === "gemini-4-carbon") throw refusal("Gemini 4 Carbon");
        return result({ text: "ciao", provider: "antigravity", model: input.selection.model });
      },
    });
    expect(asked).toEqual(["gemini-4-carbon", "gemini-4-argon"]);
    expect(output.text).toBe("ciao");
    expect(output.fallback).toEqual({
      from: "Gemini",
      to: "Gemini (Gemini 4 Argon)",
      reason: "model",
    });
    db.close();
  });

  describe("a job saved by an earlier build", () => {
    /** Runs one call with a saved selection and returns the models the engine was asked for. */
    async function asking(selection: object, ready: AutoProvider[] = [gemini]): Promise<{ asked: string[]; fallback: unknown }> {
      const db = geminiOnly();
      rememberReady(ready);
      // What Antigravity reported when the app last listed its models: the others' models are not Gemini's own.
      rememberModels("antigravity", gemini.models.filter((model) => /gemini/.test(model.id)), gemini.models);
      const asked: string[] = [];
      const output = await generate({
        selection: JSON.parse(JSON.stringify(selection)) as ReturnType<typeof selectionFor>,
        prompt: "hi",
        run: async (input) => {
          asked.push(`${input.selection.provider}/${input.selection.model}`);
          return result({ text: "ciao", provider: input.selection.provider, model: input.selection.model });
        },
      });
      db.close();
      return { asked, fallback: output.fallback };
    }

    it("goes back to the automatic choice when it names another maker's model on the tool, and asks the tool for no such model", async () => {
      const { asked, fallback } = await asking({
        provider: "antigravity",
        model: "claude-opus-5-5",
        effort: "high",
        chosenFor: "plan",
      });
      expect(asked).toEqual(["antigravity/gemini-4-carbon"]);
      expect(fallback).toBeUndefined();
    });

    it("does the same for a selection the student had pinned, which names no task", async () => {
      expect((await asking({ provider: "antigravity", model: "gpt-oss-120b-medium" })).asked).toEqual([
        "antigravity/gemini-4-hydrogen",
      ]);
      expect((await asking({ provider: "antigravity", model: "claude-sonnet-5-5", effort: "high" })).asked).toEqual([
        "antigravity/gemini-4-hydrogen",
      ]);
    });

    it("keeps the tool's own models and ids nobody knows as they were", async () => {
      expect((await asking({ provider: "antigravity", model: "gemini-4-neon", chosenFor: "chat" })).asked).toEqual([
        "antigravity/gemini-4-neon",
      ]);
      expect((await asking({ provider: "antigravity", model: "recorded-fixture" })).asked).toEqual([
        "antigravity/recorded-fixture",
      ]);
    });

    it("moves a job that named Cursor, a tool Pyxis no longer offers, to the automatic choice for its task", async () => {
      // The job's task decides the role: the plan runs on the strong model, the default task on the middle one.
      expect(
        (await asking({ provider: "agent", model: "grok-4.7", effort: "high", chosenFor: "plan" })).asked,
      ).toEqual(["antigravity/gemini-4-carbon"]);
      const pinned = await asking({ provider: "agent", model: "cursor-grok-4.6" });
      expect(pinned.asked).toEqual(["antigravity/gemini-4-hydrogen"]);
      // Nothing says the job ran on another tool than the one the student has now.
      expect(pinned.fallback).toBeUndefined();
    });

    it("holds a job that names Cursor until the first plan exists, then moves it, so the first launch after the update does not fail it", async () => {
      forgetFirstPlan();
      rememberReady([]);
      forgetFirstPlan();
      const asked: string[] = [];
      let finished = false;
      const answer = generate({
        selection: { provider: "agent", model: "grok-4.7", chosenFor: "plan" } as ReturnType<typeof selectionFor>,
        prompt: "hi",
        run: async (input) => {
          asked.push(`${input.selection.provider}/${input.selection.model}`);
          return result({ text: "ciao", provider: input.selection.provider, model: input.selection.model });
        },
      }).then((output) => {
        finished = true;
        return output;
      });
      // The runner is up and no plan was made: nothing is asked, and nothing fails.
      await new Promise((resume) => setTimeout(resume, 30));
      expect(finished).toBe(false);
      expect(asked).toEqual([]);
      // The plan arrives with Gemini: the job goes on there.
      rememberReady([gemini]);
      await answer;
      expect(asked).toEqual(["antigravity/gemini-4-carbon"]);
    });

    it("stops a held job with no engine when no plan arrives in time", async () => {
      vi.useFakeTimers();
      try {
        forgetFirstPlan();
        const stopped = generate({
          selection: { provider: "agent", model: "grok-4.7", chosenFor: "plan" } as ReturnType<typeof selectionFor>,
          prompt: "hi",
          run: async () => result({ text: "never", provider: "agent" }),
        }).catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(FIRST_PLAN_WAIT_MS + 1);
        expect(await stopped).toMatchObject({ code: "engine-missing" });
      } finally {
        vi.useRealTimers();
        rememberReady([]);
      }
    });

    it("ends a held job as cancelled when the student cancels it, at once, and leaves no timer or waiter behind", async () => {
      vi.useFakeTimers();
      try {
        forgetFirstPlan();
        const controller = new AbortController();
        const stopped = generate({
          selection: { provider: "agent", model: "grok-4.7", chosenFor: "plan" } as ReturnType<typeof selectionFor>,
          prompt: "hi",
          signal: controller.signal,
          run: async () => result({ text: "never", provider: "agent" }),
        }).catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(vi.getTimerCount()).toBe(1);
        controller.abort();
        const error = await stopped;
        // The cancellation, not engine-missing 60 seconds later.
        expect(error).toMatchObject({ name: "AbortError" });
        expect(vi.getTimerCount()).toBe(0);
        // A plan that arrives later finds nobody waiting and changes nothing.
        rememberReady([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not wait at all for a job that was already cancelled", async () => {
      forgetFirstPlan();
      const controller = new AbortController();
      controller.abort();
      await expect(
        generate({
          selection: { provider: "agent", model: "grok-4.7", chosenFor: "plan" } as ReturnType<typeof selectionFor>,
          prompt: "hi",
          signal: controller.signal,
          run: async () => result({ text: "never", provider: "agent" }),
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      rememberReady([]);
    });

    it("stops with no engine when the tool the job named was the only one and nothing else is ready", async () => {
      const db = openDatabase(":memory:");
      rememberReady([]);
      await expect(
        generate({
          selection: { provider: "agent", model: "grok-4.7", chosenFor: "plan" } as ReturnType<typeof selectionFor>,
          prompt: "hi",
          run: async () => result({ text: "never", provider: "agent" }),
        }),
      ).rejects.toMatchObject({ code: "engine-missing" });
      db.close();
    });

    it("keeps the job on its own tool, whatever order the student put their tools in", async () => {
      const db = geminiOnly();
      const codex: AutoProvider = {
        id: "codex",
        kind: "cli",
        effort: true,
        models: [{ id: "gpt-6.2-sol", efforts: [{ id: "low" }, { id: "high" }] }, { id: "gpt-6-luna", efforts: [{ id: "low" }] }],
      };
      rememberReady([gemini, codex]);
      // ChatGPT first: the plan for a new task would give it to ChatGPT, but this job ran on Gemini.
      rememberOrder(["codex", "antigravity"]);
      try {
        for (const saved of [
          { provider: "antigravity", model: "claude-opus-5-5", effort: "high", chosenFor: "plan" },
          { provider: "antigravity", model: "claude-sonnet-5-5" },
        ]) {
          const asked: string[] = [];
          await generate({
            selection: JSON.parse(JSON.stringify(saved)) as ReturnType<typeof selectionFor>,
            prompt: "hi",
            run: async (input) => {
              asked.push(`${input.selection.provider}/${input.selection.model}`);
              return result({ text: "ciao", provider: input.selection.provider, model: input.selection.model });
            },
          });
          expect(asked[0], JSON.stringify(saved)).toMatch(/^antigravity\/gemini-4-/);
        }
        // When Gemini cannot take the task, the plan for the ready tools gives it to the next one.
        rememberReady([codex]);
        const moved: string[] = [];
        await generate({
          selection: { provider: "antigravity", model: "claude-opus-5-5", chosenFor: "plan" },
          prompt: "hi",
          run: async (input) => {
            moved.push(`${input.selection.provider}/${input.selection.model}`);
            return result({ text: "ciao", provider: input.selection.provider, model: input.selection.model });
          },
        });
        expect(moved).toEqual(["codex/gpt-6.2-sol"]);
      } finally {
        rememberOrder(null);
      }
      db.close();
    });

    it("still moves on afterwards like any automatic call, because the new selection is automatic", async () => {
      const db = geminiOnly();
      const asked: string[] = [];
      await generate({
        selection: { provider: "antigravity", model: "claude-opus-5-5", chosenFor: "plan" },
        prompt: "hi",
        run: async (input) => {
          asked.push(input.selection.model);
          if (input.selection.model === "gemini-4-carbon") throw refusal("Gemini 4 Carbon");
          return result({ text: "ciao", provider: "antigravity", model: input.selection.model });
        },
      });
      expect(asked).toEqual(["gemini-4-carbon", "gemini-4-argon"]);
      db.close();
    });
  });

  it("sends the engine only the selection, without Pyxis's own bookkeeping", async () => {
    const db = geminiOnly();
    const sent: object[] = [];
    await generate({
      selection: selectionFor(db, "plan"),
      prompt: "hi",
      run: async (input) => {
        sent.push(input.selection);
        return result({ text: "ciao", provider: "antigravity" });
      },
    });
    expect(sent).toEqual([{ provider: "antigravity", model: "gemini-4-carbon", effort: "high" }]);
    db.close();
  });

  it("tries a few more of the engine's own models after a refusal, in the file's order", async () => {
    const db = geminiOnly();
    const asked: string[] = [];
    const output = await generate({
      selection: selectionFor(db, "plan"),
      prompt: "hi",
      run: async (input) => {
        asked.push(input.selection.model);
        if (["gemini-4-carbon", "gemini-4-argon"].includes(input.selection.model)) throw refusal("Gemini");
        return result({ text: "ciao", provider: "antigravity", model: input.selection.model });
      },
    });
    // Never a Claude or GPT model of the account: after Carbon and Argon the file's next Gemini model is used.
    expect(asked).toEqual(["gemini-4-carbon", "gemini-4-argon", "gemini-4-neon"]);
    expect(output.text).toBe("ciao");
    db.close();
  });

  it("stops after three more models and names the refusal", async () => {
    const db = geminiOnly();
    let calls = 0;
    await expect(
      generate({
        selection: selectionFor(db, "plan"),
        prompt: "hi",
        run: async () => {
          calls += 1;
          throw refusal("This model");
        },
      }),
    ).rejects.toMatchObject({
      code: "model-not-included",
      params: { provider: "antigravity" },
    });
    expect(calls).toBe(4);
    db.close();
  });

  it("never walks to another company's model on its way down the refusals", async () => {
    const db = geminiOnly();
    const asked: string[] = [];
    await generate({
      selection: selectionFor(db, "plan"),
      prompt: "hi",
      run: async (input) => {
        asked.push(input.selection.model);
        if (asked.length < 4) throw refusal("This model");
        return result({ text: "ciao", provider: "antigravity", model: input.selection.model });
      },
    });
    expect(asked.every((model) => /gemini/.test(model))).toBe(true);
    db.close();
  });

  it("lets a tool reached after two out of requests try its next model, since no model was refused before", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('plan', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-opus-5-5", auto: true }));
    const other = (id: string, model: string): AutoProvider => ({ id, kind: "cli", effort: false, models: [{ id: model, efforts: [] }] });
    rememberReady([other("claude", "claude-opus-5-5"), other("codex", "gpt-5.6-sol"), gemini]);
    // The student's order puts Gemini last: two tools are out of requests before it is reached.
    rememberOrder(["claude", "codex", "antigravity"]);
    const asked: string[] = [];
    try {
      const output = await generate({
        selection: selectionFor(db, "plan"),
        prompt: "hi",
        run: async (input) => {
          asked.push(`${input.selection.provider}:${input.selection.model}`);
          if (input.selection.provider !== "antigravity")
            throw Object.assign(new Error("You've hit your usage limit"), { code: "cli-failed" });
          // Gemini refuses its first model; its next one answers.
          if (asked.filter((entry) => entry.startsWith("antigravity")).length === 1) throw refusal("Gemini 4 Carbon");
          return result({ text: "ciao", provider: "antigravity", model: input.selection.model });
        },
      });
      expect(output.text).toBe("ciao");
      expect(asked.map((entry) => entry.split(":")[0])).toEqual(["claude", "codex", "antigravity", "antigravity"]);
    } finally {
      rememberOrder(null);
    }
    db.close();
  });

  it("leaves the student's pinned model alone and names the refusal", async () => {
    const db = geminiOnly();
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(
      JSON.stringify({ provider: "antigravity", model: "gemini-4-carbon" }),
    );
    let calls = 0;
    await expect(
      generate({
        selection: JSON.parse(JSON.stringify(selectionFor(db, "plan"))),
        prompt: "hi",
        run: async () => {
          calls += 1;
          throw refusal("Gemini 4 Carbon");
        },
      }),
    ).rejects.toMatchObject({ code: "model-not-included", params: { provider: "antigravity" } });
    expect(calls).toBe(1);
    // The refused model is still marked, so Settings can say the engine is missing it.
    expect(isModelBenched("antigravity", "gemini-4-carbon")).toBe(true);
    db.close();
  });
});
