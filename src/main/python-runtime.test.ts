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
  /** How many clearings had started when each script was sent to a page, in order. */
  clearedAtScript: [] as number[],
  /** While set, clearing the session's storage does not finish until it resolves. */
  clearGate: null as Promise<void> | null,
  /** While set, clearing the session's storage fails. */
  clearFails: false,
  /** While set, the page does not answer a stop until it resolves. */
  stopGate: null as Promise<void> | null,
  /** While set, a window's load stays pending until the test settles it, in the order the windows were made. */
  holdLoads: false,
  loads: [] as Array<{ resolve: () => void; reject: (error: Error) => void }>,
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
        fake.clearedAtScript.push(fake.cleared);
        if (script.startsWith("window.pyxisRuntime.stop("))
          return fake.stopGate ? fake.stopGate.then(() => undefined) : Promise.resolve(undefined);
        return new Promise((resolve, reject) =>
          fake.held.push({ script, settle: resolve, fail: reject }),
        );
      },
    };
    constructor() {
      fake.windows.push(this);
    }
    loadURL() {
      if (!fake.holdLoads) return Promise.resolve();
      return new Promise<void>((resolve, reject) => fake.loads.push({ resolve, reject }));
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
      if (fake.clearFails) throw new Error("clearing failed");
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
const downloadRuntime = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ""));
const cancelRuntimeDownload = vi.hoisted(() => vi.fn((..._args: unknown[]) => undefined));
const removeRuntimePack = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
const packs = vi.hoisted(() => ({ pyodide: "ready", drawing: "idle" }));
vi.mock("./runtime-pack", () => ({
  requireRuntime,
  runtimePacks: {
    pyodide: { files: [] },
    drawing: { files: [{ name: "circuits.whl" }, { name: "notes.txt" }] },
  },
  cancelRuntimeDownload,
  currentRuntimeStatus: async () => ({ packs }),
  downloadRuntime,
  removeRuntimePack,
  verifiedRuntimeFile: async () => undefined,
}));

import {
  configurePythonRuntime,
  disposePythonRuntime,
  handleRuntimeRequest,
  pythonTestHandle,
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
    expect(fake.proxies).toEqual([{ mode: "fixed_servers", proxyRules: "socks5://127.0.0.1:0", proxyBypassRules: "<-loopback>" }]);
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

  it("records how far a request got, with no end while it runs and the reason when it fails", async () => {
    const running = handleRuntimeRequest("python", { code: "1" });
    await tick();
    const pending = pythonTestHandle().requests().at(-1)!;
    expect(pending).toMatchObject({ operation: "run", method: "run" });
    expect(pending.entered).toBeTypeOf("number");
    expect(pending.opened).toBeTypeOf("number");
    expect(pending.ended).toBeUndefined();
    expect(pending.outcome).toBeUndefined();
    fake.held[0]!.settle({ stdout: "1\n" });
    await running;
    expect(pythonTestHandle().requests().at(-1)).toMatchObject({ outcome: "ok" });
    expect(pythonTestHandle().requests().at(-1)!.left).toBeTypeOf("number");

    const crashing = handleRuntimeRequest("python", { code: "2" });
    await tick();
    fake.windows[0]!.crashed = true;
    fake.held.at(-1)!.fail(new Error("Render frame was disposed before the request completed"));
    await expect(crashing).rejects.toThrow("runtime-crashed");
    expect(pythonTestHandle().requests().at(-1)).toMatchObject({ outcome: "runtime-crashed" });
  });

  it("records a request from the moment it is made, through its wait behind the one holding the lane, and when it is dropped before its turn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const first = handleRuntimeRequest("python", { code: "1" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    vi.setSystemTime(start + 5000);
    const second = handleRuntimeRequest("python", { code: "2" });
    const late = handleRuntimeRequest("python", { code: "3" }, start + 8000);
    await tick();
    const [, waiting, expiring] = pythonTestHandle().requests().slice(-3);
    expect(waiting).toMatchObject({ queued: start + 5000 });
    expect(waiting!.entered).toBeUndefined();
    expect(waiting!.ended).toBeUndefined();
    expect(expiring).toMatchObject({ queued: start + 5000 });

    vi.setSystemTime(start + 9000);
    fake.held[0]!.settle({ stdout: "1\n" });
    await first;
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    const [, running, stuck] = pythonTestHandle().requests().slice(-3);
    // Date moves on with the clock after setSystemTime, so the time it entered is not exactly the one that was set.
    expect(running).toMatchObject({ queued: start + 5000 });
    expect(running!.entered).toBeGreaterThanOrEqual(start + 9000);
    expect(running!.ended).toBeUndefined();
    expect(stuck!.entered).toBeUndefined();

    fake.held[1]!.settle({ stdout: "2\n" });
    await second;
    await expect(late).rejects.toThrow("runtime-expired");
    const dropped = pythonTestHandle().requests().at(-1)!;
    expect(dropped).toMatchObject({ queued: start + 5000, outcome: "runtime-expired" });
    expect(dropped.ended).toBeTypeOf("number");
    expect(dropped.entered).toBeUndefined();
  });

  it("records a queued request that the runtime's disposal dropped", async () => {
    const first = handleRuntimeRequest("python", { code: "1" }).catch(() => undefined);
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    const queued = handleRuntimeRequest("python", { code: "2" });
    const dropped = expect(queued).rejects.toThrow("runtime-disposed");
    await tick();
    // Disposing closes the window the first request runs in, which ends it as crashed; the second never gets its turn.
    disposePythonRuntime();
    await first;
    await dropped;
    expect(pythonTestHandle().requests().at(-1)).toMatchObject({ outcome: "runtime-disposed" });
    expect(pythonTestHandle().requests().at(-1)!.entered).toBeUndefined();
    expect(pythonTestHandle().requests().at(-1)!.ended).toBeTypeOf("number");
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
    fake.clearedAtScript.length = 0;
    fake.clearGate = null;
    fake.clearFails = false;
    fake.stopGate = null;
    fake.holdLoads = false;
    fake.loads.length = 0;
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
    // The session does not exist until the first window is made, so there is nothing to clear as the first run enters.
    expect(fake.cleared).toBe(0);
    fake.held[0]!.settle({ stdout: "" });
    await running;
    expect(fake.cleared).toBe(1);
    // A run that fails clears it as well.
    const failing = python.handleRuntimeRequest("python", { code: "2" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    fake.held[1]!.fail(new Error("boom"));
    await expect(failing).rejects.toThrow();
    // One as the second run entered, and one as it ended.
    expect(fake.cleared).toBe(3);
  });

  it("clears the session as a run enters, even when the last request left it cleared, and not as a check does", async () => {
    // What a worker wrote just before it was terminated can reach the session after the clearing that followed its run, so
    // the next run does not trust that clearing.
    const first = python.handleRuntimeRequest("python", { code: "1" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.settle({ stdout: "" });
    await first;
    const afterFirst = fake.cleared;
    const second = python.handleRuntimeRequest("python", { code: "2" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    expect(fake.clearedAtScript.at(-1)).toBeGreaterThan(afterFirst);
    fake.held[1]!.settle({ stdout: "" });
    await second;
    // A check runs only the fixed code, so it does not clear on entry.
    const afterSecond = fake.cleared;
    const check = python.handleRuntimeRequest("check", claim);
    await vi.waitFor(() => expect(fake.held).toHaveLength(3));
    expect(fake.clearedAtScript.at(-1)).toBe(afterSecond);
    fake.held[2]!.settle({ state: "verified" });
    await check;
  });

  it("ends a window that never finishes loading, and leaves the session free for the next request", async () => {
    const { LOAD_CEILING_MS } = await import("./draw-runtime");
    fake.holdLoads = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stuck = python.handleRuntimeRequest("python", { code: "1" });
      const outcome = stuck.then(
        () => "resolved",
        (error: Error) => error.message,
      );
      await vi.waitFor(() => expect(fake.loads).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(LOAD_CEILING_MS + 1);
      // setImmediate is not faked: if the request were still waiting, this would win.
      const first = await Promise.race([outcome, new Promise((resolve) => setImmediate(() => resolve("still waiting")))]);
      expect(first).toBe("runtime-load-timeout");
      expect(fake.windows[0]!.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    // The request left the session, so the next one is not held in the clearing that waits for the last user.
    fake.holdLoads = false;
    const next = python.handleRuntimeRequest("python", { code: "2" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.settle({ stdout: "" });
    await expect(next).resolves.toEqual({ stdout: "" });
  });

  it("keeps the window that is loading when an older window's load fails after it", async () => {
    fake.holdLoads = true;
    const run = python.handleRuntimeRequest("python", { code: "1" });
    const lost = run.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.waitFor(() => expect(fake.loads).toHaveLength(1));
    // The first window's renderer dies while it loads, and a request of the other lane opens a second one.
    fake.windows[0]!.destroy();
    const check = python.handleRuntimeRequest("check", claim);
    await vi.waitFor(() => expect(fake.loads).toHaveLength(2));
    expect(python.pythonTestHandle().loading()).toBe(true);
    // The first load fails now. The second window is still loading, and a caller must still wait for it.
    fake.loads[0]!.reject(new Error("load failed"));
    expect(await lost).toBe("load failed");
    expect(python.pythonTestHandle().loading()).toBe(true);
    fake.holdLoads = false;
    fake.loads[1]!.resolve();
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.settle({ state: "verified" });
    await expect(check).resolves.toEqual({ state: "verified" });
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

  it("does not make a window for a request that a disposal overtook while it waited for the storage to be cleared", async () => {
    const first = python.handleRuntimeRequest("check", claim);
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.settle({ state: "none" });
    await first;
    // The window ends and its clearing is slow; the next request waits for it.
    let finish: () => void = () => undefined;
    fake.clearGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fake.windows[0]!.destroy();
    const overtaken = python.handleRuntimeRequest("python", { code: "1" });
    await vi.waitFor(() => expect(fake.cleared).toBeGreaterThanOrEqual(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.windows).toHaveLength(1);
    // The runtime is disposed meanwhile (another workspace), and a request of the new generation is made.
    python.configurePythonRuntime("/workspace-b");
    const current = python.handleRuntimeRequest("python", { code: "2" });
    finish();
    await expect(overtaken).rejects.toThrow("runtime-disposed");
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    // One window was made after the disposal, for the new request. The one that was overtaken made none, so nothing it did
    // could clear the session under the new request, which is still running.
    expect(fake.windows).toHaveLength(2);
    expect(fake.windows[1]!.destroyed).toBe(false);
    expect(fake.cleared).toBe(fake.clearedAtScript.at(-1));
    fake.held[1]!.settle({ stdout: "" });
    await current;
  });

  it("starts no run on a session whose storage could not be cleared, keeps the result of the run that left it, and starts again once a clearing works", async () => {
    fake.clearFails = true;
    const first = python.handleRuntimeRequest("python", { code: "1" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.settle({ stdout: "one" });
    // The run that ended keeps its result, though its storage was not cleared.
    await expect(first).resolves.toEqual({ stdout: "one" });
    expect(fake.cleared).toBe(1);
    // The next run asks for the clearing again, and while it fails it does not start: the page's own notice for a
    // runtime that cannot be used is what it gets.
    await expect(python.handleRuntimeRequest("python", { code: "2" })).rejects.toThrow("runtime-unavailable");
    expect(fake.cleared).toBe(2);
    expect(fake.held).toHaveLength(1);
    // The clearing works again: the next run starts, on a session that was cleared.
    fake.clearFails = false;
    const third = python.handleRuntimeRequest("python", { code: "3" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    expect(fake.cleared).toBe(3);
    expect(fake.clearedAtScript.at(-1)).toBe(3);
    fake.held[1]!.settle({ stdout: "three" });
    await expect(third).resolves.toEqual({ stdout: "three" });
  });

  it("does not run a request in another workspace when the runtime was reconfigured while it waited to be admitted", async () => {
    const first = python.handleRuntimeRequest("check", claim);
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    // The check ends and its clearing is slow, so a request of the other lane waits to be admitted behind it.
    let finish: () => void = () => undefined;
    fake.clearGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fake.held[0]!.settle({ state: "none" });
    await vi.waitFor(() => expect(fake.cleared).toBe(1));
    const overtaken = python.handleRuntimeRequest("python", { code: "old" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.held).toHaveLength(1);
    // Another workspace is opened meanwhile.
    python.configurePythonRuntime("/workspace-b");
    finish();
    await expect(overtaken).rejects.toThrow("runtime-disposed");
    await first;
    // Its code was never sent to a page.
    expect(fake.scripts.some((script) => script.includes('"old"'))).toBe(false);
  });

  it("does not clear the session under a run that timed out before its worker has been stopped, and ends the window when the stop is never answered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let answer: () => void = () => undefined;
      fake.stopGate = new Promise<void>((resolve) => {
        answer = resolve;
      });
      const running = python.handleRuntimeRequest("python", { code: "while True: pass" });
      const outcome = running.then(() => "done", (error: Error) => error.message);
      await vi.waitFor(() => expect(fake.held).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(90_000);
      expect(fake.scripts.at(-1)).toMatch(/^window\.pyxisRuntime\.stop\(/);
      // The page has not stopped the worker yet: nothing is cleared, and the run is not over.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.cleared).toBe(0);
      answer();
      await vi.advanceTimersByTimeAsync(0);
      await expect(outcome).resolves.toBe("runtime-timeout");
      expect(fake.cleared).toBe(1);
      // A page that never answers the stop is ended after the wait a window has to load, so that nothing it issued can still
      // write when the clearing starts.
      fake.stopGate = new Promise<void>(() => undefined);
      const stuck = python.handleRuntimeRequest("python", { code: "1" });
      const stuckOutcome = stuck.then(() => "done", (error: Error) => error.message);
      await vi.waitFor(() => expect(fake.held.length).toBeGreaterThan(1));
      // The run cleared the session as it entered; from here to the end of the wait nothing does.
      const entered = fake.cleared;
      await vi.advanceTimersByTimeAsync(90_000);
      await vi.advanceTimersByTimeAsync(19_000);
      expect(fake.cleared).toBe(entered);
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(stuckOutcome).resolves.toBe("runtime-timeout");
      expect(fake.windows.at(-1)!.destroyed).toBe(true);
      expect(fake.cleared).toBeGreaterThan(entered);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clear the session while a request is still using it, and clears it when the last one ends", async () => {
    const running = python.handleRuntimeRequest("python", { code: "1" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    const checking = python.handleRuntimeRequest("check", claim);
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    // The check ends first, beside the run: the run's storage is not cleared under it.
    fake.held[1]!.settle({ state: "none" });
    await checking;
    expect(fake.cleared).toBe(0);
    // The run ends last, and then the session is cleared.
    fake.held[0]!.settle({ stdout: "" });
    await running;
    expect(fake.cleared).toBe(1);
  });

  it("starts no run on storage that an earlier request left while another was still using the session", async () => {
    const first = python.handleRuntimeRequest("python", { code: "1" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    const checking = python.handleRuntimeRequest("check", claim);
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    // The first run ends while the check is still on: nothing can be cleared yet, and the next run is asked for.
    fake.held[0]!.settle({ stdout: "" });
    await first;
    expect(fake.cleared).toBe(0);
    const next = python.handleRuntimeRequest("python", { code: "2" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // It has not started: its script has not been sent to the page.
    expect(fake.held).toHaveLength(2);
    // The check ends, the session is cleared, and only then does the next run start.
    fake.held[1]!.settle({ state: "none" });
    await checking;
    await vi.waitFor(() => expect(fake.held).toHaveLength(3));
    expect(fake.cleared).toBeGreaterThanOrEqual(1);
    expect(fake.clearedAtScript.at(-1)).toBeGreaterThanOrEqual(1);
    fake.held[2]!.settle({ stdout: "" });
    await next;
  });
});

describe("python runtime pack requests", () => {
  beforeEach(() => {
    downloadRuntime.mockClear();
    cancelRuntimeDownload.mockClear();
    removeRuntimePack.mockClear();
    fake.windows.length = 0;
    fake.held.length = 0;
    fake.scripts.length = 0;
    configurePythonRuntime("/workspace-a");
  });
  afterEach(() => disposePythonRuntime());

  it("starts, cancels and removes the packs a request names, and every pack when it names none", async () => {
    await handleRuntimeRequest("download", { packs: ["drawing"] });
    await handleRuntimeRequest("download", {});
    await handleRuntimeRequest("download", { packs: [] });
    expect(downloadRuntime.mock.calls).toEqual([["/workspace-a", ["drawing"]], ["/workspace-a", undefined], ["/workspace-a", undefined]]);
    await handleRuntimeRequest("cancel-download", { packs: ["pyodide"] });
    await handleRuntimeRequest("cancel-download", {});
    expect(cancelRuntimeDownload.mock.calls).toEqual([["/workspace-a", ["pyodide"]], ["/workspace-a", undefined]]);
    await handleRuntimeRequest("remove", { pack: "drawing" });
    expect(removeRuntimePack.mock.calls).toEqual([["/workspace-a", "drawing"]]);
    // A pack that is not one of the two is refused before anything is touched.
    await expect(handleRuntimeRequest("remove", { pack: "../x" })).rejects.toThrow();
    await expect(handleRuntimeRequest("download", { packs: ["nope"] })).rejects.toThrow();
    expect(removeRuntimePack).toHaveBeenCalledTimes(1);
  });

  it("shuts the Python window when Python is removed, and leaves it open when the drawing pack is", async () => {
    const running = handleRuntimeRequest("check", claim);
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.settle({ state: "none" });
    await running;
    expect(fake.windows[0]!.destroyed).toBe(false);
    await handleRuntimeRequest("remove", { pack: "drawing" });
    expect(fake.windows[0]!.destroyed).toBe(false);
    await handleRuntimeRequest("remove", { pack: "pyodide" });
    expect(fake.windows[0]!.destroyed).toBe(true);
  });
});
