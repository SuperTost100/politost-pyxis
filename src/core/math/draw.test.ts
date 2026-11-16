import { beforeEach, expect, it, vi } from "vitest";

const reply = vi.hoisted(() => ({ value: undefined as unknown, error: undefined as Error | undefined, sent: [] as unknown[] }));
vi.mock("./runtime-client", () => ({
  runtimeRequest: async (operation: string, payload: unknown) => {
    reply.sent.push([operation, payload]);
    if (reply.error) throw reply.error;
    return reply.value;
  },
}));

import { drawInWindow } from "./draw";

beforeEach(() => {
  reply.value = undefined;
  reply.error = undefined;
  reply.sent.length = 0;
});

it("asks main to draw and gives a picture back in the shape of a Python run", async () => {
  reply.value = { image: "data:image/png;base64,AAAA" };
  expect(await drawInWindow("graph", "digraph { a -> b }", 5000)).toEqual({
    stdout: "",
    stderr: "",
    images: ["data:image/png;base64,AAAA"],
    timedOut: false,
    truncated: false,
  });
  expect(reply.sent).toEqual([["draw", { kind: "graph", code: "digraph { a -> b }", timeoutMs: 5000 }]]);
});

it("gives a failure as the run's own stderr, with its time limit, and the runtime's failures by their names", async () => {
  reply.value = { error: "syntax error in line 1" };
  expect(await drawInWindow("graph", "x", 5000)).toMatchObject({ stderr: "syntax error in line 1", images: [], timedOut: false });
  reply.value = { error: "the drawing ran longer than 5 seconds", timedOut: true };
  expect(await drawInWindow("graph", "x", 5000)).toMatchObject({ timedOut: true, images: [] });
  reply.value = { error: "x".repeat(900) };
  expect((await drawInWindow("graph", "x", 5000)).stderr).toHaveLength(500);
  reply.value = { error: "runtime-missing" };
  expect((await drawInWindow("graph", "x", 5000)).stderr).toBe("runtime-missing");
  // An answer that is neither, or a request that fails, is no picture.
  for (const value of [undefined, null, {}, "text", { image: 7 }, { image: null }]) {
    reply.value = value;
    expect(await drawInWindow("graph", "x", 5000), JSON.stringify(value)).toMatchObject({ stderr: "runtime-draw-failed", images: [] });
  }
  reply.error = new Error("runtime-unavailable");
  expect(await drawInWindow("graph", "x", 5000)).toMatchObject({ stderr: "runtime-unavailable", images: [] });
});
