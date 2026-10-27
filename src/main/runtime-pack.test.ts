import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});
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
  verifiedRuntimeFile,
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
  const runtimeFile = join(path, "runtimes/pyodide/test/runtime.js");
  writeFileSync(runtimeFile, "bad");
  // A changed file is caught by its new modification time. Windows moves that clock in steps of about 15 ms, so a
  // same-size rewrite right after the download can keep the old time; set it as a later edit would leave it.
  const later = new Date(Date.now() + 60_000);
  utimesSync(runtimeFile, later, later);
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

it("hashes an installed file again only after it changes", async () => {
  const path = workspace();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("abc")),
  );
  await downloadRuntime(path);
  const hashes = vi.mocked(createHash).mock.calls.length;
  expect(await verifiedRuntimeFile(path, "runtime.js")).toEqual(new Uint8Array(Buffer.from("abc")));
  expect(await verifiedRuntimeFile(path, "runtime.js")).toEqual(new Uint8Array(Buffer.from("abc")));
  expect((await currentRuntimeStatus(path)).phase).toBe("ready");
  expect(vi.mocked(createHash).mock.calls.length).toBe(hashes + 1);
  writeFileSync(join(path, "runtimes/pyodide/test/runtime.js"), "bad");
  expect(await verifiedRuntimeFile(path, "runtime.js")).toBeUndefined();
  expect((await currentRuntimeStatus(path)).phase).toBe("idle");
});
