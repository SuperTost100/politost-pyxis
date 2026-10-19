import { describe, expect, it } from "vitest";
import { errorDetails } from "./errorDetails";

describe("errorDetails", () => {
  it("reads the detail of a core error body, then its code", () => {
    const body = {
      code: "engine-missing",
      messageKey: "x",
      params: {},
      detail: "no engine",
    };
    expect(errorDetails(body)).toBe("no engine");
    expect(errorDetails({ ...body, detail: "" })).toBe("engine-missing");
  });
  it("skips the generic internal code", () => {
    expect(
      errorDetails({
        code: "internal",
        messageKey: "errors.internal",
        params: {},
        detail: "",
      }),
    ).toBeUndefined();
  });
  it("reads an Error and a string, and ignores anything else", () => {
    expect(errorDetails(new Error("404 Not Found"))).toBe("404 Not Found");
    expect(errorDetails(" boom ")).toBe("boom");
    expect(errorDetails(null)).toBeUndefined();
    expect(errorDetails(new Error(" "))).toBeUndefined();
  });
});
