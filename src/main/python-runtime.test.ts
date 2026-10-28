import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for Electron: windows never load anything, and each run/check the page is asked for stays pending until
// the test settles it, so a request can be held in flight while others queue behind it.
const fake = vi.hoisted(() => ({
  windows: [] as Array<{ destroyed: boolean; crashed: boolean; frame: { destroyed: boolean; detached: boolean } }>,
  held: [] as Array<{ script: string; settle: (value: unknown) => void; fail: (error: Error) => void }>,
  scripts: [] as string[],
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
    protocol: { handle: () => undefined },
    webRequest: { onBeforeRequest: () => undefined },
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
  };
  return {
    BrowserWindow: FakeWindow,
    session: { fromPartition: () => partition },
  };
});

const requireRuntime = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./runtime-pack", () => ({
  requireRuntime,
  runtimeManifest: { files: [] },
  cancelRuntimeDownload: () => undefined,
  currentRuntimeStatus: async () => ({}),
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
    requireRuntime.mockClear();
    configurePythonRuntime("/workspace-a");
  });
  afterEach(() => {
    disposePythonRuntime();
    vi.useRealTimers();
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
