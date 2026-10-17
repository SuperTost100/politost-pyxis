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
    expect(translateEngineError(new Error("usage limit reached")).messageKey).toBe(
      "engines.errors.quota",
    );
    expect(translateEngineError(Object.assign(new Error("spend limit"), { code: "429" })).messageKey).toBe(
      "engines.errors.quota",
    );
  });
});
