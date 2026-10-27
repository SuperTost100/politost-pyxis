import { describe, expect, it } from "vitest";
import { FunnelError } from "./funnel";
import { IpcError } from "../../shared/ipc";
import { engineIpcError, translateEngineError } from "./errors";

describe("translateEngineError", () => {
  it("keeps funnel codes as message keys", () => {
    const err = new FunnelError("missing", "not-logged-in");
    expect(translateEngineError(err)).toEqual({
      code: "not-logged-in",
      messageKey: "engines.errors.not-logged-in",
    });
  });

  it("reads the code CLI Funnel puts on plain stream errors", () => {
    const err = Object.assign(new Error("Please run agent login"), {
      code: "not-logged-in",
    });
    expect(translateEngineError(err, "agent").code).toBe("not-logged-in");
  });

  it("names a stream that closed before the answer finished", () => {
    const err = Object.assign(
      new Error("Anthropic API closed the stream before the answer finished."),
      { code: "stream-truncated" },
    );
    const surfaced = engineIpcError(err, "anthropic-api");
    expect(surfaced).toBeInstanceOf(IpcError);
    expect(surfaced).toMatchObject({
      code: "stream-truncated",
      messageKey: "engines.errors.stream-truncated",
    });
  });

  it("treats a refused login on a CLI engine as a lapsed sign-in, not a bad key", () => {
    const err = new Error("Invalid API key · Please run /login");
    expect(translateEngineError(err, "claude").messageKey).toBe(
      "engines.errors.not-logged-in",
    );
    expect(translateEngineError(err, "anthropic-api").messageKey).toBe(
      "engines.errors.refused",
    );
  });

  it("turns a refused key and a quota error into their own keys", () => {
    expect(translateEngineError(new Error("HTTP 401")).messageKey).toBe(
      "engines.errors.refused",
    );
    expect(
      translateEngineError(new Error("usage limit reached")).messageKey,
    ).toBe("engines.errors.quota");
    expect(
      translateEngineError(
        Object.assign(new Error("spend limit"), { code: "429" }),
      ).messageKey,
    ).toBe("engines.errors.quota");
  });

  it("does not read digits in a stack trace, a port or a line number as an HTTP status", () => {
    const stderr =
      "Error: listen EADDRINUSE 127.0.0.1:4010\n    at Server.setupListenHandle (node:net:1817:16)\n    at /app/main.js:401:12\n    at worker 429 of 8429";
    expect(translateEngineError(new Error(stderr), "claude").code).toBe(
      "cli-failed",
    );
    expect(
      translateEngineError(new Error("Failed on line 429"), "codex").code,
    ).toBe("cli-failed");
  });

  it("still reads an HTTP status written the way the providers write it", () => {
    for (const text of [
      "Anthropic API returned 401.",
      "OpenAI 401: Incorrect API key",
      "request failed with status code 401",
      "401 Unauthorized",
    ])
      expect(translateEngineError(new Error(text)).code).toBe("refused");
    for (const text of [
      "OpenAI 429: Too many requests",
      "Gemini API returned 429.",
      "HTTP 429",
      "rate_limit_exceeded",
      "insufficient_quota",
    ])
      expect(translateEngineError(new Error(text)).code).toBe("quota");
  });

  it("names a model the subscription does not include", () => {
    for (const message of [
      "Claude Sonnet 5.5 is not included in your weekly usage Buy credits or switch to a Grok model to continue.",
      "This model is not included in your plan. Upgrade your plan to use it.",
    ])
      expect(translateEngineError(new Error(message), "agent")).toEqual({
        code: "model-not-included",
        messageKey: "engines.errors.model-not-included",
      });
    // Credits that ran out stop every model on the account, so they are a usage limit, not one refused model.
    for (const message of ["You are out of credits.", "Insufficient credits. Buy more credits to continue."])
      expect(translateEngineError(new Error(message), "agent").code).toBe("quota");
    // Ordinary words around a plan or credits are not a refusal.
    expect(
      translateEngineError(new Error("Credits: the plan was included in the lesson"), "agent").code,
    ).toBe("cli-failed");
  });

  it("trusts the limit CLI Funnel attached before any text", () => {
    const limit = { kind: "quota", detail: "Weekly limit reached" };
    expect(
      translateEngineError(
        Object.assign(new Error("exited with code 1"), {
          code: "cli-failed",
          limit,
        }),
        "claude",
      ),
    ).toEqual({ code: "quota", messageKey: "engines.errors.quota" });
    // A limit wins over the words around it, such as an authentication mention.
    expect(
      translateEngineError(
        Object.assign(new Error("authentication ok, but out of credits"), {
          limit,
        }),
        "codex",
      ).code,
    ).toBe("quota");
  });
});
