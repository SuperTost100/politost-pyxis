import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { engineHandlers } from "./handlers";
import { selectionFor } from "./selection";
import { getFunnel, runTurn } from "./funnel";
vi.mock("./funnel", async (original) => {
  const actual = await original<typeof import("./funnel")>();
  return { ...actual, getFunnel: vi.fn(actual.getFunnel), runTurn: vi.fn() };
});

describe("clearFeature", () => {
  it("drops a chat choice so the default engine is used again", () => {
    const db = openDatabase(":memory:");
    const engines = engineHandlers(db, () => undefined);
    engines.setFeature({
      feature: "default",
      provider: "claude",
      model: "chosen",
    });
    engines.setFeature({
      feature: "chat",
      provider: "openai-api",
      model: "gpt-test",
    });
    expect(selectionFor(db, "chat").provider).toBe("openai-api");
    engines.clearFeature({ feature: "chat" });
    expect(selectionFor(db, "chat").provider).toBe("claude");
  });
});

describe("confirmed default engine", () => {
  it("routes all unconfigured features to the first successfully tested provider", async () => {
    const db = openDatabase(":memory:");
    vi.mocked(runTurn).mockResolvedValueOnce({
      text: "ok",
      model: "gpt-test",
      provider: "codex",
      inputTokens: 2,
    });
    await engineHandlers(db, () => undefined).test({
      provider: "codex",
      model: "gpt-test",
    });
    for (const feature of ["plan", "lesson", "map", "grading"])
      expect(selectionFor(db, feature)).toEqual({
        provider: "codex",
        model: "gpt-test",
      });
    db.close();
  });
  it("preserves an existing default and never selects a failed provider", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    vi.mocked(runTurn).mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      handlers.test({ provider: "codex", model: "gpt-test" }),
    ).rejects.toThrow();
    expect(handlers.features().default).toBeUndefined();
    handlers.setFeature({
      feature: "default",
      provider: "openai-api",
      model: "chosen",
    });
    vi.mocked(runTurn).mockResolvedValueOnce({
      text: "ok",
      model: "gpt-test",
      provider: "codex",
      inputTokens: 2,
    });
    await handlers.test({ provider: "codex", model: "gpt-test" });
    expect(selectionFor(db, "plan")).toEqual({
      provider: "openai-api",
      model: "chosen",
    });
    db.close();
  });
});

describe("engine test deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("gives up on a turn that never answers and reports a timeout", async () => {
    vi.useFakeTimers();
    const db = openDatabase(":memory:");
    let seen: AbortSignal | undefined;
    vi.mocked(runTurn).mockImplementationOnce(
      (input) =>
        new Promise((_, reject) => {
          seen = input.signal;
          input.signal?.addEventListener("abort", () =>
            reject(new DOMException("Engine turn cancelled", "AbortError")),
          );
        }),
    );
    const handlers = engineHandlers(db, () => undefined);
    const result = handlers.test({ provider: "codex", model: "gpt-test" });
    const failure = expect(result).rejects.toMatchObject({
      code: "timeout",
      messageKey: "engines.errors.timeout",
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await failure;
    expect(seen?.aborted).toBe(true);
    expect(handlers.features().default).toBeUndefined();
    db.close();
  });

  it("stops the turn when the student closes the dialog, and says nothing about a timeout", async () => {
    const db = openDatabase(":memory:");
    vi.mocked(runTurn).mockImplementationOnce(
      (input) =>
        new Promise((_, reject) => {
          input.signal?.addEventListener("abort", () =>
            reject(new DOMException("Engine turn cancelled", "AbortError")),
          );
        }),
    );
    const controller = new AbortController();
    const result = engineHandlers(db, () => undefined).test(
      { provider: "codex", model: "gpt-test" },
      controller.signal,
    );
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    db.close();
  });
});

describe("engine configuration removal", () => {
  it("removes the default and overrides pointing to a removed provider only", () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    handlers.setFeature({
      feature: "default",
      provider: "anthropic-api",
      model: "a",
    });
    handlers.setFeature({
      feature: "chat",
      provider: "anthropic-api",
      model: "b",
    });
    handlers.setFeature({ feature: "map", provider: "codex", model: "c" });
    handlers.remove({ provider: "anthropic-api" });
    expect(handlers.features()).toEqual({
      map: { provider: "codex", model: "c" },
    });
    expect(() => selectionFor(db, "chat")).toThrow();
    db.close();
  });
  it("preserves supported effort and fast choices in stored selections and engine tests", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    handlers.setFeature({
      feature: "default",
      provider: "codex",
      model: "test",
      effort: "high",
      fast: true,
    });
    expect(selectionFor(db, "plan")).toEqual({
      provider: "codex",
      model: "test",
      effort: "high",
      fast: true,
    });
    vi.mocked(runTurn).mockResolvedValueOnce({
      text: "ok",
      model: "test",
      provider: "codex",
      inputTokens: 2,
    });
    await handlers.test({
      provider: "codex",
      model: "test",
      effort: "high",
      fast: true,
    });
    expect(vi.mocked(runTurn).mock.calls.at(-1)?.[0].selection).toMatchObject({
      provider: "codex",
      model: "test",
      effort: "high",
      fast: true,
    });
    db.close();
  });
  it("refuses provider options that CLI Funnel cannot support", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      engineHandlers(db, () => undefined).setFeature({
        feature: "default",
        provider: "claude",
        model: "test",
        fast: true,
      }),
    ).toThrow();
    expect(
      db.prepare("SELECT count(*) AS count FROM feature_engines").get(),
    ).toEqual({ count: 0 });
    db.close();
  });
});

describe("engine status and login recovery", () => {
  it("does not present a refused API key as a signed-in engine", async () => {
    const db = openDatabase(":memory:");
    const fake = {
      overview: async () => [
        {
          id: "anthropic-api",
          displayName: "Anthropic",
          installation: { installed: true },
          auth: { loggedIn: true },
          capabilities: { effort: false, fast: false },
        },
      ],
      models: async () => {
        throw new Error("refused");
      },
    } as unknown as ReturnType<typeof getFunnel>;
    vi.mocked(getFunnel).mockReturnValueOnce(fake).mockReturnValueOnce(fake);
    const rows = await engineHandlers(db, () => undefined).overview();
    expect(rows[0]).toMatchObject({ id: "anthropic-api", loggedIn: false });
    db.close();
  });
  it("shares one provider scan between callers that ask while it runs", async () => {
    const db = openDatabase(":memory:");
    let scans = 0;
    let finish!: () => void;
    const fake = {
      overview: async () => {
        scans += 1;
        await new Promise<void>((resolve) => (finish = resolve));
        return [
          {
            id: "claude",
            displayName: "Claude Code",
            installation: { installed: true },
            auth: { loggedIn: true },
            capabilities: { effort: true, fast: false, access: ["none"] },
          },
        ];
      },
    } as unknown as ReturnType<typeof getFunnel>;
    const real = vi.mocked(getFunnel).getMockImplementation()!;
    vi.mocked(getFunnel).mockImplementation(() => fake);
    try {
      const handlers = engineHandlers(db, () => undefined);
      const launch = handlers.overview();
      const screen = handlers.overview();
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      finish();
      expect(await launch).toEqual(await screen);
      expect(scans).toBe(1);
      // A later call scans again.
      const later = handlers.overview();
      await vi.waitFor(() => expect(scans).toBe(2));
      finish();
      await later;
    } finally {
      vi.mocked(getFunnel).mockImplementation(real);
      db.close();
    }
  });
  it("reports a failed background login without an unhandled rejection or stale code session", async () => {
    const db = openDatabase(":memory:");
    const emit = vi.fn();
    const session = {
      cancel: vi.fn(),
      sendCode: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield { type: "open-url", url: "https://example.com" };
        throw new Error("fixture failure");
      },
    };
    const fake = {
      providers: { claude: { capabilities: { access: ["none"] } } },
      login: () => session,
    } as unknown as ReturnType<typeof getFunnel>;
    vi.mocked(getFunnel).mockReturnValueOnce(fake).mockReturnValueOnce(fake);
    const handlers = engineHandlers(db, emit);
    await handlers.login({ provider: "claude" });
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith({ provider: "claude", type: "error" }),
    );
    expect(() =>
      handlers.sendCode({ provider: "claude", code: "fixture" }),
    ).toThrow();
    db.close();
  });
});

describe("cancelled sign-in", () => {
  const real = vi.mocked(getFunnel).getMockImplementation()!;
  afterEach(() => vi.mocked(getFunnel).mockImplementation(real));
  /** A session that waits for its first event until it is cancelled, as a CLI does before it prints the sign-in page. */
  function waiting() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return {
      cancel: vi.fn(() => release()),
      sendCode: vi.fn(),
      async *[Symbol.asyncIterator]() {
        await gate;
      },
    };
  }
  const funnelWith = (login: () => unknown) =>
    ({
      providers: { claude: { capabilities: { access: ["none"] } } },
      login,
    }) as unknown as ReturnType<typeof getFunnel>;

  it("reports a cancel before the first event as cancelled, not as a failure", async () => {
    const db = openDatabase(":memory:");
    const session = waiting();
    vi.mocked(getFunnel).mockImplementation(() => funnelWith(() => session));
    const handlers = engineHandlers(db, () => undefined);
    const attempt = handlers.login({ provider: "claude" });
    handlers.cancelLogin({ provider: "claude" });
    await expect(attempt).resolves.toEqual({
      provider: "claude",
      type: "cancelled",
    });
    db.close();
  });

  it("lets a restarted sign-in stand when the cancelled one finishes late", async () => {
    const db = openDatabase(":memory:");
    const first = waiting();
    const second = {
      cancel: vi.fn(),
      sendCode: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield { type: "open-url", url: "https://example.com/login" };
        await new Promise(() => undefined);
      },
    };
    const sessions = [first, second];
    vi.mocked(getFunnel).mockImplementation(() =>
      funnelWith(() => sessions.shift()),
    );
    const handlers = engineHandlers(db, () => undefined);
    const stale = handlers.login({ provider: "claude" });
    handlers.cancelLogin({ provider: "claude" });
    const fresh = handlers.login({ provider: "claude" });
    await expect(stale).resolves.toMatchObject({ type: "cancelled" });
    await expect(fresh).resolves.toMatchObject({ type: "open-url" });
    // The newer session is still the one a pasted code reaches.
    handlers.sendCode({ provider: "claude", code: "abc" });
    expect(second.sendCode).toHaveBeenCalledWith("abc");
    db.close();
  });
});

describe("text-only engines", () => {
  const row = (id: string, access: string[]) => ({
    id,
    displayName: id,
    installation: { installed: true },
    auth: { loggedIn: true },
    capabilities: { effort: false, fast: false, access },
  });

  it("enables Cursor Agent and Antigravity through the bundled CLI Funnel", () => {
    const { providers } = getFunnel();
    expect(providers.agent.capabilities.access).toContain("none");
    expect(providers.antigravity.capabilities.access).toContain("none");
    const db = openDatabase(":memory:");
    engineHandlers(db, () => undefined).setFeature({
      feature: "default",
      provider: "antigravity",
      model: "test",
    });
    expect(selectionFor(db, "plan").provider).toBe("antigravity");
    db.close();
  });

  it("offers no sign-out for Antigravity and explains why instead of failing", async () => {
    const db = openDatabase(":memory:");
    const fake = {
      overview: async () => [
        row("agent", ["none"]),
        row("antigravity", ["none"]),
      ],
      providers: { antigravity: { capabilities: { access: ["none"] } } },
    } as unknown as ReturnType<typeof getFunnel>;
    const real = vi.mocked(getFunnel).getMockImplementation()!;
    vi.mocked(getFunnel).mockImplementation(() => fake);
    try {
      const handlers = engineHandlers(db, () => undefined);
      expect(
        (await handlers.overview()).map(({ id, capabilities }) => [
          id,
          capabilities.signOut,
        ]),
      ).toEqual([
        ["agent", true],
        ["antigravity", false],
      ]);
      await expect(
        handlers.logout({ provider: "antigravity" }),
      ).rejects.toMatchObject({
        code: "unsupported",
        messageKey: "engines.signOutUnsupported",
      });
    } finally {
      vi.mocked(getFunnel).mockImplementation(real);
      db.close();
    }
  });

  it("disables a CLI whose adapter cannot enforce text-only access and hides unsupported providers", async () => {
    const db = openDatabase(":memory:");
    const fake = {
      overview: async () => [
        row("agent", ["none", "auto", "full"]),
        row("antigravity", ["accept-edits", "full"]),
        row("ollama", []),
      ],
      providers: { antigravity: { capabilities: { access: ["full"] } } },
    } as unknown as ReturnType<typeof getFunnel>;
    const real = vi.mocked(getFunnel).getMockImplementation()!;
    vi.mocked(getFunnel).mockImplementation(() => fake);
    try {
      const handlers = engineHandlers(db, () => undefined);
      expect(
        (await handlers.overview()).map(({ id, disabled }) => [id, disabled]),
      ).toEqual([
        ["agent", false],
        ["antigravity", true],
      ]);
      await expect(
        handlers.test({ provider: "antigravity", model: "test" }),
      ).rejects.toThrow();
      expect(() =>
        handlers.setFeature({
          feature: "default",
          provider: "antigravity",
          model: "test",
        }),
      ).toThrow();
      await expect(
        handlers.login({ provider: "antigravity" }),
      ).rejects.toThrow();
      expect(runTurn).not.toHaveBeenCalledWith(
        expect.objectContaining({
          selection: expect.objectContaining({ provider: "antigravity" }),
        }),
      );
    } finally {
      vi.mocked(getFunnel).mockImplementation(real);
      db.close();
    }
  });
});
