import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAbort } from "../../shared/ipc";

type Request = {
  selection: { provider: string; model: string };
  prompt: string;
  sessionId?: string;
  cache?: boolean;
  signal?: AbortSignal;
  verbose?: boolean;
};
type Outcome = {
  text?: string;
  usage?: Record<string, number>;
  finishReason?: string;
  error?: Error;
  sessionId?: string;
};

const run = vi.fn<(request: Request) => Promise<Outcome> | Outcome>();
const closeSession = vi.fn();
const close = vi.fn();
const refresh = vi.fn();
const createFunnel = vi.fn();
/** The options of the funnel funnel.ts made, kept outside the mock's call log. */
const created: { options?: unknown } = {};
const apiBuilds = vi.fn();

// A stand-in for CLI Funnel: it streams what `run` returns, with a session event first, like the real providers.
function fakeFunnel(options: { providers?: Record<string, unknown> }) {
  const caps = (cache: boolean) => ({ access: ["none"], cache });
  return {
    providers: {
      claude: { capabilities: caps(false), openSession: () => undefined },
      codex: { capabilities: caps(false), openSession: () => undefined },
      agent: { capabilities: caps(false) },
      antigravity: { capabilities: caps(false) },
      ...options.providers,
    },
    sessionsEnabled: true,
    closeSession,
    close,
    refresh,
    stream(request: Request) {
      let settle!: (value: unknown) => void;
      let fail!: (err: unknown) => void;
      const result = new Promise((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      result.catch(() => undefined);
      return Object.assign(
        (async function* () {
          const outcome = await run(request);
          const sessionId =
            outcome.sessionId ?? request.sessionId ?? `s-${run.mock.calls.length}`;
          yield { type: "session", sessionId };
          if (outcome.error) {
            fail(outcome.error);
            throw outcome.error;
          }
          if (outcome.text) yield { type: "text.delta", text: outcome.text };
          settle({
            text: outcome.text ?? "",
            model: request.selection.model,
            provider: request.selection.provider,
            sessionId,
            usage: outcome.usage,
            finishReason: outcome.finishReason ?? "stop",
          });
        })(),
        { result },
      );
    },
  };
}

vi.mock("cli-funnel", async (original) => ({
  ...(await original<typeof import("cli-funnel")>()),
  createFunnel: (options: { providers?: Record<string, unknown> }) => {
    createFunnel(options);
    created.options = options;
    return fakeFunnel(options);
  },
  createApiProviders: (keys: Record<string, string | undefined>) => {
    apiBuilds(keys);
    const provider = (id: string, cache: boolean) => ({
      id,
      displayName: id,
      capabilities: { access: [], cache, effort: true },
    });
    return {
      "anthropic-api": provider("anthropic-api", true),
      "openai-api": provider("openai-api", false),
    };
  },
}));

const {
  closeFunnel,
  endConversation,
  getFunnel,
  runTurn,
  SCHEMA_REPLY,
  setApiKeys,
  setScratch,
  CONVERSATION_IDLE_MS,
  cursorSessionLost,
  setCursorChatsRoot,
} = await import("./funnel");

const { readJobLog, setDebugLogRoot, setDebugOn } = await import("../debug/log");
const { withUsageScope } = await import("./usage");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

beforeEach(() => {
  // No Cursor folder on this machine decides a test; the tests of the check give it one.
  setCursorChatsRoot(null);
  run.mockReset();
  closeSession.mockReset();
  setScratch("/scratch");
});

afterEach(() => {
  closeFunnel();
  vi.useRealTimers();
});

describe("runTurn", () => {
  it.each(["agent", "antigravity", "claude"] as const)(
    "runs %s with text-only access in the scratch folder",
    async (provider) => {
      run.mockResolvedValueOnce({ text: "ok" });
      await runTurn({ selection: { provider, model: "m" }, prompt: "hi" });
      expect(run.mock.calls[0]?.[0].selection).toEqual({
        provider,
        model: "m",
        cwd: "/scratch",
        access: "none",
      });
    },
  );

  it("asks Antigravity for JSON in the prompt instead of its schema flag", async () => {
    run.mockResolvedValue({ text: '{"score":0.4,"explanation":"Manca il fattore $2x$."}' });
    const schema = { type: "object", properties: { score: { type: "number" } }, required: ["score"] };
    const result = await runTurn({
      selection: { provider: "antigravity", model: "claude-sonnet-4-6" },
      prompt: "Grade this.",
      responseSchema: { name: "response", schema },
    });
    // With --json-schema, agy 1.4 fills the schema with a report on its own run: Sonnet graded its own work 1 and
    // narrated it, and Gemini returned nothing.
    const sent = run.mock.calls[0]![0] as Request & { responseSchema?: unknown };
    expect(sent.responseSchema).toBeUndefined();
    expect(sent.prompt).toBe(`Grade this.\n\n${SCHEMA_REPLY}\n${JSON.stringify(schema)}`);
    expect(result.text).toBe('{"score":0.4,"explanation":"Manca il fattore $2x$."}');
    // Every other engine keeps its native structured output.
    await runTurn({
      selection: { provider: "claude", model: "m" },
      prompt: "Grade this.",
      responseSchema: { name: "response", schema },
    });
    const native = run.mock.calls[1]![0] as Request & { responseSchema?: unknown };
    expect(native.prompt).toBe("Grade this.");
    expect(native.responseSchema).toEqual({ name: "response", schema });
  });

  it("reports a provider failure raised by cancellation as an abort", async () => {
    const controller = new AbortController();
    run.mockImplementationOnce(async () => {
      controller.abort();
      return { error: new Error("context canceled") };
    });
    const error = await runTurn({
      selection: { provider: "antigravity", model: "m" },
      prompt: "hi",
      signal: controller.signal,
    }).catch((err: unknown) => err);
    expect(isAbort(error)).toBe(true);
  });

  it("keeps provider failures that were not cancelled", async () => {
    run.mockResolvedValueOnce({ error: new Error("quota") });
    await expect(
      runTurn({ selection: { provider: "agent", model: "m" }, prompt: "hi" }),
    ).rejects.toThrow("quota");
  });

  it("reports output and prompt-cache tokens with the input tokens", async () => {
    run.mockResolvedValueOnce({
      text: "ok",
      usage: {
        inputTokens: 900,
        outputTokens: 40,
        cachedInputTokens: 700,
        cacheCreationInputTokens: 150,
        totalTokens: 940,
      },
    });
    const result = await runTurn({
      selection: { provider: "anthropic-api", model: "m" },
      prompt: "hi",
    });
    expect(result).toMatchObject({
      inputTokens: 900,
      outputTokens: 40,
      cacheReadTokens: 700,
      cacheWriteTokens: 150,
    });
  });

  it("stops the CLI process of a run outside a chat when it ends, also after a failure", async () => {
    run.mockResolvedValueOnce({ text: "ok", sessionId: "lesson-1" });
    await runTurn({ selection: { provider: "claude", model: "m" }, prompt: "hi" });
    expect(closeSession).toHaveBeenCalledWith("lesson-1", "claude");
    run.mockResolvedValueOnce({ error: new Error("boom"), sessionId: "lesson-2" });
    await runTurn({
      selection: { provider: "claude", model: "m" },
      prompt: "hi",
    }).catch(() => undefined);
    expect(closeSession).toHaveBeenCalledWith("lesson-2", "claude");
  });

  it("asks for prompt caching only from a provider that has it", async () => {
    run.mockResolvedValue({ text: "ok" });
    for (const provider of ["anthropic-api", "openai-api", "claude"] as const)
      await runTurn({ selection: { provider, model: "m" }, prompt: "hi", cache: true });
    expect(run.mock.calls.map(([request]) => request.cache)).toEqual([
      true,
      undefined,
      undefined,
    ]);
  });
});

describe("chat conversations", () => {
  type Provider = "claude" | "codex" | "agent" | "antigravity";
  const chat = (
    followUp: string,
    options: { provider?: Provider; session?: { provider: string; id: string; cwd: string }; system?: string } = {},
  ) => ({
    selection: { provider: options.provider ?? "claude", model: "m" },
    prompt: `whole context, then ${followUp}`,
    system: options.system ?? "tutor",
    conversation: { key: "chat-1", followUp, session: options.session ?? null },
  });
  const stored = (provider: string, id = "s-1") => ({ provider, id, cwd: "/scratch" });

  it("sends the whole context for a chat with no session, and reports the session id to store", async () => {
    run.mockResolvedValue({ text: "answer" });
    const first = await runTurn(chat("first"));
    const one = run.mock.calls[0]![0];
    expect(one.prompt).toBe("whole context, then first");
    expect(one.sessionId).toBeUndefined();
    expect(first).toMatchObject({ sessionId: "s-1", cwd: "/scratch", continued: false });
  });

  it.each(["claude", "codex", "agent", "antigravity"] as const)(
    "continues the stored %s session by id, in the same folder, with only the new message",
    async (provider) => {
      run.mockResolvedValue({ text: "answer" });
      const result = await runTurn(chat("second", { provider, session: stored(provider) }));
      const two = run.mock.calls[0]![0];
      expect(two.prompt).toBe("second");
      expect(two.sessionId).toBe("s-1");
      expect(result).toMatchObject({ sessionId: "s-1", continued: true });
      // The chat's process stays up between questions.
      expect(closeSession).not.toHaveBeenCalled();
    },
  );

  it("leaves the system prompt out of a turn in a session Cursor Agent or Antigravity holds, which got it in the first prompt", async () => {
    run.mockResolvedValue({ text: "answer" });
    for (const provider of ["agent", "antigravity", "claude", "codex"] as const) {
      await runTurn(chat("next", { provider, session: stored(provider) }));
      await runTurn(chat("first", { provider }));
    }
    const systems = run.mock.calls.map(([request]) => (request as { system?: string }).system);
    // Continued, then new, for each provider in turn.
    expect(systems).toEqual([undefined, "tutor", undefined, "tutor", "tutor", "tutor", "tutor", "tutor"]);
  });

  it("goes on in the session it tracked for a caller that stores none, such as a lesson's tool rounds", async () => {
    run.mockResolvedValue({ text: "answer" });
    for (const provider of ["claude", "agent"] as const) {
      run.mockClear();
      const round = (followUp: string) => ({
        selection: { provider, model: "m" },
        prompt: `whole transcript, then ${followUp}`,
        system: "tutor",
        conversation: { key: `lesson-${provider}`, followUp },
      });
      await runTurn(round("first"));
      await runTurn(round("second"));
      expect(run.mock.calls[1]![0], provider).toMatchObject({ prompt: "second", sessionId: "s-1" });
    }
  });

  it("builds the whole prompt only when it is sent: not for a turn that resumes, once for a fresh start or a lost session", async () => {
    let reads = 0;
    const lazy = (session: { provider: string; id: string; cwd: string } | null) => ({
      selection: { provider: "claude" as const, model: "m" },
      get prompt() {
        reads += 1;
        return "whole context";
      },
      conversation: { key: "chat-1", followUp: "second", session },
    });
    run.mockResolvedValue({ text: "answer" });
    await runTurn(lazy(stored("claude")));
    expect(reads).toBe(0);
    await runTurn(lazy(null));
    expect(reads).toBe(1);
    run.mockReset();
    run
      .mockResolvedValueOnce({ error: new Error("No conversation found with session ID: s-1") })
      .mockResolvedValueOnce({ text: "answer" });
    await runTurn(lazy(stored("claude")));
    expect(reads).toBe(2);
  });

  it("starts a new session when the tool answers a resume under another session id", async () => {
    run.mockResolvedValueOnce({ text: "no history", sessionId: "s-other" }).mockResolvedValueOnce({ text: "answer", sessionId: "s-new" });
    const result = await runTurn(chat("second", { session: stored("claude") }));
    expect(run.mock.calls.map(([request]) => request.sessionId)).toEqual(["s-1", undefined]);
    expect(run.mock.calls[1]![0].prompt).toBe("whole context, then second");
    expect(result).toMatchObject({ text: "answer", sessionId: "s-new", continued: false });
  });

  it("keeps an API conversation as history, so the cached start stays the same", async () => {
    run.mockResolvedValue({ text: "answer" });
    await runTurn({ ...chat("first", { provider: "anthropic-api" as never }), cache: true });
    await runTurn({ ...chat("second", { provider: "anthropic-api" as never }), cache: true });
    const two = run.mock.calls[1]?.[0];
    expect(two).toMatchObject({ prompt: "second", sessionId: "s-1", cache: true });
  });

  it("starts a new session, with the whole prompt, on another tool or in another folder", async () => {
    run.mockResolvedValue({ text: "answer" });
    const moved = await runTurn(chat("second", { provider: "codex", session: stored("claude") }));
    expect(run.mock.calls[0]![0]).toMatchObject({ prompt: "whole context, then second" });
    expect(run.mock.calls[0]![0].sessionId).toBeUndefined();
    expect(moved.continued).toBe(false);
    setScratch("/other");
    await runTurn(chat("third", { session: stored("claude") }));
    expect(run.mock.calls[1]![0].sessionId).toBeUndefined();
    expect(run.mock.calls[1]![0].prompt).toBe("whole context, then third");
  });

  it("continues the session when the model or the effort changes", async () => {
    run.mockResolvedValue({ text: "answer" });
    await runTurn({
      ...chat("second", { session: stored("claude") }),
      selection: { provider: "claude", model: "other-model", effort: "high" },
    });
    expect(run.mock.calls[0]![0]).toMatchObject({ prompt: "second", sessionId: "s-1" });
  });

  it("starts over with the whole prompt when the tool no longer holds the session", async () => {
    run
      .mockResolvedValueOnce({ error: new Error("Claude Code failed (error_during_execution). No conversation found with session ID: s-1") })
      .mockResolvedValueOnce({ text: "answer", sessionId: "s-new" });
    const result = await runTurn(chat("second", { session: stored("claude") }));
    expect(run.mock.calls.map(([request]) => request.sessionId)).toEqual(["s-1", undefined]);
    expect(run.mock.calls[1]![0].prompt).toBe("whole context, then second");
    expect(result).toMatchObject({ text: "answer", sessionId: "s-new", continued: false });
    // A failure that says nothing about the session is not retried.
    run.mockReset();
    run.mockResolvedValueOnce({ error: new Error("usage limit") });
    await expect(runTurn(chat("third", { session: stored("claude") }))).rejects.toThrow("usage limit");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports the session as soon as the tool names it, so a turn the student stops can be continued", async () => {
    const heard: string[] = [];
    run.mockResolvedValueOnce({ text: "part", finishReason: "cancelled" });
    await runTurn({
      ...chat("first"),
      conversation: { key: "chat-1", followUp: "first", onSession: (id, provider, cwd) => heard.push(`${provider} ${id} ${cwd}`) },
    }).catch(() => undefined);
    expect(heard).toEqual(["claude s-1 /scratch"]);
  });

  it("keeps the stored session after a stopped or failed turn, and stops no process for it", async () => {
    run.mockResolvedValueOnce({ text: "part", finishReason: "cancelled" });
    await runTurn(chat("first")).catch(() => undefined);
    run.mockResolvedValueOnce({ error: new Error("boom") });
    await runTurn(chat("second", { session: stored("claude") })).catch(() => undefined);
    expect(closeSession).not.toHaveBeenCalled();
    run.mockResolvedValueOnce({ text: "answer" });
    await runTurn(chat("third", { session: stored("claude") }));
    expect(run.mock.calls[2]?.[0]).toMatchObject({ prompt: "third", sessionId: "s-1" });
  });

  it("starts an API conversation over after ten idle minutes and after a failed turn", async () => {
    vi.useFakeTimers();
    run.mockResolvedValue({ text: "answer" });
    await runTurn(chat("first", { provider: "anthropic-api" as never }));
    vi.setSystemTime(Date.now() + CONVERSATION_IDLE_MS + 1);
    await runTurn(chat("second", { provider: "anthropic-api" as never }));
    expect(run.mock.calls[1]?.[0].prompt).toBe("whole context, then second");
    run.mockResolvedValueOnce({ error: new Error("boom") });
    await runTurn(chat("third", { provider: "anthropic-api" as never })).catch(() => undefined);
    run.mockResolvedValueOnce({ text: "answer" });
    await runTurn(chat("fourth", { provider: "anthropic-api" as never }));
    expect(run.mock.calls[3]?.[0].sessionId).toBeUndefined();
  });

  it("stops the live process when the chat is left, after a turn still running, and keeps the stored session", async () => {
    run.mockResolvedValueOnce({ text: "answer" });
    await runTurn(chat("first"));
    endConversation("chat-1");
    expect(closeSession).toHaveBeenCalledWith("s-1", "claude");
    closeSession.mockReset();
    let release!: () => void;
    run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ text: "answer" });
        }),
    );
    const running = runTurn(chat("second", { session: stored("claude") }));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    endConversation("chat-1");
    expect(closeSession).not.toHaveBeenCalled();
    release();
    await running;
    expect(closeSession).toHaveBeenCalledWith("s-1", "claude");
    // The next turn resumes the session in a new process.
    run.mockResolvedValueOnce({ text: "answer" });
    await runTurn(chat("third", { session: stored("claude") }));
    expect(run.mock.calls[2]![0]).toMatchObject({ prompt: "third", sessionId: "s-1" });
  });

  it("records the tokens of a stopped turn when the tool reports them", async () => {
    const recorded: Array<{ provider: string; inputTokens: number; outputTokens?: number }> = [];
    const { setUsageRecorder } = await import("./usage");
    setUsageRecorder((usage) => recorded.push(usage));
    try {
      run.mockResolvedValueOnce({ text: "part", finishReason: "cancelled", usage: { inputTokens: 42_836, outputTokens: 20, cachedInputTokens: 0 } });
      await runTurn(chat("first", { provider: "codex" })).catch(() => undefined);
      // Claude Code reports no usage for a cancelled turn, so no row is made.
      run.mockResolvedValueOnce({ text: "part", finishReason: "cancelled" });
      await runTurn(chat("second", { provider: "claude" })).catch(() => undefined);
    } finally {
      setUsageRecorder(undefined);
    }
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ provider: "codex", inputTokens: 42_836, outputTokens: 20 });
  });

  it("reports a cancelled result as an abort, like a thrown cancellation", async () => {
    // Live Codex ends a stopped turn with a cancelled result instead of an error.
    run.mockResolvedValueOnce({ text: "part", finishReason: "cancelled" });
    const error = await runTurn(chat("first")).catch((err: unknown) => err);
    expect(isAbort(error)).toBe(true);
    run.mockResolvedValueOnce({ text: "", finishReason: "cancelled" });
    const oneShot = await runTurn({
      selection: { provider: "codex", model: "m" },
      prompt: "hi",
    }).catch((err: unknown) => err);
    expect(isAbort(oneShot)).toBe(true);
  });

  it("reports a turn stopped by its signal as an abort, even when the provider ends it normally", async () => {
    // A CLI killed on Stop can still report what it printed as a finished answer.
    const stop = new AbortController();
    run.mockImplementationOnce(async () => {
      stop.abort();
      return { text: "part", finishReason: "stop" };
    });
    const error = await runTurn({
      selection: { provider: "claude", model: "m" },
      prompt: "hi",
      signal: stop.signal,
    }).catch((err: unknown) => err);
    expect(isAbort(error)).toBe(true);
  });

  it("stops every live process when the app quits", () => {
    getFunnel();
    closeFunnel();
    expect(close).toHaveBeenCalled();
  });
});

describe("API keys", () => {
  it("rebuilds only the API provider whose key changed and keeps the CLI detection", async () => {
    getFunnel();
    const funnels = createFunnel.mock.calls.length;
    refresh.mockReset();
    setApiKeys({ anthropic: "a1" });
    expect(refresh.mock.calls).toEqual([["anthropic-api"]]);
    setApiKeys({ anthropic: "a1" });
    expect(refresh).toHaveBeenCalledTimes(1);
    setApiKeys({ anthropic: "a1", openai: "o1" });
    expect(refresh.mock.calls.at(-1)).toEqual(["openai-api"]);
    expect(createFunnel).toHaveBeenCalledTimes(funnels);
    // The stand-in reads the new key the next time the provider is used.
    getFunnel().providers["openai-api"].capabilities;
    expect(apiBuilds.mock.calls.at(-1)?.[0]).toEqual({
      anthropic: "a1",
      openai: "o1",
    });
  });

  it("starts API conversations over when a key changes, so no history reaches the new account", async () => {
    setApiKeys({ anthropic: "a1" });
    run.mockResolvedValue({ text: "answer" });
    const turn = (followUp: string) =>
      runTurn({
        selection: { provider: "anthropic-api", model: "m" },
        prompt: `whole context, then ${followUp}`,
        system: "tutor",
        conversation: { key: "chat-api", followUp },
      });
    await turn("first");
    setApiKeys({ anthropic: "a2" });
    await turn("second");
    const second = run.mock.calls.at(-1)![0];
    expect(second.sessionId).toBeUndefined();
    expect(second.prompt).toBe("whole context, then second");
    const options = created.options as {
      history: { get(id: string): unknown; set(id: string, value: unknown[]): void };
    };
    options.history.set("anthropic-api:old", ["earlier"]);
    setApiKeys({ anthropic: "a3" });
    expect(options.history.get("anthropic-api:old")).toBeUndefined();
  });

  it("lets an API provider skipped after a refused key back in when its key changes", async () => {
    const { benchEngine, isBenched } = await import("./bench");
    setApiKeys({ anthropic: "a1", openai: "o1" });
    benchEngine("openai-api", "signed-out");
    benchEngine("anthropic-api", "signed-out");
    setApiKeys({ anthropic: "a1", openai: "o2" });
    expect(isBenched("openai-api")).toBe(false);
    expect(isBenched("anthropic-api")).toBe(true);
  });
});

describe("schema repairs", () => {
  it("continue the session with only the error on Claude Code, and resend the prompt on Cursor Agent", async () => {
    const { generate } = await import("./generate");
    const { z } = await import("zod");
    for (const provider of ["claude", "agent"] as const) {
      run.mockReset();
      closeSession.mockReset();
      run
        .mockResolvedValueOnce({ text: "blue" })
        .mockResolvedValueOnce({ text: '{"colour":"blue"}' });
      const output = await generate({
        selection: { provider, model: "m" },
        prompt: "name a colour",
        schema: z.object({ colour: z.string() }),
      });
      expect(output.data).toEqual({ colour: "blue" });
      const repair = run.mock.calls[1]![0];
      if (provider === "claude") {
        expect(repair.sessionId).toBe("s-1");
        expect(repair.prompt).not.toContain("name a colour");
        expect(repair.prompt).toContain("blue");
        // The process the repair used stops once the answer is valid.
        expect(closeSession).toHaveBeenCalledWith("s-1", "claude");
      } else {
        expect(repair.sessionId).toBeUndefined();
        expect(repair.prompt).toContain("name a colour");
      }
    }
  });
});

describe("a Cursor Agent chat that Cursor no longer holds", () => {
  const recorded = JSON.parse(readFileSync("tests/fixtures/cursor-resume-unknown-id.json", "utf8")) as {
    requested: string;
    events: Array<{ session_id?: string }>;
  };
  const folder = () => mkdtempSync(join(tmpdir(), "pyxis-cursor-chats-"));
  const chatTurn = (id: string) => ({
    selection: { provider: "agent" as const, model: "m" },
    prompt: "whole context, then second",
    system: "tutor",
    conversation: { key: "chat-1", followUp: "second", session: { provider: "agent", id, cwd: "/scratch" } },
  });

  it("gives no sign in the stream: Cursor answers an unknown id as a new chat under the same id", () => {
    expect(new Set(recorded.events.map((event) => event.session_id))).toEqual(new Set([recorded.requested]));
  });

  it("is told from Cursor's chat folders: lost only when they hold other chats and not this one", () => {
    const root = folder();
    try {
      setCursorChatsRoot(root);
      // Nothing there, as with another layout: the chat counts as held.
      expect(cursorSessionLost("chat-a")).toBe(false);
      mkdirSync(join(root, "workspace-1", "chat-a"), { recursive: true });
      expect(cursorSessionLost("chat-a")).toBe(false);
      expect(cursorSessionLost("chat-b")).toBe(true);
      expect(cursorSessionLost("../chat-a")).toBe(false);
      setCursorChatsRoot(join(root, "missing"));
      expect(cursorSessionLost("chat-b")).toBe(false);
    } finally {
      setCursorChatsRoot(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not call a chat lost when the folder holds only files or empty workspaces", () => {
    const root = folder();
    try {
      setCursorChatsRoot(root);
      writeFileSync(join(root, "README"), "not a chat");
      expect(cursorSessionLost("chat-a")).toBe(false);
      mkdirSync(join(root, "workspace-1"), { recursive: true });
      expect(cursorSessionLost("chat-a")).toBe(false);
      mkdirSync(join(root, "workspace-1", "chat-b"));
      expect(cursorSessionLost("chat-a")).toBe(true);
    } finally {
      setCursorChatsRoot(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sends the whole prompt, with no session id, when Cursor lost the chat, and goes on in the chat it held", async () => {
    const root = folder();
    try {
      setCursorChatsRoot(root);
      mkdirSync(join(root, "workspace-1", "held-chat"), { recursive: true });
      run.mockResolvedValue({ text: "answer" });
      const lost = await runTurn(chatTurn("lost-chat"));
      expect(run.mock.calls[0]![0]).toMatchObject({ prompt: "whole context, then second" });
      expect(run.mock.calls[0]![0].sessionId).toBeUndefined();
      expect(lost.continued).toBe(false);
      const held = await runTurn(chatTurn("held-chat"));
      expect(run.mock.calls[1]![0]).toMatchObject({ prompt: "second", sessionId: "held-chat" });
      expect(held.continued).toBe(true);
    } finally {
      setCursorChatsRoot(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a Cursor Agent chat once seen in Cursor's folder", () => {
  const folder = () => mkdtempSync(join(tmpdir(), "pyxis-cursor-seen-"));
  const turn = (id: string, seen: boolean) => ({
    selection: { provider: "agent" as const, model: "m" },
    prompt: "whole context",
    conversation: { key: "chat-1", followUp: "second", session: { provider: "agent", id, cwd: "/scratch", seen } },
  });

  it("is lost when the folder is empty or gone and the chat was seen there, held when it never was", () => {
    const root = folder();
    try {
      setCursorChatsRoot(root);
      expect(cursorSessionLost("chat-a", false)).toBe(false);
      expect(cursorSessionLost("chat-a", true)).toBe(true);
      setCursorChatsRoot(join(root, "missing"));
      expect(cursorSessionLost("chat-a", true)).toBe(true);
      expect(cursorSessionLost("chat-a", false)).toBe(false);
      setCursorChatsRoot(root);
      mkdirSync(join(root, "workspace-1", "chat-a"), { recursive: true });
      expect(cursorSessionLost("chat-a", true)).toBe(false);
    } finally {
      setCursorChatsRoot(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports that the chat was seen after a turn that left it in the folder, and sends the whole prompt once it is gone", async () => {
    const root = folder();
    try {
      setCursorChatsRoot(root);
      mkdirSync(join(root, "workspace-1", "s-1"), { recursive: true });
      run.mockResolvedValue({ text: "answer" });
      const first = await runTurn({ ...turn("s-1", false), conversation: { key: "chat-1", followUp: "first", session: null } });
      expect(first).toMatchObject({ sessionId: "s-1", seen: true });
      // The student clears Cursor's history: nothing is left in its folder.
      rmSync(join(root, "workspace-1"), { recursive: true, force: true });
      const gone = await runTurn(turn("s-1", true));
      expect(run.mock.calls[1]![0]).toMatchObject({ prompt: "whole context" });
      expect(run.mock.calls[1]![0].sessionId).toBeUndefined();
      expect(gone.continued).toBe(false);
    } finally {
      setCursorChatsRoot(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runTurn in debug mode", () => {
  const job = "0190c8a2-0000-7000-8000-0000000000aa";
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pyxis-funnel-debug-"));
    setDebugLogRoot(root);
  });
  afterEach(() => {
    setDebugOn(false);
    setDebugLogRoot("");
    rmSync(root, { recursive: true, force: true });
  });

  it("logs a job's call with the engine's verbose events and its end, and asks cli-funnel for verbose", async () => {
    setDebugOn(true);
    run.mockResolvedValueOnce({ text: "risposta", usage: { inputTokens: 12, outputTokens: 3 } });
    await withUsageScope({ jobId: job, kind: "lesson" }, () =>
      runTurn({ selection: { provider: "claude", model: "sonnet" }, prompt: "Spiega il moto.", system: "Sei un tutor." }),
    );
    expect(run.mock.calls[0]?.[0].verbose).toBe(true);
    const log = await readJobLog(job);
    expect(log?.lines.map((line) => line.type)).toEqual(["call", "event", "end"]);
    expect(log?.lines[0]).toMatchObject({ provider: "claude", model: "sonnet", access: "subscription", kind: "lesson", prompt: "Spiega il moto.", system: "Sei un tutor." });
    expect(log?.lines[2]).toMatchObject({ text: "risposta", inputTokens: 12, outputTokens: 3, finishReason: "stop" });
  });

  it("logs a failed call with its error", async () => {
    setDebugOn(true);
    run.mockResolvedValueOnce({ error: new Error("limit reached") });
    await expect(
      withUsageScope({ jobId: job }, () => runTurn({ selection: { provider: "anthropic-api", model: "haiku" }, prompt: "x" })),
    ).rejects.toThrow("limit reached");
    const log = await readJobLog(job);
    expect(log?.lines[0]).toMatchObject({ access: "api-key" });
    expect(log?.lines.at(-1)).toMatchObject({ type: "end", error: "limit reached" });
  });

  it("logs nothing and keeps verbose off when debug mode is off or the call is outside a job", async () => {
    run.mockResolvedValue({ text: "ok" });
    await withUsageScope({ jobId: job }, () => runTurn({ selection: { provider: "claude", model: "m" }, prompt: "a" }));
    setDebugOn(true);
    await runTurn({ selection: { provider: "claude", model: "m" }, prompt: "b" });
    expect(run.mock.calls.map((call) => call[0].verbose)).toEqual([undefined, undefined]);
    expect(await readJobLog(job)).toBeNull();
  });
});
