import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for Electron: windows never load anything, and each run/check the page is asked for stays pending until
// the test settles it, so a request can be held in flight while others queue behind it.
const fake = vi.hoisted(() => ({
  windows: [] as Array<{ destroyed: boolean; crashed: boolean; destroy(): void; frame: { destroyed: boolean; detached: boolean } }>,
  held: [] as Array<{ script: string; settle: (value: unknown) => void; fail: (error: Error) => void }>,
  scripts: [] as string[],
  proxies: [] as unknown[],
  webrtc: [] as string[],
  partitions: [] as string[],
  handled: [] as string[],
  cleared: 0,
  /** While set, clearing the session's storage does not finish until it resolves. */
  clearGate: null as Promise<void> | null,
}));

vi.mock("electron", () => {
  class FakeWindow {
    destroyed = false;
    crashed = false;
    frame = {
      destroyed: false,
      detached: false,
      isDestroyed() {
        return this.destroyed;
      },
    };
    listeners = new Map<string, Set<() => void>>();
    webContents = {
      setWindowOpenHandler: () => undefined,
      setWebRTCIPHandlingPolicy: (policy: string) => {
        fake.webrtc.push(policy);
      },
      on: () => undefined,
      isDestroyed: () => this.destroyed,
      isCrashed: () => this.crashed,
      mainFrame: this.frame,
      executeJavaScript: (script: string) => {
        fake.scripts.push(script);
        if (script.startsWith("window.pyxisRuntime.stop("))
          return Promise.resolve(undefined);
        return new Promise((resolve, reject) =>
          fake.held.push({ script, settle: resolve, fail: reject }),
        );
      },
    };
    constructor() {
      fake.windows.push(this);
    }
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    on(name: string, listener: () => void) {
      this.once(name, listener);
    }
    once(name: string, listener: () => void) {
      const set = this.listeners.get(name) ?? new Set();
      set.add(listener);
      this.listeners.set(name, set);
    }
    removeListener(name: string, listener: () => void) {
      this.listeners.get(name)?.delete(listener);
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      for (const listener of [...(this.listeners.get("closed") ?? [])])
        listener();
    }
  }
  const partition = {
    protocol: {
      handle: (scheme: string) => {
        fake.handled.push(scheme);
      },
    },
    clearStorageData: async () => {
      fake.cleared++;
      await fake.clearGate;
    },
    webRequest: { onBeforeRequest: () => undefined },
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
    setProxy: async (config: unknown) => {
      fake.proxies.push(config);
    },
  };
  return {
    BrowserWindow: FakeWindow,
    session: {
      fromPartition: (name: string) => {
        fake.partitions.push(name);
        return partition;
      },
    },
  };
});

const requireRuntime = vi.hoisted(() => vi.fn(async () => undefined));
const packs = vi.hoisted(() => ({ pyodide: "ready", drawing: "idle" }));
vi.mock("./runtime-pack", () => ({
  requireRuntime,
  runtimePacks: {
    pyodide: { files: [] },
    drawing: { files: [{ name: "circuits.whl" }, { name: "notes.txt" }] },
  },
  cancelRuntimeDownload: () => undefined,
  currentRuntimeStatus: async () => ({ packs }),
  downloadRuntime: async () => "",
  verifiedRuntimeFile: async () => undefined,
}));

import {
  configurePythonRuntime,
  disposePythonRuntime,
  handleRuntimeRequest,
} from "./python-runtime";

const claim = { kind: "equal", expr: "x+x", claimed: "2*x" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("python runtime queue", () => {
  beforeEach(() => {
    fake.windows.length = 0;
    fake.held.length = 0;
    fake.scripts.length = 0;
    fake.proxies.length = 0;
    fake.webrtc.length = 0;
    fake.partitions.length = 0;
    fake.handled.length = 0;
    fake.cleared = 0;
    requireRuntime.mockClear();
    configurePythonRuntime("/workspace-a");
  });
  afterEach(() => {
    disposePythonRuntime();
    vi.useRealTimers();
  });

  it("locks the Python sandbox's window as the drawing window is: a dead proxy for the network stack, and no WebRTC UDP", async () => {
    const running = handleRuntimeRequest("python", { code: "1" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    // Whatever the network stack opens for this window (WebRTC, preconnect, DNS) goes to a SOCKS proxy that is not there,
    // loopback included, and WebRTC may use no UDP that does not go through it.
    expect(fake.proxies).toEqual([{ mode: "fixed_servers", proxyRules: "socks5://127.0.0.1:9", proxyBypassRules: "<-loopback>" }]);
    expect(fake.webrtc).toEqual(["disable_non_proxied_udp"]);
    fake.held[0]!.settle({ stdout: "" });
    await running;
  });

  it("does not reopen the sandbox for requests queued when it is disposed", async () => {
    const first = handleRuntimeRequest("check", claim);
    const second = handleRuntimeRequest("check", claim);
    const third = handleRuntimeRequest("check", claim);
    await tick();
    expect(fake.windows).toHaveLength(1);
    expect(requireRuntime).toHaveBeenCalledTimes(1);
    disposePythonRuntime();
    // Every one is an honest "not checked", and none loaded the runtime again.
    for (const result of await Promise.all([first, second, third]))
      expect(result).toEqual({ state: "none", reason: "runtime-unavailable" });
    await tick();
    expect(fake.windows).toHaveLength(1);
    expect(requireRuntime).toHaveBeenCalledTimes(1);
    expect(fake.scripts).toHaveLength(1);
  });

  it("drops queued code the same way, and a request made after the dispose runs", async () => {
    const running = handleRuntimeRequest("python", { code: "1" });
    const queued = handleRuntimeRequest("python", { code: "2" });
    await tick();
    disposePythonRuntime();
    await expect(running).rejects.toThrow("runtime-crashed");
    await expect(queued).rejects.toThrow("runtime-disposed");
    expect(fake.windows).toHaveLength(1);
    const later = handleRuntimeRequest("check", claim);
    await tick();
    expect(fake.windows).toHaveLength(2);
    fake.held.at(-1)!.settle({ state: "verified" });
    await expect(later).resolves.toEqual({ state: "verified" });
  });

  // Electron 45 rejects the pending call the moment the renderer dies, before the window closes.
  it("reports a renderer that died mid-run as runtime-crashed, whatever Electron's rejection says", async () => {
    const running = handleRuntimeRequest("python", { code: "while True: pass" });
    await tick();
    fake.windows[0]!.crashed = true;
    fake.held[0]!.fail(new Error("Render frame was disposed before the request completed"));
    await expect(running).rejects.toThrow("runtime-crashed");
  });

  // Electron can dispose the main frame and reject the call before isCrashed() or render-process-gone report it.
  for (const gone of ["destroyed", "detached"] as const)
    it(`reports a run whose main frame is ${gone} as runtime-crashed, before the crash is reported`, async () => {
      const running = handleRuntimeRequest("python", { code: "while True: pass" });
      await tick();
      fake.windows[0]!.frame[gone] = true;
      fake.held[0]!.fail(new Error("Render frame was disposed before the request completed"));
      await expect(running).rejects.toThrow("runtime-crashed");
    });

  it("passes on a failed call from a renderer that is still running", async () => {
    const running = handleRuntimeRequest("python", { code: "1" });
    await tick();
    fake.held[0]!.fail(new Error("Script failed to execute"));
    await expect(running).rejects.toThrow("Script failed to execute");
  });

  it("keeps queued work when the same workspace is configured again", async () => {
    const first = handleRuntimeRequest("check", claim);
    const second = handleRuntimeRequest("check", claim);
    await tick();
    configurePythonRuntime("/workspace-a");
    expect(fake.windows[0]!.destroyed).toBe(false);
    fake.held[0]!.settle({ state: "verified" });
    await expect(first).resolves.toEqual({ state: "verified" });
    await tick();
    fake.held[1]!.settle({ state: "failed" });
    await expect(second).resolves.toEqual({ state: "failed" });
    expect(fake.windows).toHaveLength(1);
  });

  it("drops queued work when the workspace changes", async () => {
    const first = handleRuntimeRequest("check", claim);
    const second = handleRuntimeRequest("check", claim);
    await tick();
    configurePythonRuntime("/workspace-b");
    for (const result of await Promise.all([first, second]))
      expect(result).toEqual({ state: "none", reason: "runtime-unavailable" });
    await tick();
    expect(fake.windows).toHaveLength(1);
    expect(requireRuntime).toHaveBeenCalledTimes(1);
    expect(requireRuntime).not.toHaveBeenCalledWith("/workspace-b");
  });

  it("does not run queued work whose requester has already timed out, and leaves the running one alone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const running = handleRuntimeRequest(
      "python",
      { code: "slow" },
      Date.now() + 120000,
    );
    const late = handleRuntimeRequest(
      "python",
      { code: "late" },
      Date.now() + 120000,
    );
    const check = handleRuntimeRequest("check", claim, Date.now() + 120000);
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    // The check lane is separate from the python lane, so only "late" is stuck behind "slow".
    vi.setSystemTime(Date.now() + 121000);
    fake.held.find((h) => h.script.includes(".run("))!.settle({ stdout: "ok" });
    await expect(running).resolves.toEqual({ stdout: "ok" });
    await expect(late).rejects.toThrow("runtime-expired");
    fake.held
      .find((h) => h.script.includes(".check("))!
      .settle({ state: "verified" });
    await expect(check).resolves.toEqual({ state: "verified" });
    expect(fake.scripts.filter((s) => s.includes(".run("))).toHaveLength(1);
    // Nothing was stopped on anyone's behalf.
    expect(fake.scripts.some((s) => s.includes(".stop("))).toBe(false);
  });

  it("still runs a queued request that has time left", async () => {
    const first = handleRuntimeRequest(
      "python",
      { code: "1" },
      Date.now() + 60000,
    );
    const second = handleRuntimeRequest(
      "python",
      { code: "2" },
      Date.now() + 60000,
    );
    await tick();
    fake.held[0]!.settle({ stdout: "1" });
    await first;
    await tick();
    fake.held[1]!.settle({ stdout: "2" });
    await expect(second).resolves.toEqual({ stdout: "2" });
  });

  it("gives a Python run the drawing pack's wheels only once that pack is downloaded", async () => {
    const without = handleRuntimeRequest("python", { code: "1", timeoutMs: 8000 });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    expect(fake.held[0]!.script).toBe('window.pyxisRuntime.run("1", 8000, [])');
    fake.held[0]!.settle({ stdout: "1" });
    await without;
    packs.drawing = "ready";
    try {
      const withPack = handleRuntimeRequest("python", { code: "2", timeoutMs: 8000 });
      await vi.waitFor(() => expect(fake.held).toHaveLength(2));
      expect(fake.held[1]!.script).toBe(
        'window.pyxisRuntime.run("2", 8000, ["drawing/circuits.whl"])',
      );
      fake.held[1]!.settle({ stdout: "2" });
      await withPack;
    } finally {
      packs.drawing = "idle";
    }
  });

  it("sends grading checks through the check lane, after the chat check ahead of them", async () => {
    const chat = handleRuntimeRequest("check", claim);
    const grade = handleRuntimeRequest("grade", {
      answer: "2x + 2",
      reference: "2(x+1)",
    });
    await tick();
    expect(fake.held).toHaveLength(1);
    fake.held[0]!.settle({ state: "verified" });
    await chat;
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    expect(fake.held[1]!.script).toBe(
      'window.pyxisRuntime.grade({"answer":"2x + 2","reference":"2(x+1)"})',
    );
    const report = { final: { state: "verified" }, steps: 1 };
    fake.held[1]!.settle(report);
    await expect(grade).resolves.toEqual(report);
  });

  it("refuses a malformed grading request without opening the sandbox", async () => {
    await expect(
      handleRuntimeRequest("grade", { answer: "", reference: "1" }),
    ).resolves.toEqual({ state: "none", reason: "runtime-unavailable" });
    await expect(
      handleRuntimeRequest("grade", { answer: "x".repeat(8001), reference: "1" }),
    ).resolves.toEqual({ state: "none", reason: "runtime-unavailable" });
    expect(fake.windows).toHaveLength(0);
  });
});

// The session is made once per app run, so these tests start from a fresh module.
describe("python runtime session", () => {
  let python: typeof import("./python-runtime");
  beforeEach(async () => {
    vi.resetModules();
    fake.windows.length = 0;
    fake.held.length = 0;
    fake.scripts.length = 0;
    fake.proxies.length = 0;
    fake.partitions.length = 0;
    fake.handled.length = 0;
    fake.cleared = 0;
    fake.clearGate = null;
    python = await import("./python-runtime");
    python.configurePythonRuntime("/workspace-a");
  });
  afterEach(() => python.disposePythonRuntime());

  it("keeps one in-memory session for a hundred windows, and clears its storage as each one ends", async () => {
    for (let round = 0; round < 100; round++) {
      const running = python.handleRuntimeRequest("check", claim);
      await vi.waitFor(() => expect(fake.held).toHaveLength(1), { interval: 1 });
      // The renderer dies mid-request, as a crash would, and the next request opens a fresh window.
      fake.windows.at(-1)!.destroy();
      await running;
      fake.held.length = 0;
    }
    expect(fake.windows).toHaveLength(100);
    expect(fake.partitions).toEqual(["pyxis-python"]);
    expect(fake.handled).toEqual(["pyxis-runtime"]);
    expect(fake.proxies).toHaveLength(1);
    // Cleared when the window ended, and again when the request that was running in it settled.
    expect(fake.cleared).toBeGreaterThanOrEqual(100);
  });

  it("clears the session's storage after every run, so nothing a run leaves reaches the next one", async () => {
    const running = python.handleRuntimeRequest("python", { code: "1" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    expect(fake.cleared).toBe(0);
    fake.held[0]!.settle({ stdout: "" });
    await running;
    expect(fake.cleared).toBe(1);
    // A run that fails clears it as well.
    const failing = python.handleRuntimeRequest("python", { code: "2" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    fake.held[1]!.fail(new Error("boom"));
    await expect(failing).rejects.toThrow();
    expect(fake.cleared).toBe(2);
  });

  it("clears the session's storage when the runtime is disposed", async () => {
    const running = python.handleRuntimeRequest("check", claim);
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    python.disposePythonRuntime();
    await running;
    expect(fake.cleared).toBeGreaterThanOrEqual(1);
  });

  it("does not open the next window until the storage of the one that ended has been cleared", async () => {
    const first = python.handleRuntimeRequest("check", claim);
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.settle({ state: "none" });
    await first;
    let finish: () => void = () => undefined;
    fake.clearGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fake.windows[0]!.destroy();
    const second = python.handleRuntimeRequest("check", claim);
    await vi.waitFor(() => expect(fake.cleared).toBeGreaterThanOrEqual(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.windows).toHaveLength(1);
    finish();
    await vi.waitFor(() => expect(fake.windows).toHaveLength(2));
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    fake.held[1]!.settle({ state: "none" });
    await second;
  });
});
