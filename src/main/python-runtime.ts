import { BrowserWindow, session, type Session } from "electron";
import { checkClaimSchema, gradeCheckSchema } from "../shared/math-check";
import {
  cancelRuntimeDownload,
  currentRuntimeStatus,
  downloadRuntime,
  requireRuntime,
  runtimePacks,
} from "./runtime-pack";
import { handleDrawRequest } from "./draw-runtime";
import { registerRuntimeProtocol, runtimeOrigin, runtimeResourceName } from "./runtime-protocol";
import { lockSession, lockWindow, rendererGone } from "./runtime-window";

const ORIGIN = runtimeOrigin("sandbox");
let workspace = "";
let window: BrowserWindow | null = null;
let opening: Promise<BrowserWindow> | null = null;
let generation = 0;
let partition: Promise<Session> | null = null;
/** The clearing of the session's storage that was asked for last. A window is not opened until it has finished. */
let clearing: Promise<void> = Promise.resolve();
const retired = new WeakSet<BrowserWindow>();

/**
 * The one session of the Python windows, made when the first window is. Electron never frees a session, so a session per
 * window would add a browser context, a protocol handler and a request filter to the main process each time a window is
 * replaced after a timeout or a crash. The protocol reads the workspace when it serves. The session is in memory (no
 * `persist:`), and its storage is cleared after every request and when a window ends, so nothing the student's code
 * leaves in it (the Cache API, IndexedDB, OPFS, a service worker) reaches the next run.
 */
function pythonSession(): Promise<Session> {
  partition ??= (async () => {
    const created = session.fromPartition("pyxis-python", { cache: false });
    registerRuntimeProtocol(created, () => workspace, ["sandbox"]);
    await lockSession(created, (url) => Boolean(runtimeResourceName(url, "sandbox")));
    return created;
  })();
  partition.catch(() => {
    partition = null;
  });
  return partition;
}

/**
 * Wipes what the session kept. The clearings run one after the other, and the next window waits for the last one. Failing
 * to wipe is not a reason to fail the request that ran.
 */
function clearSession(): Promise<void> {
  const before = clearing;
  clearing = (async () => {
    await before;
    await partition?.then((owned) => owned.clearStorageData()).catch(() => undefined);
  })();
  return clearing;
}

/** Ends a window, and clears what the session kept for it. A window ends once: its own `closed` event comes here again. */
function retire(target: BrowserWindow): void {
  if (retired.has(target)) return;
  retired.add(target);
  if (window === target) {
    window = null;
    opening = null;
  }
  if (!target.isDestroyed()) target.destroy();
  void clearSession();
}

export function configurePythonRuntime(path: string): void {
  if (workspace !== path) {
    disposePythonRuntime();
    workspace = path;
  }
}
/** A handle for the end-to-end tests, which reach it through `app.evaluate`; only a run with PYXIS_E2E=1 installs it. */
export function pythonTestHandle() {
  return {
    windows: () => (window && !window.isDestroyed() ? [window.id] : []),
    /** Runs a script in the Python window's page, as code in that page would. */
    evaluate: (script: string) => {
      if (!window || window.isDestroyed()) throw new Error("no Python window is open");
      return window.webContents.executeJavaScript(script);
    },
  };
}
export function disposePythonRuntime(): void {
  generation++;
  if (window) retire(window);
  window = null;
  opening = null;
}
async function sandbox(): Promise<BrowserWindow> {
  if (!workspace) throw new Error("runtime-workspace-missing");
  const epoch = generation;
  const path = workspace;
  // Running code never downloads; the explicit runtime job does that.
  await requireRuntime(path);
  if (epoch !== generation) throw new Error("runtime-disposed");
  if (opening) return opening;
  if (window && !window.isDestroyed()) return window;
  opening = (async () => {
    const owned = await pythonSession();
    // The storage of the window that ended is cleared before the next one opens in the same session.
    await clearing;
    const created = new BrowserWindow({
      show: false,
      webPreferences: {
        session: owned,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    window = created;
    lockWindow(created);
    created.on("closed", () => retire(created));
    // A crashed renderer is replaced by a fresh window on the next request.
    created.webContents.on("render-process-gone", () => retire(created));
    try {
      await created.loadURL(ORIGIN + "index.html");
      if (epoch !== generation || created.isDestroyed())
        throw new Error("runtime-disposed");
      window = created;
      return created;
    } catch (error) {
      retire(created);
      if (epoch === generation) opening = null;
      throw error;
    }
  })();
  return opening;
}
const tails: Record<"run" | "check", Promise<unknown>> = {
  run: Promise.resolve(),
  check: Promise.resolve(),
};
// One request per lane at a time, so the ceiling below starts when the request
// itself runs and its stop can only reach the operation it started. A request
// waiting its turn is dropped, not run, when the runtime was disposed since it
// was queued (backup, restore, move, wipe, quit) or when its requester's
// `deadline` has passed, so queued work never opens the sandbox again or runs
// for a caller that already gave up.
function execute(
  operation: "run" | "check",
  payload: unknown,
  timeoutMs?: number,
  deadline?: number,
  method: "run" | "check" | "grade" = operation,
): Promise<unknown> {
  const epoch = generation;
  const turn = tails[operation].then(() => {
    if (epoch !== generation) throw new Error("runtime-disposed");
    if (deadline !== undefined && Date.now() >= deadline)
      throw new Error("runtime-expired");
    return dispatch(operation, payload, timeoutMs, method);
  });
  tails[operation] = turn.catch(() => undefined);
  return turn;
}
/**
 * The wheels of the drawing pack, which a Python run installs before its code, so circuits can import schemdraw. None
 * while the pack is not downloaded: Python runs the same without it.
 */
async function drawingWheels(): Promise<string[]> {
  const status = await currentRuntimeStatus(workspace);
  return status.packs.drawing === "ready"
    ? runtimePacks.drawing.files
        .filter((file) => file.name.endsWith(".whl"))
        .map((file) => `drawing/${file.name}`)
    : [];
}
// Covers booting Pyodide (host.js allows 60 s) plus the run itself (at most 11 s). Old Intel Macs take over a minute to boot.
const RUN_CEILING_MS = 90000;
async function dispatch(
  operation: "run" | "check",
  payload: unknown,
  timeoutMs: number | undefined,
  method: "run" | "check" | "grade",
): Promise<unknown> {
  const target = await sandbox();
  if (target.isDestroyed()) throw new Error("runtime-crashed");
  const extra =
    operation === "run"
      ? `, ${timeoutMs}, ${JSON.stringify(await drawingWheels())}`
      : "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onClosed: (() => void) | undefined;
  try {
    return await Promise.race([
      target.webContents
        .executeJavaScript(
          `window.pyxisRuntime.${method}(${JSON.stringify(payload)}${extra})`,
        )
        .catch((error: unknown) => {
          // Since Electron 45 a renderer that dies rejects the pending call at once ("Render frame was disposed before
          // the request completed"), before the window closes. A call that fails with the renderer gone crashed.
          if (rendererGone(target)) throw new Error("runtime-crashed");
          throw error;
        }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          void target.webContents
            .executeJavaScript(
              `window.pyxisRuntime.stop(${JSON.stringify(operation === "run" ? "python" : "check")})`,
            )
            .catch(() => undefined);
          reject(new Error("runtime-timeout"));
        }, RUN_CEILING_MS);
      }),
      new Promise((_, reject) => {
        onClosed = () => reject(new Error("runtime-crashed"));
        target.once("closed", onClosed);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onClosed) target.removeListener("closed", onClosed);
    await clearSession();
  }
}
export async function handleRuntimeRequest(
  operation: string,
  payload: unknown,
  deadline?: number,
): Promise<unknown> {
  if (operation === "status") return currentRuntimeStatus(workspace);
  if (operation === "download") {
    if (!workspace) throw new Error("runtime-workspace-missing");
    await downloadRuntime(workspace);
    return currentRuntimeStatus(workspace);
  }
  if (operation === "cancel-download") {
    cancelRuntimeDownload(workspace);
    return {};
  }
  if (operation === "check") {
    try {
      return await execute(
        "check",
        checkClaimSchema.parse(payload),
        undefined,
        deadline,
      );
    } catch {
      return { state: "none", reason: "runtime-unavailable" };
    }
  }
  // Grading shares the check lane: one SymPy worker, one request at a time.
  if (operation === "grade") {
    try {
      return await execute(
        "check",
        gradeCheckSchema.parse(payload),
        undefined,
        deadline,
        "grade",
      );
    } catch {
      return { state: "none", reason: "runtime-unavailable" };
    }
  }
  // The drawing window draws what is not Python. It is a lane of its own, with its own queue.
  if (operation === "draw") return handleDrawRequest(payload, deadline);
  if (operation === "python") {
    if (
      !payload ||
      typeof payload !== "object" ||
      !("code" in payload) ||
      typeof payload.code !== "string" ||
      payload.code.length > 200000
    )
      throw new Error("python-input-invalid");
    const requested =
      "timeoutMs" in payload && typeof payload.timeoutMs === "number"
        ? payload.timeoutMs
        : 10000;
    return execute(
      "run",
      payload.code,
      Math.max(100, Math.min(10000, requested)),
      deadline,
    );
  }
  throw new Error("runtime-operation-invalid");
}
