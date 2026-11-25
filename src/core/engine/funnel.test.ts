import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAbort } from "../../shared/ipc";

type Request = {
  selection: { provider: string; model: string };
  prompt: string;
  sessionId?: string;
  persist?: false;
  workspaceName?: string;
  cache?: boolean;
  signal?: AbortSignal;
  verbose?: boolean;
  mcpServers?: Record<string, unknown>;
};
type Outcome = {
  /** Events the tool reports after it names its session, before it fails or writes. */
  events?: unknown[];
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
  const caps = (cache: boolean, ephemeral?: true) => ({ access: ["none"], cache, ephemeral });
  return {
    providers: {
      claude: { capabilities: { ...caps(false, true), mcpServersAtNone: ["http"] }, openSession: () => undefined },
      codex: { capabilities: { ...caps(false, true), mcpServersAtNone: ["http"] }, openSession: () => undefined },
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
          for (const event of outcome.events ?? []) yield event;
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
      capabilities: { access: [], cache, effort: true, ephemeral: true },
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
  setApiKeys,
  setScratch,
  toolsAttach,
  CONVERSATION_IDLE_MS,
} = await import("./funnel");

const { readJobLog, setDebugLogRoot, setDebugOn } = await import("../debug/log");
const { withUsageScope } = await import("./usage");
const { activityOf } = await import("../jobs/activity");
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

beforeEach(() => {
  run.mockReset();
  closeSession.mockReset();
  setScratch("/scratch");
});

afterEach(() => {
  closeFunnel();
  vi.useRealTimers();
});

describe("runTurn", () => {
  it.each(["antigravity", "claude"] as const)(
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

  it("hands the schema to every tool as it is, Antigravity included, which asks for it in the prompt itself", async () => {
    run.mockResolvedValue({ text: '{"score":0.4,"explanation":"Manca il fattore $2x$."}' });
    const schema = { type: "object", properties: { score: { type: "number" } }, required: ["score"] };
    for (const provider of ["antigravity", "claude"] as const) {
      const result = await runTurn({
        selection: { provider, model: "m" },
        prompt: "Grade this.",
        responseSchema: { name: "response", schema },
      });
      const sent = run.mock.calls.at(-1)![0] as Request & { responseSchema?: unknown };
      expect(sent.prompt, provider).toBe("Grade this.");
      expect(sent.responseSchema, provider).toEqual({ name: "response", schema });
      expect(result.text).toBe('{"score":0.4,"explanation":"Manca il fattore $2x$."}');
    }
  });

  it("asks the tool not to keep a call that is not part of a conversation, where the tool can do that", async () => {
    run.mockResolvedValue({ text: "ok" });
    const ephemeral = new Map<string, unknown>();
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      await runTurn({ selection: { provider, model: "m" }, prompt: "hi" });
      ephemeral.set(provider, run.mock.calls.at(-1)![0].persist);
    }
    // Antigravity cannot skip saving, and cli-funnel refuses the run when asked to.
    expect(Object.fromEntries(ephemeral)).toEqual({ claude: false, codex: false, antigravity: undefined });
    // A call that is part of a conversation is kept, since the next turn resumes it.
    await runTurn({
      selection: { provider: "claude", model: "m" },
      prompt: "whole",
      conversation: { key: "lesson:t1", followUp: "next", session: null },
    });
    expect(run.mock.calls.at(-1)![0].persist).toBeUndefined();
  });

  it("gives every call Pyxis's own folder name, so its chats stay apart in the tool's history", async () => {
    run.mockResolvedValue({ text: "ok" });
    await runTurn({ selection: { provider: "antigravity", model: "m" }, prompt: "hi" });
    expect(run.mock.calls[0]![0].workspaceName).toBe("pyxis");
  });

  it("keeps a conversation that only a subscription tool holds off an API or local provider", async () => {
    run.mockResolvedValue({ text: "ok" });
    const call = (provider: "anthropic-api" | "claude") => ({
      selection: { provider, model: "m" },
      prompt: "whole",
      conversation: { key: "lesson:t1", followUp: "next", session: null, cliOnly: true as const },
    });
    await runTurn(call("anthropic-api"));
    await runTurn(call("anthropic-api"));
    // The API provider answers each call on its own: nothing continues, and the call is not kept either.
    expect(run.mock.calls.map(([request]) => [request.prompt, request.sessionId, request.persist])).toEqual([
      ["whole", undefined, false],
      ["whole", undefined, false],
    ]);
    await runTurn(call("claude"));
    expect(run.mock.calls.at(-1)![0].persist).toBeUndefined();
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
      runTurn({ selection: { provider: "antigravity", model: "m" }, prompt: "hi" }),
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
  type Provider = "claude" | "codex" | "antigravity";
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

  it.each(["claude", "codex", "antigravity"] as const)(
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

  it("sends the system prompt on every turn, in a new session and in one the tool holds, on every tool", async () => {
    run.mockResolvedValue({ text: "answer" });
    for (const provider of ["antigravity", "claude", "codex"] as const) {
      await runTurn(chat("next", { provider, session: stored(provider) }));
      await runTurn(chat("first", { provider }));
    }
    const systems = run.mock.calls.map(([request]) => (request as { system?: string }).system);
    // Continued, then new, for each provider in turn. A resumed Antigravity session gets the system prompt in its system
    // slot, as Claude Code and Codex do.
    expect(systems).toEqual(["tutor", "tutor", "tutor", "tutor", "tutor", "tutor"]);
  });

  it("goes on in the session it tracked for a caller that stores none, such as a lesson's tool rounds", async () => {
    run.mockResolvedValue({ text: "answer" });
    for (const provider of ["claude", "antigravity"] as const) {
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

describe("Pyxis's tools in a run", () => {
  const tools = { url: "http://127.0.0.1:1/mcp", token: "t".repeat(43) };
  const refused = () => Object.assign(new Error("A server named pyxis_tools is already in your config"), { code: "invalid-selection" });

  it("runs again without the tools when they are refused, and offers them to that tool no more", async () => {
    run.mockResolvedValueOnce({ error: refused() }).mockResolvedValue({ text: "ok" });
    const first = await runTurn({ selection: { provider: "codex", model: "m" }, prompt: "uno", tools });
    expect(run.mock.calls.map((call) => Boolean(call[0].mcpServers))).toEqual([true, false]);
    expect(first.tools).toBeUndefined();
    expect(toolsAttach("codex")).toBe(false);
    // The next question makes no doomed first attempt, and another tool still gets them.
    await runTurn({ selection: { provider: "codex", model: "m" }, prompt: "due", tools });
    expect(run.mock.calls.map((call) => Boolean(call[0].mcpServers))).toEqual([true, false, false]);
    expect(toolsAttach("claude")).toBe(true);
    const other = await runTurn({ selection: { provider: "claude", model: "m" }, prompt: "tre", tools });
    expect(other.tools).toBe(true);
  });

  it("does not run again without the tools once a call reached Pyxis's server, whatever the failure says", async () => {
    run.mockResolvedValueOnce({
      events: [{ type: "tool.start", id: "c1", name: "mcp__pyxis_tools__create_flashcards", mcp: { server: "pyxis_tools", tool: "create_flashcards" } }],
      error: new Error("mcp transport closed"),
    });
    await expect(runTurn({ selection: { provider: "claude", model: "m" }, prompt: "uno", tools })).rejects.toThrow("mcp transport closed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(toolsAttach("claude")).toBe(true);
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
  it("resend the whole prompt with the bad answer, in a call the tool does not keep", async () => {
    const { generate } = await import("./generate");
    const { z } = await import("zod");
    for (const provider of ["claude", "antigravity"] as const) {
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
      // A call the tool does not keep cannot be resumed, so the repair is a call of its own with the whole prompt.
      const repair = run.mock.calls[1]![0];
      expect(repair.sessionId, provider).toBeUndefined();
      expect(repair.prompt, provider).toContain("name a colour");
      expect(repair.prompt, provider).toContain("blue");
      expect(repair.persist, provider).toBe(provider === "claude" ? false : undefined);
    }
  });

  it("continue the session of a conversation they belong to, with only the error", async () => {
    const { generate } = await import("./generate");
    const { z } = await import("zod");
    run
      .mockResolvedValueOnce({ text: "blue" })
      .mockResolvedValueOnce({ text: '{"colour":"blue"}' });
    const output = await generate({
      selection: { provider: "claude", model: "m" },
      prompt: "name a colour",
      followUpFor: () => "name a colour, again",
      schema: z.object({ colour: z.string() }),
      conversation: { key: "lesson:t1", followUp: "", session: null },
    });
    expect(output.data).toEqual({ colour: "blue" });
    const repair = run.mock.calls[1]![0];
    expect(repair.sessionId).toBe("s-1");
    expect(repair.prompt).not.toContain("name a colour");
    expect(repair.prompt).toContain("blue");
    expect(repair.persist).toBeUndefined();
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

describe("runTurn and the job's activity", () => {
  const job = "0190c8a2-0000-7000-8000-0000000000bb";

  it("makes the call the job's current one while the engine works, and clears it when the call ends", async () => {
    let during: unknown;
    run.mockImplementationOnce(() => {
      during = activityOf(job);
      return { text: "risposta" };
    });
    await withUsageScope({ jobId: job }, () => runTurn({ selection: { provider: "claude", model: "m" }, prompt: "a" }));
    expect(during).toMatchObject({ phase: "starting" });
    expect(activityOf(job)).toBeNull();
  });

  it("clears it when the call fails, and tracks nothing outside a job", async () => {
    run.mockImplementationOnce(() => ({ error: new Error("offline") }));
    await expect(
      withUsageScope({ jobId: job }, () => runTurn({ selection: { provider: "claude", model: "m" }, prompt: "a" })),
    ).rejects.toThrow("offline");
    expect(activityOf(job)).toBeNull();
    let outside: unknown = "unset";
    run.mockImplementationOnce(() => {
      outside = activityOf(undefined);
      return { text: "ok" };
    });
    await runTurn({ selection: { provider: "claude", model: "m" }, prompt: "b" });
    expect(outside).toBeNull();
  });
});
