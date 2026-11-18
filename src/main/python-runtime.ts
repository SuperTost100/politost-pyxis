import { BrowserWindow, session, type Session } from "electron";
import { z } from "zod";
import { runtimePackIds, type PackId } from "../shared/figure-kinds";
import { checkClaimSchema, gradeCheckSchema } from "../shared/math-check";
import {
  cancelRuntimeDownload,
  currentRuntimeStatus,
  downloadRuntime,
  removeRuntimePack,
  requireRuntime,
  runtimePacks,
} from "./runtime-pack";
import { disposeDrawRuntime, handleDrawRequest, LOAD_CEILING_MS } from "./draw-runtime";
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
 * Wipes what the session kept, and says whether it did. The clearings run one after the other, and the next window waits
 * for the last one. Failing to wipe is not a reason to fail the request that ran, but the session is `stale` from then
 * on: no run starts on it until a clearing has worked.
 */
function clearSession(): Promise<boolean> {
  const before = clearing;
  const done = (async () => {
    await before;
    try {
      await partition?.then((owned) => owned.clearStorageData());
      return true;
    } catch {
      stale = true;
      return false;
    }
  })();
  clearing = done.then(() => undefined);
  return done;
}

/**
 * The requests using the session now. The run lane and the check lane are two lanes of one window, so a request can end
 * while another is still running in the same session, and clearing then would take storage from the one that is not
 * done. `stale` says that the session may hold what a request left and nobody has cleared it yet.
 */
let users = 0;
let stale = false;
let draining: Promise<void> | null = null;
const idle: Array<() => void> = [];

/**
 * Clears the session once nobody is using it. A request that starts meanwhile waits for it, so it neither starves the
 * clearing nor meets it halfway.
 */
function drain(): Promise<void> {
  draining ??= (async () => {
    while (users > 0) await new Promise<void>((resolve) => idle.push(resolve));
    if (await clearSession()) stale = false;
  })().finally(() => {
    draining = null;
  });
  return draining;
}

/**
 * A request starts using the session. A run never starts on what an earlier request left: it waits for a clearing of its
 * own, and where the clearing fails it is refused as the runtime that cannot be used, which the pages already say. The
 * clearing after the last request is not enough for that: a worker that was ended wrote to the storage a moment before,
 * and a write that was already on its way can reach it after that clearing. A check runs the app's own code, which does
 * not write there, so it enters without one.
 */
async function enter(operation: "run" | "check"): Promise<void> {
  while (draining) await draining;
  if (operation === "run") {
    await drain();
    if (stale) throw new Error("runtime-unavailable");
  }
  users++;
}

/** A request is done with the session, which is cleared when it was the last one using it. */
async function leave(): Promise<void> {
  users--;
  stale = true;
  if (users > 0) return;
  for (const resolve of idle.splice(0)) resolve();
  await drain();
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
/**
 * What the last requests did and when (epoch milliseconds): made (`queued`, which includes the wait behind the requests
 * of its lane that came first), past that wait and the clearing of the session (`entered`), the window ready (`opened`),
 * answered or failed (`ended`, with `outcome`), the clearing after it done (`left`). A request that is still running has
 * no `ended`, so a test that gives up on a slow run can tell which step it was waiting in. One dropped before its turn
 * (`runtime-disposed`, `runtime-expired`) has an `ended` and no `entered`.
 */
type RequestRecord = {
  operation: "run" | "check";
  method: string;
  queued: number;
  entered?: number;
  opened?: number;
  ended?: number;
  left?: number;
  outcome?: string;
};
const records: RequestRecord[] = [];
const RECORDS_KEPT = 8;
function startRecord(operation: "run" | "check", method: string): RequestRecord {
  const record: RequestRecord = { operation, method, queued: Date.now() };
  records.push(record);
  if (records.length > RECORDS_KEPT) records.shift();
  return record;
}
function endRecord(record: RequestRecord, error?: unknown): void {
  record.ended ??= Date.now();
  record.outcome ??= error === undefined ? "ok" : error instanceof Error ? error.message : String(error);
}

/** A handle for the end-to-end tests, which reach it through `app.evaluate`; only a run with PYXIS_E2E=1 installs it. */
export function pythonTestHandle() {
  return {
    requests: () => records.map((record) => ({ ...record })),
    windows: () => (window && !window.isDestroyed() ? [window.id] : []),
    /** Whether a window is being opened, which a request that comes meanwhile waits for. */
    loading: () => opening !== null,
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
  let mine!: Promise<BrowserWindow>;
  mine = (async () => {
    const owned = await pythonSession();
    // The storage of the window that ended is cleared before the next one opens in the same session.
    await clearing;
    // The runtime may have been disposed while this waited: a window made now would belong to a generation that is over,
    // and retiring it could clear the session in the middle of a request of the current one.
    if (epoch !== generation) throw new Error("runtime-disposed");
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A page that never finishes loading would hold the session for good: the request has entered it, and the ceiling of
      // the run starts only once there is a window.
      await Promise.race([
        created.loadURL(ORIGIN + "index.html"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("runtime-load-timeout")), LOAD_CEILING_MS);
        }),
      ]);
      if (epoch !== generation || created.isDestroyed())
        throw new Error("runtime-disposed");
      window = created;
      return created;
    } catch (error) {
      retire(created);
      // Only this call's own opening: a window that crashed while loading was retired, and another request may have begun
      // opening the next one by the time this load fails.
      if (opening === mine) opening = null;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();
  opening = mine;
  return mine;
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
  const record = startRecord(operation, method);
  const turn = tails[operation].then(() => {
    try {
      if (epoch !== generation) throw new Error("runtime-disposed");
      if (deadline !== undefined && Date.now() >= deadline)
        throw new Error("runtime-expired");
    } catch (error) {
      endRecord(record, error);
      throw error;
    }
    return dispatch(record, operation, payload, timeoutMs, method, epoch);
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
  record: RequestRecord,
  operation: "run" | "check",
  payload: unknown,
  timeoutMs: number | undefined,
  method: "run" | "check" | "grade",
  epoch: number,
): Promise<unknown> {
  let entered = false;
  let used: BrowserWindow | undefined;
  // The stop sent to a run that timed out, which resolves once the page has answered it.
  let stopping = null as Promise<void> | null;
  try {
    await enter(operation);
    entered = true;
    record.entered = Date.now();
    // The runtime may have been reconfigured while this waited to be admitted: its payload is for the workspace it was made in.
    if (epoch !== generation) throw new Error("runtime-disposed");
    const target = await sandbox();
    used = target;
    record.opened = Date.now();
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
            stopping = target.webContents
              .executeJavaScript(
                `window.pyxisRuntime.stop(${JSON.stringify(operation === "run" ? "python" : "check")})`,
              )
              .then(() => undefined, () => undefined);
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
    }
  } catch (error) {
    endRecord(record, error);
    throw error;
  } finally {
    endRecord(record);
    if (stopping && used) await stopped(used, stopping);
    // Cleared when this was the last request using the session, and not under one that is still running.
    if (entered) await leave();
    record.left = Date.now();
  }
}

/**
 * Waits until the page has answered the stop of a run that timed out, which ends its worker, so that nothing the worker
 * issued can still write when the session is cleared. A page that does not answer within the wait a window has to load is
 * not answering at all, and is ended, which stops everything in it.
 */
async function stopped(target: BrowserWindow, stopping: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answered = await Promise.race([
    stopping.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), LOAD_CEILING_MS);
    }),
  ]);
  clearTimeout(timer);
  if (!answered) retire(target);
}
/**
 * Takes a pack off the disk and shuts the window that was using it, so what it drew is unavailable at once. A window
 * keeps nothing of the pack but what it loaded for a run, and the next run asks for the files again and finds none.
 */
async function removePack(pack: PackId): Promise<void> {
  await removeRuntimePack(workspace, pack);
  if (pack === "pyodide") disposePythonRuntime();
  else disposeDrawRuntime();
}
export async function handleRuntimeRequest(
  operation: string,
  payload: unknown,
  deadline?: number,
): Promise<unknown> {
  if (operation === "status") return currentRuntimeStatus(workspace);
  // The packs a request names, or none for every pack.
  const named = () => {
    const packs = z.object({ packs: z.array(z.enum(runtimePackIds)).optional() }).parse(payload ?? {}).packs;
    return packs?.length ? packs : undefined;
  };
  if (operation === "download") {
    if (!workspace) throw new Error("runtime-workspace-missing");
    try {
      await downloadRuntime(workspace, named());
    } catch (error) {
      // Stopped by the student: told as such, so the job that asked ends as cancelled and not as failed.
      if (error instanceof Error && error.name === "AbortError") throw new Error("runtime-download-cancelled");
      throw error;
    }
    return currentRuntimeStatus(workspace);
  }
  if (operation === "cancel-download") {
    cancelRuntimeDownload(workspace, named());
    return {};
  }
  if (operation === "remove") {
    if (!workspace) throw new Error("runtime-workspace-missing");
    const { pack } = z.object({ pack: z.enum(runtimePackIds) }).parse(payload);
    await removePack(pack);
    return currentRuntimeStatus(workspace);
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
