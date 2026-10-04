import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("stages a whiteboard png in workspace scratch, bounded and pruned", () => {
    const workspace = mkdtempSync(join(tmpdir(), "pyxis-tools-"));
    try {
      const png =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const tools = toolHandlers(workspace);
      const staged = tools.stagePng({ dataUrl: png });
      expect(
        staged.path.startsWith(join(workspace, "scratch", "whiteboard")),
      ).toBe(true);
      expect(readFileSync(staged.path)[0]).toBe(0x89);
      const again = tools.stagePng({ dataUrl: png });
      expect(again.path).not.toBe(staged.path);
      expect(() =>
        tools.stagePng({ dataUrl: "data:image/png;base64,iQAAAAAAAAA=" }),
      ).toThrow(/png-invalid/);
      expect(() =>
        tools.stagePng({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" }),
      ).toThrow(/png-invalid/);
      const huge = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(3_100_000),
      ]).toString("base64");
      expect(() =>
        tools.stagePng({ dataUrl: `data:image/png;base64,${huge}` }),
      ).toThrow(/png-invalid/);
      for (let index = 0; index < 25; index++) tools.stagePng({ dataUrl: png });
      expect(
        readdirSync(join(workspace, "scratch", "whiteboard")).length,
      ).toBeLessThanOrEqual(21);
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const stale = tools.stagePng({ dataUrl: png });
      utimesSync(stale.path, old, old);
      tools.stagePng({ dataUrl: png });
      expect(existsSync(stale.path)).toBe(false);
      expect(() => toolHandlers().stagePng({ dataUrl: png })).toThrow(
        /workspace-missing/,
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("starts one explicit runtime download job and reuses it", () => {
    const jobs: Array<{ id: string; kind: string; state: string }> = [];
    const calls: string[] = [];
    const runner = {
      register: () => undefined,
      start: (kind: string) => {
        jobs.push({ id: "job-1", kind, state: "queued" });
        calls.push("start");
        return "job-1";
      },
      retry: () => calls.push("retry"),
      resume: () => calls.push("resume"),
      list: () => jobs,
    } as unknown as Parameters<typeof toolHandlers>[1];
    const tools = toolHandlers("", runner);
    expect(tools.runtimeDownload()).toEqual({ jobId: "job-1" });
    expect(tools.runtimeDownload()).toEqual({ jobId: "job-1" });
    jobs[0]!.state = "failed";
    tools.runtimeDownload();
    expect(calls).toEqual(["start", "retry"]);
    expect(() => toolHandlers().runtimeDownload()).toThrow(
      /runtime-unavailable/,
    );
  });
});
