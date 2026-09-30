import { describe, expect, it } from "vitest";
import { FunnelError } from "./funnel";
import { translateEngineError } from "./errors";

describe("translateEngineError", () => {
  it("keeps funnel codes as message keys", () => {
    const err = new FunnelError("missing", "not-logged-in");
    expect(translateEngineError(err)).toEqual({
      code: "not-logged-in",
      messageKey: "engines.errors.not-logged-in",
    });
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
