import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for Electron: windows load nothing, and each drawing the page is asked for stays pending until the test
// settles it, so a request can be held in flight while others queue behind it, and the limits can be reached with the
// clock the test moves.
type FakeWindow = {
  id: number;
  options: { webPreferences: Record<string, unknown> };
  destroyed: boolean;
  crashed: boolean;
  pid: number;
  openHandler: (() => { action: string }) | undefined;
  guarded: string[];
  listeners: Map<string, Set<(...args: unknown[]) => void>>;
  contentsListeners: Map<string, (...args: unknown[]) => void>;
  loaded: string[];
  destroy: () => void;
};
const fake = vi.hoisted(() => ({
  windows: [] as FakeWindow[],
  partitions: [] as Array<{
    name: string;
    options: unknown;
    requestFilter?: (details: { url: string }, callback: (answer: { cancel: boolean }) => void) => void;
    permissionRequest?: (...args: unknown[]) => void;
    permissionCheck?: () => boolean;
    deviceCheck?: () => boolean;
    handled: string[];
    downloads: number;
    downloadBlocked: boolean;
    proxies: unknown[];
    cleared: number;
  }>,
  webrtc: [] as string[],
  held: [] as Array<{ script: string; settle: (value: unknown) => void; fail: (error: Error) => void }>,
  scripts: [] as string[],
  workingSetKb: 100_000,
  loadNever: false,
  nextId: 1,
  /** While set, clearing the session's storage does not finish until it resolves. */
  clearGate: null as Promise<void> | null,
}));

vi.mock("electron", () => {
  class Window {
    id = fake.nextId++;
    options: { webPreferences: Record<string, unknown> };
    destroyed = false;
    crashed = false;
    pid = 1000 + this.id;
    openHandler: (() => { action: string }) | undefined;
    guarded: string[] = [];
    listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    contentsListeners = new Map<string, (...args: unknown[]) => void>();
    loaded: string[] = [];
    frame = { isDestroyed: () => this.destroyed, detached: false };
    webContents = {
      setWindowOpenHandler: (handler: () => { action: string }) => {
        this.openHandler = handler;
      },
      setWebRTCIPHandlingPolicy: (policy: string) => {
        fake.webrtc.push(policy);
      },
      on: (name: string, listener: (...args: unknown[]) => void) => {
        this.contentsListeners.set(name, listener);
        if (name.startsWith("will-")) this.guarded.push(name);
      },
      isDestroyed: () => this.destroyed,
      isCrashed: () => this.crashed,
      getOSProcessId: () => this.pid,
      mainFrame: this.frame,
      executeJavaScript: (script: string) => {
        fake.scripts.push(script);
        return new Promise((resolve, reject) => fake.held.push({ script, settle: resolve, fail: reject }));
      },
    };
    constructor(options: { webPreferences: Record<string, unknown> }) {
      this.options = options;
      fake.windows.push(this as unknown as FakeWindow);
    }
    loadURL(url: string) {
      this.loaded.push(url);
      return fake.loadNever ? new Promise<void>(() => undefined) : Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    on(name: string, listener: (...args: unknown[]) => void) {
      this.once(name, listener);
    }
    once(name: string, listener: (...args: unknown[]) => void) {
      const set = this.listeners.get(name) ?? new Set();
      set.add(listener);
      this.listeners.set(name, set);
    }
    removeListener(name: string, listener: (...args: unknown[]) => void) {
      this.listeners.get(name)?.delete(listener);
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      for (const listener of [...(this.listeners.get("closed") ?? [])]) listener();
    }
  }
  const session = {
    fromPartition: (name: string, options: unknown) => {
      const partition: (typeof fake.partitions)[number] = {
        name,
        options,
        handled: [],
        downloads: 0,
        downloadBlocked: false,
        proxies: [],
        cleared: 0,
      };
      fake.partitions.push(partition);
      return {
        protocol: { handle: (scheme: string) => partition.handled.push(scheme) },
        setProxy: async (config: unknown) => {
          partition.proxies.push(config);
        },
        clearStorageData: async () => {
          partition.cleared++;
          await fake.clearGate;
        },
        webRequest: { onBeforeRequest: (filter: typeof partition.requestFilter) => (partition.requestFilter = filter) },
        setPermissionRequestHandler: (handler: (...args: unknown[]) => void) => (partition.permissionRequest = handler),
        setPermissionCheckHandler: (handler: () => boolean) => (partition.permissionCheck = handler),
        setDevicePermissionHandler: (handler: () => boolean) => (partition.deviceCheck = handler),
        on: (event: string, listener: (event: { preventDefault: () => void }) => void) => {
          if (event === "will-download") listener({ preventDefault: () => (partition.downloadBlocked = true) });
        },
      };
    },
  };
  return {
    BrowserWindow: Window,
    session,
    app: { getAppMetrics: () => fake.windows.map((window) => ({ pid: window.pid, memory: { workingSetSize: fake.workingSetKb } })) },
  };
});

const requireRuntime = vi.hoisted(() => vi.fn(async (_path: string, _pack?: string) => undefined));
const invalidatePack = vi.hoisted(() => vi.fn());
vi.mock("./runtime-pack", () => ({
  requireRuntime,
  invalidatePack,
  runtimePacks: {
    pyodide: { files: [{ name: "pyodide.js" }] },
    drawing: { files: [{ name: "graphviz.js" }, { name: "schemdraw.whl" }] },
  },
  verifiedRuntimeFile: async () => undefined,
}));

import {
  IMAGE_SIDE_MAX,
  LOAD_CEILING_MS,
  MEMORY_LIMIT_KB,
  MEMORY_POLL_MS,
  checkPng,
  readAnswer,
} from "./draw-runtime";
// The module keeps one session for the life of the app, so each test loads it again, to have a session of its own to look at.
type Draw = typeof import("./draw-runtime");
let configureDrawRuntime: Draw["configureDrawRuntime"];
let disposeDrawRuntime: Draw["disposeDrawRuntime"];
let handleDrawRequest: Draw["handleDrawRequest"];
import { styledDot } from "../shared/dot";
import { FIGURE_IMAGE_MAX } from "../shared/smart-text";

const DOT = "digraph { a -> b }";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A PNG data URL whose header says this size, which is all `checkPng` reads. */
function pngUrl(width = 100, height = 50, signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]): string {
  const bytes = Buffer.alloc(40);
  Buffer.from(signature).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
const good = { ok: true, png: pngUrl() };

describe("the drawing window", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ configureDrawRuntime, disposeDrawRuntime, handleDrawRequest } = (await import("./draw-runtime")) as Draw);
    fake.windows.length = 0;
    fake.partitions.length = 0;
    fake.webrtc.length = 0;
    invalidatePack.mockReset();
    fake.held.length = 0;
    fake.scripts.length = 0;
    fake.workingSetKb = 100_000;
    fake.loadNever = false;
    fake.clearGate = null;
    requireRuntime.mockReset();
    requireRuntime.mockImplementation(async () => undefined);
    configureDrawRuntime("/workspace-a");
  });
  afterEach(() => {
    disposeDrawRuntime();
    vi.useRealTimers();
  });

  it("is made hidden, sandboxed and isolated, with no Node, no preload and a session of its own that keeps nothing", async () => {
    const result = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    const [window] = fake.windows;
    expect(window!.options).toMatchObject({ show: false });
    expect(window!.options.webPreferences).toMatchObject({
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      webviewTag: false,
      devTools: false,
      allowRunningInsecureContent: false,
      disableDialogs: true,
    });
    expect(window!.options.webPreferences).not.toHaveProperty("preload");
    // No GPU for text that came from an AI.
    expect(window!.options.webPreferences).toMatchObject({ webgl: false });
    expect(window!.options.webPreferences).not.toHaveProperty("nodeIntegrationInWorker", true);
    // An in-memory partition: a name without `persist:`, and no cache.
    const [partition] = fake.partitions;
    expect(partition!.name).toBe("pyxis-draw");
    expect(partition!.name).not.toMatch(/^persist:/);
    expect(partition!.options).toEqual({ cache: false });
    expect(partition!.handled).toEqual(["pyxis-runtime"]);
    expect(window!.loaded).toEqual(["pyxis-runtime://draw/index.html"]);
    // The drawing is asked for with one call, and the answer is read as one value.
    expect(fake.scripts[0]).toBe(
      `window.pyxisDraw.draw(${JSON.stringify({ kind: "graph", code: styledDot(DOT), engine: "dot", timeoutMs: 5000 })})`,
    );
    // The graph's default look is in the text, ahead of the text's own statements.
    expect(styledDot(DOT).indexOf("graph [fontname")).toBeLessThan(styledDot(DOT).indexOf("a -> b"));
    fake.held[0]!.settle(good);
    await expect(result).resolves.toEqual({ image: good.png });
  });

  it("sends the network stack's own work to a proxy that is not there, and lets WebRTC use no UDP that does not go through it", async () => {
    const pending = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    // WebRTC, preconnect and DNS lookups do not pass the request filter: a SOCKS proxy at port 0 takes them, with
    // the loopback rule off so this machine's own addresses are not left out, and WebRTC is held to the proxy.
    expect(fake.partitions[0]!.proxies).toEqual([{ mode: "fixed_servers", proxyRules: "socks5://127.0.0.1:0", proxyBypassRules: "<-loopback>" }]);
    expect(fake.webrtc).toEqual(["disable_non_proxied_udp"]);
    // The session is locked before the window loads its page.
    expect(fake.windows[0]!.loaded).toEqual(["pyxis-runtime://draw/index.html"]);
    fake.held[0]!.settle(good);
    await pending;
  });

  it("makes one session for the life of the app, however many windows are replaced, and clears what it kept each time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    for (let round = 0; round < 100; round++) {
      // A window that runs over its time is destroyed, and the next request opens another.
      const slow = handleDrawRequest({ kind: "graph", code: DOT });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(slow).resolves.toMatchObject({ timedOut: true });
    }
    expect(fake.windows).toHaveLength(100);
    expect(fake.windows.every((window) => window.destroyed)).toBe(true);
    // One partition, one protocol handler, one filter, one proxy setting.
    expect(fake.partitions).toHaveLength(1);
    expect(fake.partitions[0]!.handled).toEqual(["pyxis-runtime"]);
    expect(fake.partitions[0]!.proxies).toHaveLength(1);
    // And what it kept for the windows that went was cleared each time.
    expect(fake.partitions[0]!.cleared).toBe(100);
    // A crash, a window that fails to load and a pack file that failed its check are replaced the same way.
    fake.windows.length = 0;
    const failing = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.advanceTimersByTimeAsync(0);
    fake.held.at(-1)!.settle({ ok: false, error: "runtime-draw-library-missing" });
    await failing;
    expect(fake.partitions).toHaveLength(1);
  });

  it("does not trust the drawing pack again when a window could not load a file of it, so no window is opened for a damaged pack", async () => {
    const drawing = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.settle({ ok: false, error: "runtime-draw-library-missing" });
    await expect(drawing).resolves.toEqual({ error: "runtime-draw-library-missing" });
    expect(invalidatePack).toHaveBeenCalledWith("/workspace-a", "drawing");
    // The pack is looked at again: with a file that fails its hash it is not ready, and the request fails with no window.
    requireRuntime.mockRejectedValueOnce(new Error("runtime-missing"));
    const windows = fake.windows.length;
    expect(await handleDrawRequest({ kind: "graph", code: DOT })).toEqual({ error: "runtime-missing" });
    expect(fake.windows).toHaveLength(windows);
  });

  it("does not use a window whose renderer is gone, even when no event said so", async () => {
    const first = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.settle(good);
    await first;
    expect(fake.windows).toHaveLength(1);
    // Electron can report a dead renderer before it fires an event: the window is destroyed and the next request opens
    // another, and never sends its script to the dead one.
    fake.windows[0]!.crashed = true;
    const second = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    expect(fake.windows).toHaveLength(2);
    expect(fake.windows[0]!.destroyed).toBe(true);
    expect(fake.windows[1]!.destroyed).toBe(false);
    fake.held[1]!.settle(good);
    await expect(second).resolves.toEqual({ image: good.png });
    // The same for a frame that is detached.
    (fake.windows[1] as unknown as { frame: { detached: boolean } }).frame.detached = true;
    const third = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(3));
    expect(fake.windows).toHaveLength(3);
    fake.held[2]!.settle(good);
    await third;
  });

  it("refuses at the session every request that is not one of its own files, and every permission, download and navigation", async () => {
    const pending = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    const [partition] = fake.partitions;
    const cancelled = (url: string) => {
      let answer: { cancel: boolean } | undefined;
      partition!.requestFilter!({ url }, (value) => (answer = value));
      return answer!.cancel;
    };
    // Its own page, its own script and the drawing pack's JavaScript.
    for (const url of [
      "pyxis-runtime://draw/index.html",
      "pyxis-runtime://draw/draw-host.js",
      "pyxis-runtime://draw/drawing/graphviz.js",
    ])
      expect(cancelled(url), url).toBe(false);
    // The network of every kind, files, other hosts of the scheme, other files of the pack, and anything unexpected.
    for (const url of [
      "http://127.0.0.1:8080/x",
      "https://example.com/",
      "ws://127.0.0.1/",
      "wss://example.com/",
      "ftp://example.com/x",
      "file:///etc/passwd",
      "file:///C:/Windows/win.ini",
      "data:text/html,<script>1</script>",
      "blob:pyxis-runtime://draw/abc",
      "about:blank",
      "chrome://gpu",
      "devtools://devtools/bundled/inspector.html",
      "pyxis-runtime://sandbox/host.js",
      "pyxis-runtime://sandbox/pyodide/pyodide.js",
      "pyxis-runtime://draw/drawing/schemdraw.whl",
      "pyxis-runtime://draw/pyodide/pyodide.js",
      "pyxis-runtime://draw/draw-host.js?x=1",
      "pyxis-runtime://draw/draw-host.js#x",
      "pyxis-runtime://user:password@draw/draw-host.js",
      "pyxis-runtime://draw:8080/draw-host.js",
      "pyxis-runtime://draw/drawing/%2e%2e/%2e%2e/etc/passwd",
      "pyxis-runtime://draw/draw-host%2ejs",
      "pyxis-runtime://draw/drawing%2fgraphviz.js",
      "pyxis-runtime://draw/drawing/../drawing/graphviz.js/x",
      "pyxis-runtime://draw/drawing/other.js",
      "pyxis-app://app/index.html",
      "pyxis-blob://blob/x",
      "not a url",
      "",
    ])
      expect(cancelled(url), url).toBe(true);
    // Permissions, devices and downloads are refused.
    const answers: boolean[] = [];
    partition!.permissionRequest!({}, "geolocation", (granted: boolean) => answers.push(granted));
    expect(answers).toEqual([false]);
    expect(partition!.permissionCheck!()).toBe(false);
    expect(partition!.deviceCheck!()).toBe(false);
    expect(partition!.downloadBlocked).toBe(true);
    // The window opens no window and follows no navigation, redirect or frame navigation.
    const [window] = fake.windows;
    expect(window!.openHandler!()).toEqual({ action: "deny" });
    expect([...window!.guarded].sort()).toEqual(["will-frame-navigate", "will-navigate", "will-redirect"]);
    for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
      const event = { preventDefault: vi.fn() };
      window!.contentsListeners.get(name)!(event);
      expect(event.preventDefault, name).toHaveBeenCalled();
    }
    fake.held[0]!.settle(good);
    await pending;
  });

  it("answers one drawing at a time, in the order asked, and starts the next when the one before has answered", async () => {
    const first = handleDrawRequest({ kind: "graph", code: "digraph { a -> b }" });
    const second = handleDrawRequest({ kind: "graph", code: "digraph { c -> d }" });
    const third = handleDrawRequest({ kind: "graph", code: "digraph { e -> f }" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    await tick();
    expect(fake.held).toHaveLength(1);
    fake.held[0]!.settle({ ok: true, png: pngUrl(10, 10) });
    await expect(first).resolves.toEqual({ image: pngUrl(10, 10) });
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    expect(fake.scripts[1]).toContain("c -> d");
    expect(fake.held).toHaveLength(2);
    fake.held[1]!.settle({ ok: true, png: pngUrl(20, 20) });
    await vi.waitFor(() => expect(fake.held).toHaveLength(3));
    expect(fake.scripts[2]).toContain("e -> f");
    fake.held[2]!.settle({ ok: false, error: "syntax error in line 1" });
    await expect(second).resolves.toEqual({ image: pngUrl(20, 20) });
    await expect(third).resolves.toEqual({ error: "syntax error in line 1" });
    // One window drew all three.
    expect(fake.windows).toHaveLength(1);
  });

  it("stops a drawing that runs over its time by destroying the window, and gives the next request a new one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const slow = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.held).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fake.windows[0]!.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(slow).resolves.toEqual({
      error: "the drawing ran longer than 5 seconds: draw fewer nodes and edges",
      timedOut: true,
    });
    expect(fake.windows[0]!.destroyed).toBe(true);
    // A late answer from the dead page changes nothing.
    fake.held[0]!.settle(good);
    const next = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.windows).toHaveLength(2);
    expect(fake.windows[1]!.destroyed).toBe(false);
    // The session is the same one: a session is never freed, so a window that is replaced must not make another.
    expect(fake.partitions).toHaveLength(1);
    fake.held[1]!.settle(good);
    await expect(next).resolves.toEqual({ image: good.png });
  });

  it("holds every drawing to its kind's limit, whatever the request asks for, and a test can ask for less", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const longer = handleDrawRequest({ kind: "graph", code: DOT, timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.scripts[0]).toContain('"timeoutMs":5000');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(longer).resolves.toMatchObject({ timedOut: true });
    const shorter = handleDrawRequest({ kind: "graph", code: DOT, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.scripts[1]).toContain('"timeoutMs":50');
    await vi.advanceTimersByTimeAsync(50);
    await expect(shorter).resolves.toEqual({
      error: "the drawing ran longer than 0.05 seconds: draw fewer nodes and edges",
      timedOut: true,
    });
  });

  it("reads the window's memory while it draws, and destroys it above the limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    expect(MEMORY_LIMIT_KB).toBe(512 * 1024);
    const drawing = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.advanceTimersByTimeAsync(0);
    // Under the limit it is left alone, however long the polls go on.
    fake.workingSetKb = MEMORY_LIMIT_KB;
    await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS * 4);
    expect(fake.windows[0]!.destroyed).toBe(false);
    // A reading over it, at the next poll, ends the drawing.
    fake.workingSetKb = MEMORY_LIMIT_KB + 1;
    await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS);
    await expect(drawing).resolves.toEqual({ error: "the drawing used too much memory: draw fewer nodes and edges" });
    expect(fake.windows[0]!.destroyed).toBe(true);
    // The next request is drawn in a new window, which is not read as the old one was.
    fake.workingSetKb = 100_000;
    const next = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.windows).toHaveLength(2);
    fake.held[1]!.settle(good);
    await expect(next).resolves.toEqual({ image: good.png });
  });

  it("stops polling when the drawing is over", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const drawing = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.advanceTimersByTimeAsync(0);
    fake.held[0]!.settle(good);
    await drawing;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces a window whose renderer crashed, whether it died during a drawing or between two", async () => {
    const running = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    // The pending call is rejected as the renderer goes, before the window closes.
    fake.windows[0]!.crashed = true;
    fake.held[0]!.fail(new Error("Render frame was disposed before the request completed"));
    await expect(running).resolves.toEqual({ error: "runtime-draw-crashed" });
    fake.windows[0]!.contentsListeners.get("render-process-gone")!();
    expect(fake.windows[0]!.destroyed).toBe(true);
    // Between two drawings, nothing is held and the window is gone: the next request opens another.
    const next = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    expect(fake.windows).toHaveLength(2);
    fake.held[1]!.settle(good);
    await expect(next).resolves.toEqual({ image: good.png });
    // A window that closed while a drawing was on is a crash too.
    const closing = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(3));
    fake.windows[1]!.destroy();
    await expect(closing).resolves.toEqual({ error: "runtime-draw-crashed" });
  });

  it("clears the storage of every window that ends, however it ended, and once", async () => {
    const cleared = () => fake.partitions[0]!.cleared;
    // A crash found by the rejected call, which comes before the window's own events: retired at once, and not again when
    // the events follow.
    const running = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.windows[0]!.crashed = true;
    fake.held[0]!.fail(new Error("Render frame was disposed before the request completed"));
    await expect(running).resolves.toEqual({ error: "runtime-draw-crashed" });
    expect(fake.windows[0]!.destroyed).toBe(true);
    fake.windows[0]!.contentsListeners.get("render-process-gone")!();
    await vi.waitFor(() => expect(cleared()).toBe(1));
    // A renderer that dies between two drawings: the event alone retires the window.
    const idle = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    fake.held[1]!.settle(good);
    await idle;
    fake.windows[1]!.contentsListeners.get("render-process-gone")!();
    expect(fake.windows[1]!.destroyed).toBe(true);
    await vi.waitFor(() => expect(cleared()).toBe(2));
    // A window that closed on its own.
    const last = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(3));
    fake.held[2]!.settle(good);
    await last;
    fake.windows[2]!.destroy();
    await vi.waitFor(() => expect(cleared()).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cleared()).toBe(3);
  });

  it("does not open the next window until the storage of the one that ended has been cleared", async () => {
    const first = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.settle(good);
    await first;
    // The clearing is slow: the window ends, and the next drawing has to wait for it.
    let finish: () => void = () => undefined;
    fake.clearGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fake.windows[0]!.contentsListeners.get("render-process-gone")!();
    const second = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.partitions[0]!.cleared).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.windows).toHaveLength(1);
    expect(fake.held).toHaveLength(1);
    finish();
    await vi.waitFor(() => expect(fake.windows).toHaveLength(2));
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    fake.held[1]!.settle(good);
    await expect(second).resolves.toEqual({ image: good.png });
  });

  it("gives up on a window that does not load its page, and destroys it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    fake.loadNever = true;
    const opening = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.advanceTimersByTimeAsync(LOAD_CEILING_MS - 1);
    expect(fake.windows[0]!.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(opening).resolves.toEqual({ error: "runtime-draw-load-timeout" });
    expect(fake.windows[0]!.destroyed).toBe(true);
    expect(fake.scripts).toEqual([]);
  });

  it("answers with a picture or a short plain failure, and nothing else of what the page sends", async () => {
    const png = pngUrl(300, 200);
    expect(readAnswer({ ok: true, png })).toEqual({ image: png });
    expect(readAnswer({ ok: false, error: "syntax error in line 1" })).toEqual({ error: "syntax error in line 1" });
    // A failure is plain text of a bounded length, with its control characters gone. It is cut to 500 characters first.
    const long = `bad\u0000\u001b[31m\nline\u007f${"x".repeat(900)}`;
    expect(readAnswer({ ok: false, error: long })).toEqual({
      // eslint-disable-next-line no-control-regex -- control characters are what this removes
      error: long.slice(0, 500).replace(/[\u0000-\u001f\u007f]+/g, " ").trim(),
    });
    expect(readAnswer({ ok: false, error: "" })).toEqual({ error: "the drawing failed" });
    // What the page sends is cut before anything is done to it, so a huge message costs no more than a short one.
    const started = Date.now();
    const answered = readAnswer({ ok: false, error: `${"\u0000".repeat(60_000_000)}the end` });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(answered).toEqual({ error: "the drawing failed" });
    expect(readAnswer({ ok: false, error: `${"x".repeat(499)}\u0000tail beyond the cut` })).toEqual({ error: "x".repeat(499) });
    expect(readAnswer({ ok: false, error: { toString: () => "x" } })).toEqual({ error: "the drawing failed" });
    // Anything else is no answer.
    for (const value of [undefined, null, "", "ok", 7, [], [good], { ok: "yes", png }, { png }, { ok: 1 }, new Date()])
      expect(readAnswer(value), JSON.stringify(value)).toEqual({ error: "runtime-draw-answer-invalid" });
    // Extra keys are not carried on.
    expect(readAnswer({ ok: true, png, html: "<script>1</script>", url: "http://x" })).toEqual({ image: png });
  });

  it("accepts only a PNG data URL of bounded size, with a PNG header, of a size in pixels that makes sense", () => {
    expect(checkPng(pngUrl(1, 1))).not.toBeNull();
    expect(checkPng(pngUrl(IMAGE_SIDE_MAX, IMAGE_SIDE_MAX))).not.toBeNull();
    for (const [name, value] of Object.entries({
      "too wide": pngUrl(IMAGE_SIDE_MAX + 1, 10),
      "too tall": pngUrl(10, IMAGE_SIDE_MAX + 1),
      "no width": pngUrl(0, 10),
      "no height": pngUrl(10, 0),
      "a JPEG signature": pngUrl(10, 10, [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]),
      "an SVG data URL": "data:image/svg+xml;base64,PHN2Zy8+",
      "an SVG with markup": `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>`,
      "an HTML data URL": "data:text/html;base64,PHNjcmlwdD4xPC9zY3JpcHQ+",
      "a remote URL": "http://127.0.0.1/x.png",
      "a file URL": "file:///etc/passwd",
      "a blob URL": "blob:pyxis-runtime://draw/abc",
      "markup": "<img src=x onerror=alert(1)>",
      "a data URL with something after it": `${pngUrl()}"><script>1</script>`,
      "a data URL with a parameter": pngUrl().replace("image/png", "image/png;charset=utf-8"),
      "no payload": "data:image/png;base64,",
      "not base64": "data:image/png;base64,@@@@",
      "a short body": "data:image/png;base64,iVBORw0KGgo=",
      "a number": 7,
      "an object": { toString: () => pngUrl() },
      "null": null,
    }))
      expect(checkPng(value), name).toBeNull();
    // Too large to store: longer than a stored figure may be.
    const huge = `data:image/png;base64,${Buffer.concat([Buffer.from(pngUrl().split(",")[1]!, "base64"), Buffer.alloc(FIGURE_IMAGE_MAX)]).toString("base64")}`;
    expect(huge.length).toBeGreaterThan(FIGURE_IMAGE_MAX);
    expect(checkPng(huge)).toBeNull();
  });

  it("turns a bad answer from the page into a failure, and leaves the window as it is", async () => {
    const drawing = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.settle({ ok: true, png: "data:image/svg+xml;base64,PHN2Zy8+" });
    await expect(drawing).resolves.toEqual({
      error: "the drawing did not come back as a picture, or it is too large: make the graph smaller",
    });
    expect(fake.windows[0]!.destroyed).toBe(false);
  });

  it("replaces a window whose library did not load, because that window would not try the file again", async () => {
    const drawing = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.settle({ ok: false, error: "runtime-draw-library-missing" });
    await expect(drawing).resolves.toEqual({ error: "runtime-draw-library-missing" });
    expect(fake.windows[0]!.destroyed).toBe(true);
    const next = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    expect(fake.windows).toHaveLength(2);
    fake.held[1]!.settle(good);
    await expect(next).resolves.toEqual({ image: good.png });
  });

  it("checks the request again, and opens no window for one that fails the check or is not a graph", async () => {
    for (const code of [
      'digraph { a [image="/etc/passwd"] }',
      'digraph { a [URL="https://example.com"] }',
      "digraph { a [label=<<b>x</b>>] }",
      "digraph { layout=sfdp; a }",
      `digraph { ${Array.from({ length: 151 }, (_, i) => `n${i}`).join("; ")} }`,
    ])
      expect(await handleDrawRequest({ kind: "graph", code }), code).toEqual({
        error: expect.stringMatching(/not allowed|keep it within/),
      });
    for (const payload of [null, {}, { kind: "graph" }, { kind: "graph", code: "" }, { kind: "graph", code: 7 }, { kind: "molecule", code: "CCO" }, { kind: "graph", code: DOT, timeoutMs: "slow" }, "digraph {}"])
      expect(await handleDrawRequest(payload), JSON.stringify(payload)).toEqual({ error: "runtime-draw-input-invalid" });
    expect(fake.windows).toHaveLength(0);
    expect(requireRuntime).not.toHaveBeenCalled();
    // A test that needs the window to see text the check refuses can skip only that check.
    const drawing = handleDrawRequest({ kind: "graph", code: 'digraph { a [image="/etc/passwd"] }' }, undefined, { unchecked: true });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.settle(good);
    await expect(drawing).resolves.toEqual({ image: good.png });
  });

  it("gives the layout engine the text asks for, and only one of the five", async () => {
    const drawing = handleDrawRequest({ kind: "graph", code: "digraph { layout=circo; a -> b }" });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    expect(fake.scripts[0]).toContain('"engine":"circo"');
    fake.held[0]!.settle(good);
    await drawing;
  });

  it("fails as the runtime's, with no window, when the drawing pack is not there", async () => {
    requireRuntime.mockRejectedValue(new Error("runtime-missing"));
    expect(await handleDrawRequest({ kind: "graph", code: DOT })).toEqual({ error: "runtime-missing" });
    expect(requireRuntime).toHaveBeenCalledWith("/workspace-a", "drawing");
    expect(fake.windows).toHaveLength(0);
    requireRuntime.mockRejectedValue(new Error("disk on fire"));
    expect(await handleDrawRequest({ kind: "graph", code: DOT })).toEqual({ error: "runtime-draw-failed" });
  });

  it("does not open a window for requests queued when the runtime is disposed, or whose requester has given up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const running = handleDrawRequest({ kind: "graph", code: DOT }, Date.now() + 120_000);
    const late = handleDrawRequest({ kind: "graph", code: DOT }, Date.now() + 120_000);
    const queued = handleDrawRequest({ kind: "graph", code: DOT }, Date.now() + 120_000);
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    vi.setSystemTime(Date.now() + 121_000);
    fake.held[0]!.settle(good);
    await expect(running).resolves.toEqual({ image: good.png });
    await expect(late).resolves.toEqual({ error: "runtime-expired" });
    await expect(queued).resolves.toEqual({ error: "runtime-expired" });
    expect(fake.held).toHaveLength(1);
    // Disposed while one waits (a backup, a restore, a move, a wipe or the quit): it never runs, and the window is gone.
    const first = handleDrawRequest({ kind: "graph", code: DOT });
    const second = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    disposeDrawRuntime();
    expect(fake.windows[0]!.destroyed).toBe(true);
    await expect(first).resolves.toEqual({ error: "runtime-draw-crashed" });
    await expect(second).resolves.toEqual({ error: "runtime-disposed" });
    expect(fake.held).toHaveLength(2);
  });

  it("is not given a workspace until it is configured, and starts afresh for another", async () => {
    disposeDrawRuntime();
    configureDrawRuntime("");
    expect(await handleDrawRequest({ kind: "graph", code: DOT })).toEqual({ error: "runtime-workspace-missing" });
    configureDrawRuntime("/workspace-b");
    const drawing = handleDrawRequest({ kind: "graph", code: DOT });
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    expect(requireRuntime).toHaveBeenLastCalledWith("/workspace-b", "drawing");
    configureDrawRuntime("/workspace-c");
    expect(fake.windows[0]!.destroyed).toBe(true);
    await expect(drawing).resolves.toEqual({ error: "runtime-draw-crashed" });
  });
});
