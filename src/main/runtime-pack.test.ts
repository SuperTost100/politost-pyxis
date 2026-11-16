import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
vi.mock("../../resources/drawing-manifest.json", () => ({
  default: {
    version: "d2",
    files: [
      {
        name: "circuits.whl",
        url: "https://files.example/circuits.whl",
        size: 5,
        sha256: createHash("sha256").update("wheel").digest("hex"),
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
/** The pinned bytes of each pack's file, by the URL its manifest names. */
const published = (url: string | URL | Request) =>
  new Response(String(url).endsWith("circuits.whl") ? "wheel" : "abc");
afterEach(async () => {
  for (const path of workspaces.splice(0)) {
    await invalidateRuntime(path);
    rmSync(path, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

it("missing runtime and status never fetch; only explicit installation downloads hash-verified files", async () => {
  const path = workspace();
  const fetch = vi.fn(async (url: string) => published(url));
  vi.stubGlobal("fetch", fetch);
  expect((await currentRuntimeStatus(path)).phase).toBe("idle");
  await expect(requireRuntime(path)).rejects.toThrow("runtime-missing");
  expect(fetch).not.toHaveBeenCalled();
  await downloadRuntime(path);
  await requireRuntime(path);
  expect((await currentRuntimeStatus(path)).phase).toBe("ready");
  // One request per file: Python's from its CDN folder, the drawing pack's from the URL its manifest names.
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://runtime.example/runtime.js",
    "https://files.example/circuits.whl",
  ]);
  const runtimeFile = join(path, "runtimes/pyodide/test/runtime.js");
  writeFileSync(runtimeFile, "bad");
  // A changed file is caught by its new modification time. Windows moves that clock in steps of about 15 ms, so a
  // same-size rewrite right after the download can keep the old time; set it as a later edit would leave it.
  const later = new Date(Date.now() + 60_000);
  utimesSync(runtimeFile, later, later);
  expect((await currentRuntimeStatus(path)).phase).toBe("idle");
  await expect(requireRuntime(path)).rejects.toThrow("runtime-missing");
  expect(fetch).toHaveBeenCalledTimes(2);
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
  vi.stubGlobal("fetch", vi.fn(async (url: string) => published(url)));
  await downloadRuntime(path);
  expect((await currentRuntimeStatus(path)).phase).toBe("ready");
});

it("hashes an installed file again only after it changes", async () => {
  const path = workspace();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => published(url)));
  await downloadRuntime(path);
  const hashes = vi.mocked(createHash).mock.calls.length;
  expect(await verifiedRuntimeFile(path, "pyodide", "runtime.js")).toEqual(new Uint8Array(Buffer.from("abc")));
  expect(await verifiedRuntimeFile(path, "pyodide", "runtime.js")).toEqual(new Uint8Array(Buffer.from("abc")));
  expect((await currentRuntimeStatus(path)).phase).toBe("ready");
  // One hash per installed file, the drawing pack's included, however often they are read or looked at.
  expect(vi.mocked(createHash).mock.calls.length).toBe(hashes + 2);
  // A file is served only under its own pack.
  expect(await verifiedRuntimeFile(path, "drawing", "runtime.js")).toBeUndefined();
  expect(await verifiedRuntimeFile(path, "drawing", "circuits.whl")).toEqual(new Uint8Array(Buffer.from("wheel")));
  writeFileSync(join(path, "runtimes/pyodide/test/runtime.js"), "bad");
  expect(await verifiedRuntimeFile(path, "pyodide", "runtime.js")).toBeUndefined();
  expect((await currentRuntimeStatus(path)).phase).toBe("idle");
});

it("keeps Python running in a workspace without the drawing pack, and fetches only that pack when asked", async () => {
  const path = workspace();
  // A workspace that downloaded Python before the drawing pack existed.
  mkdirSync(join(path, "runtimes/pyodide/test"), { recursive: true });
  writeFileSync(join(path, "runtimes/pyodide/test/runtime.js"), "abc");
  const fetch = vi.fn(async (url: string) => published(url));
  vi.stubGlobal("fetch", fetch);
  expect(await currentRuntimeStatus(path)).toEqual({
    phase: "idle",
    bytes: 0,
    totalBytes: 5,
    packs: { pyodide: "ready", drawing: "idle" },
  });
  await requireRuntime(path);
  await expect(requireRuntime(path, "drawing")).rejects.toThrow("runtime-missing");
  // Looking never downloads: the pack comes only with the explicit download.
  expect(fetch).not.toHaveBeenCalled();
  await downloadRuntime(path);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://files.example/circuits.whl"]);
  await requireRuntime(path, "drawing");
  expect(await currentRuntimeStatus(path)).toEqual({
    phase: "ready",
    bytes: 8,
    totalBytes: 8,
    packs: { pyodide: "ready", drawing: "ready" },
  });
});

it("downloads both packs in one go with one progress, and a drawing pack that fails leaves Python ready", async () => {
  const path = workspace();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.endsWith("circuits.whl")) return published(url);
      await held;
      return new Response("nope", { status: 503 });
    }),
  );
  const installing = downloadRuntime(path);
  const failed = expect(installing).rejects.toThrow("runtime-download-503");
  // Python is in place and usable while the drawing pack is still on its way; the progress counts both.
  await vi.waitFor(async () =>
    expect(await currentRuntimeStatus(path)).toEqual({
      phase: "downloading",
      bytes: 3,
      totalBytes: 8,
      packs: { pyodide: "ready", drawing: "downloading" },
    }),
  );
  await requireRuntime(path);
  release();
  await failed;
  expect(await currentRuntimeStatus(path)).toEqual({
    phase: "failed",
    bytes: 0,
    totalBytes: 5,
    error: "runtime-download-503",
    packs: { pyodide: "ready", drawing: "failed" },
  });
  await requireRuntime(path);
  // Retry fetches what is missing, not Python again.
  const retry = vi.fn(async (url: string) => published(url));
  vi.stubGlobal("fetch", retry);
  await downloadRuntime(path);
  expect(retry).toHaveBeenCalledTimes(1);
  expect((await currentRuntimeStatus(path)).phase).toBe("ready");
});

it("deletes an older version of the drawing pack only after the new one is verified", async () => {
  const path = workspace();
  const older = join(path, "runtimes/drawing/d1");
  const olderPython = join(path, "runtimes/pyodide/older");
  for (const folder of [older, olderPython]) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "old.whl"), "old");
  }
  vi.stubGlobal("fetch", vi.fn(async () => new Response("abc")));
  await expect(downloadRuntime(path)).rejects.toThrow("runtime-integrity-failed");
  expect(existsSync(older)).toBe(true);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => published(url)));
  await downloadRuntime(path);
  expect(existsSync(older)).toBe(false);
  expect(existsSync(join(path, "runtimes/drawing/d2/circuits.whl"))).toBe(true);
  // Python's folders are not this pack's to delete.
  expect(existsSync(olderPython)).toBe(true);
});
