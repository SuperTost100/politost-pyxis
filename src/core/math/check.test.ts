import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkClaim } from "./check";
import { toolHandlers } from "./handlers";

describe("checkClaim", () => {
  it("verifies the derivative of x^2 sin x and rejects a wrong claim", () => {
    expect(
      checkClaim({
        kind: "derivative",
        expr: "x**2*sin(x)",
        claimed: "2*x*sin(x)+x**2*cos(x)",
      }),
    ).toBe("verified");
    expect(
      checkClaim({
        kind: "derivative",
        expr: "x**2*sin(x)",
        claimed: "x",
      }),
    ).toBe("failed");
  });

  it("writes a staged whiteboard png", () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const staged = toolHandlers().stagePng({ dataUrl: png });
    expect(existsSync(staged.path)).toBe(true);
    expect(readFileSync(staged.path)[0]).toBe(0x89);
    const again = toolHandlers().stagePng({ dataUrl: png });
    expect(again.path).not.toBe(staged.path);
    expect(() => toolHandlers().stagePng({ dataUrl: "data:image/png;base64,iQAAAAAAAAA=" })).toThrow(
      /png-invalid/,
    );
    expect(() => toolHandlers().stagePng({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" })).toThrow(
      /png-invalid/,
    );
  });
});
