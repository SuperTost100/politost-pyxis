import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkClaim } from "./check";
import { receiveRuntimeReply, setRuntimeSender } from "./runtime-client";
import { toolHandlers } from "./handlers";

describe("checkClaim", () => {
  it("validates and forwards symbolic claims through asynchronous runtime transport", async () => {
    const requests: Array<{
      id: string;
      operation: string;
      payload: { claimed: string };
    }> = [];
    setRuntimeSender((message) => {
      const request = message as {
        id: string;
        operation: string;
        payload: { claimed: string };
      };
      requests.push(request);
      receiveRuntimeReply({
        id: request.id,
        result: {
          state: request.payload.claimed === "x" ? "failed" : "verified",
          reason: "symbolic",
        },
      });
    });
    const correct = {
      kind: "derivative" as const,
      expr: "x**2*sin(x)",
      claimed: "2*x*sin(x)+x**2*cos(x)",
      vars: ["x"],
    };
    expect(await checkClaim(correct)).toEqual({
      state: "verified",
      reason: "symbolic",
    });
    expect(await checkClaim({ ...correct, claimed: "x" })).toEqual({
      state: "failed",
      reason: "symbolic",
    });
    expect(requests[0]).toMatchObject({ operation: "check", payload: correct });
    const before = requests.length;
    expect(await checkClaim({ ...correct, expr: "" })).toEqual({
      state: "none",
      reason: "unsupported-expression",
    });
    expect(requests).toHaveLength(before);
  });
  it("reports unavailable verification as not checkable", async () => {
    setRuntimeSender((message) =>
      receiveRuntimeReply({
        id: (message as { id: string }).id,
        error: "runtime-unavailable",
      }),
    );
    expect(
      await checkClaim({ kind: "equal", expr: "x", claimed: "x" }),
    ).toEqual({ state: "none", reason: "runtime-unavailable" });
  });

  it("writes a staged whiteboard png", () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const staged = toolHandlers().stagePng({ dataUrl: png });
    expect(existsSync(staged.path)).toBe(true);
    expect(readFileSync(staged.path)[0]).toBe(0x89);
    const again = toolHandlers().stagePng({ dataUrl: png });
    expect(again.path).not.toBe(staged.path);
    expect(() =>
      toolHandlers().stagePng({
        dataUrl: "data:image/png;base64,iQAAAAAAAAA=",
      }),
    ).toThrow(/png-invalid/);
    expect(() =>
      toolHandlers().stagePng({
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      }),
    ).toThrow(/png-invalid/);
  });
});
