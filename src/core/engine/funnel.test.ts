import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAbort } from "../../shared/ipc";

type Request = {
  selection: { provider: string; model: string };
  prompt: string;
  sessionId?: string;
  cache?: boolean;
  signal?: AbortSignal;
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
  setApiKeys,
  setScratch,
  CONVERSATION_IDLE_MS,
} = await import("./funnel");

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
  const chat = (followUp: string, provider = "claude" as const, system = "tutor") => ({
    selection: { provider, model: "m" },
    prompt: `whole context, then ${followUp}`,
    system,
    conversation: { key: "chat-1", followUp },
  });

  it("sends the whole context once, then only the new question in the same session", async () => {
    run.mockResolvedValue({ text: "answer" });
    await runTurn(chat("first"));
    await runTurn(chat("second"));
    const [one, two] = run.mock.calls.map(([request]) => request);
    expect(one?.prompt).toBe("whole context, then first");
    expect(one?.sessionId).toBeUndefined();
    expect(two?.prompt).toBe("second");
    expect(two?.sessionId).toBe("s-1");
    // The chat's process stays up between questions.
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("keeps an API conversation as history, so the cached start stays the same", async () => {
    run.mockResolvedValue({ text: "answer" });
    await runTurn({ ...chat("first", "anthropic-api" as never), cache: true });
    await runTurn({ ...chat("second", "anthropic-api" as never), cache: true });
    const two = run.mock.calls[1]?.[0];
    expect(two).toMatchObject({ prompt: "second", sessionId: "s-1", cache: true });
  });

  it("gives Cursor Agent and Antigravity the whole prompt every time", async () => {
    run.mockResolvedValue({ text: "answer" });
    await runTurn(chat("first", "agent" as never));
    await runTurn(chat("second", "agent" as never));
    const two = run.mock.calls[1]?.[0];
    expect(two?.prompt).toBe("whole context, then second");
    expect(two?.sessionId).toBeUndefined();
  });

  it("starts over on another engine or system prompt, and stops the old process", async () => {
    run.mockResolvedValue({ text: "answer" });
    await runTurn(chat("first"));
    await runTurn(chat("second", "codex" as never));
    expect(closeSession).toHaveBeenCalledWith("s-1", "claude");
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      prompt: "whole context, then second",
    });
    await runTurn(chat("third", "codex" as never, "socratic tutor"));
    expect(closeSession).toHaveBeenCalledWith("s-2", "codex");
    expect(run.mock.calls[2]?.[0].sessionId).toBeUndefined();
  });

  it("starts over after ten idle minutes", async () => {
    vi.useFakeTimers();
    run.mockResolvedValue({ text: "answer" });
    await runTurn(chat("first"));
    vi.setSystemTime(Date.now() + CONVERSATION_IDLE_MS + 1);
    await runTurn(chat("second"));
    expect(run.mock.calls[1]?.[0].prompt).toBe("whole context, then second");
    expect(closeSession).toHaveBeenCalledWith("s-1", "claude");
  });

  it("ends after a stopped or failed turn", async () => {
    run.mockResolvedValueOnce({ text: "part", finishReason: "cancelled" });
    await runTurn(chat("first")).catch(() => undefined);
    expect(closeSession).toHaveBeenCalledWith("s-1", "claude");
    run.mockResolvedValueOnce({ text: "answer" });
    await runTurn(chat("second"));
    expect(run.mock.calls[1]?.[0].sessionId).toBeUndefined();
    run.mockResolvedValueOnce({ error: new Error("boom") });
    await runTurn(chat("third")).catch(() => undefined);
    expect(closeSession).toHaveBeenCalledWith("s-2", "claude");
  });

  it("stops the process when the chat is left, after a turn still running", async () => {
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
    const running = runTurn(chat("second"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    endConversation("chat-1");
    expect(closeSession).not.toHaveBeenCalled();
    release();
    await running;
    expect(closeSession).toHaveBeenCalledWith("s-2", "claude");
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

  it("starts over after a turn ran beside the chat's session, so the next question sees that exchange", async () => {
    run.mockResolvedValueOnce({ text: "answer" });
    await runTurn(chat("first"));
    let release!: () => void;
    run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ text: "slow answer" });
        }),
    );
    const slow = runTurn(chat("second"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    // A second question while the first still runs goes outside the session.
    run.mockResolvedValueOnce({ text: "beside" });
    await runTurn(chat("overlap"));
    release();
    await slow;
    run.mockResolvedValueOnce({ text: "answer" });
    await runTurn(chat("next"));
    const next = run.mock.calls[3]![0];
    expect(next.sessionId).toBeUndefined();
    expect(next.prompt).toBe("whole context, then next");
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
