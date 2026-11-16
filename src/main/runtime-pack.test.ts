import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
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
  invalidatePack,
  invalidateRuntime,
  removeRuntimePack,
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
  vi.unstubAllEnvs();
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
  // One request per file, each to its pinned place: Python's from its CDN folder, the drawing pack's from the URL its
  // manifest names. The packs download at the same time, so there is no order between them.
  expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([
    "https://files.example/circuits.whl",
    "https://runtime.example/runtime.js",
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
        // As fetch does: a signal that has already ended rejects at once.
        if (input.signal!.aborted) return reject(input.signal!.reason);
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
  expect(await currentRuntimeStatus(path)).toMatchObject({
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
  expect(await currentRuntimeStatus(path)).toMatchObject({
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
    expect(await currentRuntimeStatus(path)).toMatchObject({
      phase: "downloading",
      bytes: 3,
      totalBytes: 8,
      packs: { pyodide: "ready", drawing: "downloading" },
    }),
  );
  await requireRuntime(path);
  release();
  await failed;
  expect(await currentRuntimeStatus(path)).toMatchObject({
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

it("hashes a file of the drawing pack every time it is read, so a rewrite that puts the modification time back is caught", async () => {
  const path = workspace();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => published(url)));
  await downloadRuntime(path);
  const wheel = join(path, "runtimes/drawing/d2/circuits.whl");
  const python = join(path, "runtimes/pyodide/test/runtime.js");
  expect(await verifiedRuntimeFile(path, "drawing", "circuits.whl")).toBeDefined();
  expect(await verifiedRuntimeFile(path, "pyodide", "runtime.js")).toBeDefined();
  // The same size, other bytes, and the stamp (size, time, inode) of before: written in place, with the time set back.
  const before = statSync(wheel);
  writeFileSync(wheel, "WHEEL");
  utimesSync(wheel, before.atime, before.mtime);
  expect(await verifiedRuntimeFile(path, "drawing", "circuits.whl")).toBeUndefined();
  // Every read of an intact file is hashed, however often, where Python's 31 MB are not.
  writeFileSync(wheel, "wheel");
  utimesSync(wheel, before.atime, before.mtime);
  const hashes = vi.mocked(createHash).mock.calls.length;
  for (let i = 0; i < 3; i++) expect(await verifiedRuntimeFile(path, "drawing", "circuits.whl")).toBeDefined();
  expect(vi.mocked(createHash).mock.calls.length).toBe(hashes + 3);
  const pythonHashes = vi.mocked(createHash).mock.calls.length;
  for (let i = 0; i < 3; i++) expect(await verifiedRuntimeFile(path, "pyodide", "runtime.js")).toBeDefined();
  expect(vi.mocked(createHash).mock.calls.length).toBe(pythonHashes);
  void python;
});

it("makes the drawing pack not ready again when a window could not load its file, until its files check out", async () => {
  const path = workspace();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => published(url)));
  await downloadRuntime(path);
  const wheel = join(path, "runtimes/drawing/d2/circuits.whl");
  await requireRuntime(path, "drawing");
  writeFileSync(wheel, "WHEEL");
  // A pack that was ready stays ready in memory, which is what let a damaged file open a window every time.
  await requireRuntime(path, "drawing");
  invalidatePack(path, "drawing");
  await expect(requireRuntime(path, "drawing")).rejects.toThrow("runtime-missing");
  expect((await currentRuntimeStatus(path)).packs).toEqual({ pyodide: "ready", drawing: "idle" });
  // Python is untouched, and a file that is right again makes the pack ready.
  await requireRuntime(path);
  writeFileSync(wheel, "wheel");
  await requireRuntime(path, "drawing");
  expect((await currentRuntimeStatus(path)).packs).toEqual({ pyodide: "ready", drawing: "ready" });
});

it("downloads one pack on its own: the other pack is neither fetched nor changed", async () => {
  const path = workspace();
  const fetch = vi.fn(async (url: string) => published(url));
  vi.stubGlobal("fetch", fetch);
  await downloadRuntime(path, ["drawing"]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://files.example/circuits.whl"]);
  const status = await currentRuntimeStatus(path);
  expect(status.packs).toEqual({ pyodide: "idle", drawing: "ready" });
  expect(status.info.drawing).toEqual({ phase: "ready", bytes: 5, totalBytes: 5, size: 5, version: "d2", outdated: false });
  expect(status.info.pyodide).toEqual({ phase: "idle", bytes: 0, totalBytes: 3, size: 3, version: "test", outdated: false });
  await expect(requireRuntime(path, "pyodide")).rejects.toThrow("runtime-missing");
  // And the other way round.
  await downloadRuntime(path, ["pyodide"]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect((await currentRuntimeStatus(path)).phase).toBe("ready");
});

it("keeps each pack's progress, failure and cancellation to itself while both are downloading", async () => {
  const path = workspace();
  let releaseDrawing!: () => void;
  const drawingHeld = new Promise<void>((resolve) => {
    releaseDrawing = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, input: RequestInit) => {
      if (url.endsWith("circuits.whl")) {
        await drawingHeld;
        return new Response("nope", { status: 503 });
      }
      // Python's file never answers until it is cancelled.
      return new Promise<Response>((_, reject) => {
        if (input.signal!.aborted) return reject(input.signal!.reason);
        input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true });
      });
    }),
  );
  const drawing = downloadRuntime(path, ["drawing"]);
  const python = downloadRuntime(path, ["pyodide"]);
  const drawingFailed = expect(drawing).rejects.toThrow("runtime-download-503");
  const pythonCancelled = expect(python).rejects.toThrow();
  await vi.waitFor(async () => {
    const { info } = await currentRuntimeStatus(path);
    expect([info.drawing.phase, info.pyodide.phase]).toEqual(["downloading", "downloading"]);
  });
  // Stopping Python leaves the drawing pack's download on its way.
  cancelRuntimeDownload(path, ["pyodide"]);
  await pythonCancelled;
  let { info } = await currentRuntimeStatus(path);
  expect([info.drawing.phase, info.pyodide.phase]).toEqual(["downloading", "idle"]);
  // The drawing pack fails: it is failed and says why, and Python is not touched by it.
  releaseDrawing();
  await drawingFailed;
  ({ info } = await currentRuntimeStatus(path));
  expect([info.drawing.phase, info.pyodide.phase]).toEqual(["failed", "idle"]);
  expect(info.drawing.error).toBe("runtime-download-503");
  expect(info.pyodide.error).toBeUndefined();
});

it("joins a pack that is already downloading instead of fetching it twice", async () => {
  const path = workspace();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn(async (url: string) => {
    await held;
    return published(url);
  });
  vi.stubGlobal("fetch", fetch);
  const first = downloadRuntime(path, ["drawing"]);
  const joined = downloadRuntime(path);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  release();
  await Promise.all([first, joined]);
  // Each file was asked for once: the drawing pack by the first call, and Python's by the second.
  expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual(["https://files.example/circuits.whl", "https://runtime.example/runtime.js"]);
  expect((await currentRuntimeStatus(path)).phase).toBe("ready");
});

it("says how far a download got when it stopped, and a tampered file as an integrity failure", async () => {
  const path = workspace();
  // The pack's size is 5 bytes in one file: a file that arrives with other bytes is refused whole.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("wheeX")));
  await expect(downloadRuntime(path, ["drawing"])).rejects.toThrow("runtime-integrity-failed");
  let { info } = await currentRuntimeStatus(path);
  expect(info.drawing).toMatchObject({ phase: "failed", error: "runtime-integrity-failed", bytes: 0 });
  expect(existsSync(join(path, "runtimes/drawing/d2/circuits.whl"))).toBe(false);
  // A retry starts the count again, and a good file ends the failure.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => published(url)));
  await downloadRuntime(path, ["drawing"]);
  ({ info } = await currentRuntimeStatus(path));
  expect(info.drawing).toEqual({ phase: "ready", bytes: 5, totalBytes: 5, size: 5, version: "d2", outdated: false });
});

it("removes one pack at once: its files go, nothing serves them and the other pack stays", async () => {
  const path = workspace();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => published(url)));
  await downloadRuntime(path);
  expect(await verifiedRuntimeFile(path, "drawing", "circuits.whl")).toBeDefined();
  await removeRuntimePack(path, "drawing");
  // Gone from the disk, from what is served, and from what is ready, before anything looks at the disk again.
  expect(existsSync(join(path, "runtimes/drawing"))).toBe(false);
  expect(await verifiedRuntimeFile(path, "drawing", "circuits.whl")).toBeUndefined();
  await expect(requireRuntime(path, "drawing")).rejects.toThrow("runtime-missing");
  const status = await currentRuntimeStatus(path);
  expect(status.packs).toEqual({ pyodide: "ready", drawing: "idle" });
  expect(status.info.drawing).toMatchObject({ phase: "idle", bytes: 0, outdated: false });
  await requireRuntime(path, "pyodide");
  expect(existsSync(join(path, "runtimes/pyodide/test/runtime.js"))).toBe(true);
  // Removing what is not there is not an error, and the pack can be downloaded again.
  await removeRuntimePack(path, "drawing");
  await downloadRuntime(path, ["drawing"]);
  await requireRuntime(path, "drawing");
});

it("removes every version of a pack, and stops a download of it that is under way", async () => {
  const path = workspace();
  for (const folder of ["runtimes/pyodide/older", "runtimes/pyodide/test"]) {
    mkdirSync(join(path, folder), { recursive: true });
    writeFileSync(join(path, folder, "runtime.js"), "abc");
  }
  await removeRuntimePack(path, "pyodide");
  expect(existsSync(join(path, "runtimes/pyodide"))).toBe(false);
  // A download of the pack that is running when it is removed ends, and nothing is left behind by it.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, input: RequestInit) =>
        new Promise<Response>((_, reject) => {
          if (input.signal!.aborted) return reject(input.signal!.reason);
          input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true });
        }),
    ),
  );
  const installing = downloadRuntime(path, ["drawing"]);
  const ended = expect(installing).rejects.toThrow();
  await vi.waitFor(async () => expect((await currentRuntimeStatus(path)).info.drawing.phase).toBe("downloading"));
  await removeRuntimePack(path, "drawing");
  await ended;
  expect((await currentRuntimeStatus(path)).info.drawing.phase).toBe("idle");
  expect(existsSync(join(path, "runtimes/drawing"))).toBe(false);
});

it("offers an update for a pack the workspace holds in an older version, runs nothing from it and fetches nothing by itself", async () => {
  const path = workspace();
  // The drawing pack of an earlier app (version d1), and Python of the current one.
  mkdirSync(join(path, "runtimes/drawing/d1"), { recursive: true });
  writeFileSync(join(path, "runtimes/drawing/d1/circuits.whl"), "wheel");
  mkdirSync(join(path, "runtimes/pyodide/test"), { recursive: true });
  writeFileSync(join(path, "runtimes/pyodide/test/runtime.js"), "abc");
  const fetch = vi.fn(async (url: string) => published(url));
  vi.stubGlobal("fetch", fetch);
  const status = await currentRuntimeStatus(path);
  expect(status.packs).toEqual({ pyodide: "ready", drawing: "idle" });
  expect(status.info.drawing).toMatchObject({ phase: "idle", outdated: true, version: "d2" });
  expect(status.info.pyodide.outdated).toBe(false);
  // The old files are not run: the current manifest cannot vouch for them, even when their bytes match.
  await expect(requireRuntime(path, "drawing")).rejects.toThrow("runtime-missing");
  expect(await verifiedRuntimeFile(path, "drawing", "circuits.whl")).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  // Updating fetches this version, which replaces the older one, and the pack is no longer out of date.
  await downloadRuntime(path, ["drawing"]);
  expect(existsSync(join(path, "runtimes/drawing/d1"))).toBe(false);
  expect((await currentRuntimeStatus(path)).info.drawing).toMatchObject({ phase: "ready", outdated: false });
});

it("takes the files of an end-to-end run from the server that stands in for the CDN, and only in that run", async () => {
  const path = workspace();
  const fetch = vi.fn(async (url: string) => published(url));
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("PYXIS_E2E_PACK_BASE", "http://127.0.0.1:9999/packs/");
  // Without PYXIS_E2E=1 the variable is ignored.
  await downloadRuntime(path, ["drawing"]);
  expect(fetch.mock.calls[0]![0]).toBe("https://files.example/circuits.whl");
  await removeRuntimePack(path, "drawing");
  vi.stubEnv("PYXIS_E2E", "1");
  await downloadRuntime(path, ["drawing"]);
  expect(fetch.mock.calls[1]![0]).toBe("http://127.0.0.1:9999/packs/drawing/circuits.whl");
  vi.unstubAllEnvs();
});

it("counts only the packs it is fetching in a transfer's total and progress, not one that was already there", async () => {
  const path = workspace();
  // Python is installed; only the drawing pack is missing, and its file is held back.
  mkdirSync(join(path, "runtimes/pyodide/test"), { recursive: true });
  writeFileSync(join(path, "runtimes/pyodide/test/runtime.js"), "abc");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      await held;
      return published(url);
    }),
  );
  // What is offered is what is missing.
  expect(await currentRuntimeStatus(path)).toMatchObject({ phase: "idle", totalBytes: 5 });
  // The download that asks for every pack skips Python, which is there, and its transfer is the drawing pack's alone.
  const installing = downloadRuntime(path);
  await vi.waitFor(async () =>
    expect(await currentRuntimeStatus(path)).toMatchObject({ phase: "downloading", bytes: 0, totalBytes: 5 }),
  );
  release();
  await installing;
  expect(await currentRuntimeStatus(path)).toMatchObject({ phase: "ready", bytes: 8, totalBytes: 8 });
});
