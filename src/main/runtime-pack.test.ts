import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../resources/pyodide-manifest.json", () => ({
  default: {
    version: "test",
    baseURL: "https://runtime.example/",
    files: [
      {
        name: "runtime.js",
        size: 3,
        sha256: createHash("sha256").update("abc").digest("hex"),
      },
    ],
  },
}));
import {
  cancelRuntimeDownload,
  currentRuntimeStatus,
  downloadRuntime,
  invalidateRuntime,
  requireRuntime,
} from "./runtime-pack";
const workspaces: string[] = [];
function workspace() {
  const path = mkdtempSync(join(tmpdir(), "pyxis-runtime-test-"));
  workspaces.push(path);
  return path;
}
afterEach(async () => {
  for (const path of workspaces.splice(0)) {
    await invalidateRuntime(path);
    rmSync(path, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

it("missing runtime and status never fetch; only explicit installation downloads hash-verified files", async () => {
  const path = workspace();
  const fetch = vi.fn(async () => new Response("abc"));
  vi.stubGlobal("fetch", fetch);
  expect((await currentRuntimeStatus(path)).phase).toBe("idle");
  await expect(requireRuntime(path)).rejects.toThrow("runtime-missing");
  expect(fetch).not.toHaveBeenCalled();
  await downloadRuntime(path);
  await requireRuntime(path);
  expect((await currentRuntimeStatus(path)).phase).toBe("ready");
  expect(fetch).toHaveBeenCalledTimes(1);
  writeFileSync(join(path, "runtimes/pyodide/test/runtime.js"), "bad");
  expect((await currentRuntimeStatus(path)).phase).toBe("idle");
  await expect(requireRuntime(path)).rejects.toThrow("runtime-missing");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("a cancelled download can retry without trusting a corrupt response", async () => {
  const path = workspace();
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetch = vi.fn(
    (_url: string, input: RequestInit) =>
      new Promise<Response>((_, reject) => {
        input.signal!.addEventListener(
          "abort",
          () => reject(input.signal!.reason),
          { once: true },
        );
        started();
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const installing = downloadRuntime(path);
  await gate;
  cancelRuntimeDownload(path);
  await expect(installing).rejects.toThrow();
  expect((await currentRuntimeStatus(path)).phase).toBe("idle");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("bad")),
  );
  await expect(downloadRuntime(path)).rejects.toThrow(
    "runtime-integrity-failed",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("abc")),
  );
  await downloadRuntime(path);
  expect((await currentRuntimeStatus(path)).phase).toBe("ready");
});
