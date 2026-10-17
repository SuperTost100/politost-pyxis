import { decryptKeys } from "./decrypt-keys";
import { writeKeyStore } from "./key-store";
import { randomUUID } from "node:crypto";
import {
  droppedFileGrant,
  pickedFileGrant,
  type FileGrant,
} from "../core/ipc/file-grants";
import { MAX_DROPPED_FILES, SOURCE_EXTENSIONS } from "../shared/source-types";
import { fetchPlanText } from "./plan-fetch";
import { isPlanFileName, planFileFromArgv, readOpenedPlan } from "./plan-open";
import { openTerminal } from "./terminal";
import { stageWorkspaceMove } from "./workspace-move";
import {
  AutoBackups,
  checkBackupFolder,
  startLiveBackupWorker,
} from "./auto-backup";
import { renameSync } from "node:fs";
import packageMetadata from "../../package.json";
import { githubRepository, releaseChecker } from "./updates";
import { buildMenuTemplate } from "./menu";
import {
  isMenuLanguage,
  type MenuCommand,
  type MenuLanguage,
} from "../shared/menu";
import { updateInstaller } from "./update-install";
import { updateSeam } from "./update-fixture";
import { spawn } from "node:child_process";
import { registerArtifactHandlers } from "./artifacts";
import { invalidateRuntime } from "./runtime-pack";
import {
  configurePythonRuntime,
  disposePythonRuntime,
  handleRuntimeRequest,
  registerRuntimeProtocol,
} from "./python-runtime";
import {
  app,
  crashReporter,
  BrowserWindow,
  dialog,
  Menu,
  ipcMain,
  MessageChannelMain,
  nativeTheme,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
  type UtilityProcess,
} from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { registerBlobProtocol } from "./blob-protocol";
import { rendererCsp } from "./csp";
import { recoverInterruptedWipe, wipeWorkspace } from "../core/share/wipe";
import { ensureWorkspace, ensureWorkspaceDirs } from "./workspace";
import {
  mainChannels,
  type Appearance,
  type AutoBackupStatus,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type ThemeSource,
} from "../shared/bridge";

const isDev = !!process.env["ELECTRON_RENDERER_URL"];

function e2eSeam(): boolean {
  // ponytail: a normal install ignores these paths. The dist test sets PYXIS_E2E=1.
  return !app.isPackaged || process.env["PYXIS_E2E"] === "1";
}
/**
 * The interface language a new profile starts in: the first of Italian or English in the computer's preferred
 * languages, and English when neither is listed. Tests pin Italian, the language their copy is written in, unless
 * they list system languages themselves.
 */
function systemLanguage(): "it" | "en" {
  const testing = e2eSeam() && process.env["PYXIS_E2E"] === "1";
  const forced = testing ? process.env["PYXIS_E2E_SYSTEM_LANGUAGES"] : undefined;
  const preferred = forced?.split(",") ?? (testing ? ["it"] : app.getPreferredSystemLanguages());
  for (const tag of preferred) {
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (primary === "it" || primary === "en") return primary;
  }
  return "en";
}
const userDataOverride = process.env["PYXIS_USER_DATA"];
if (userDataOverride) app.setPath("userData", userDataOverride);
// One Pyxis per profile folder. A second copy would open the same database, mark the first one's running jobs as
// interrupted and run them twice, and a move or restore in one would pull the folder from under the other.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
if (e2eSeam() && process.env.PYXIS_E2E === "1" && process.env.PYXIS_CRASH_DIR) {
  mkdirSync(process.env.PYXIS_CRASH_DIR, { recursive: true });
  app.setPath("crashDumps", resolve(process.env.PYXIS_CRASH_DIR));
  crashReporter.start({ uploadToServer: false });
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "pyxis-blob",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: "pyxis-runtime",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

type AppearanceFile = { source: ThemeSource };

function userFile(name: string): string {
  return join(app.getPath("userData"), name);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function readAppearanceSource(): ThemeSource {
  const saved = readJson<AppearanceFile>(userFile("appearance.json"));
  if (
    saved?.source === "dark" ||
    saved?.source === "light" ||
    saved?.source === "system"
  )
    return saved.source;
  return "system";
}

function resolvedTheme(): "dark" | "light" {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function appearance(): Appearance {
  return { source: readAppearanceSource(), resolved: resolvedTheme() };
}

function applyAppearance(source: ThemeSource): Appearance {
  nativeTheme.themeSource = source;
  writeFileSync(userFile("appearance.json"), JSON.stringify({ source }));
  return appearance();
}

function allowedExternal(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

function installCsp(): void {
  const csp = rendererCsp(
    isDev ? process.env["ELECTRON_RENDERER_URL"] : undefined,
  );

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}

function installNavigationGuards(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedExternal(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    // Only the app's own page may load. A dropped or linked file would otherwise replace it and get the bridge.
    contents.on("will-navigate", (event, url) => {
      const devOrigin = process.env["ELECTRON_RENDERER_URL"];
      if (devOrigin && url.startsWith(devOrigin)) return;
      if (url.split("#")[0] === rendererPage) return;
      event.preventDefault();
    });
  });
}

const rendererPage = pathToFileURL(
  join(import.meta.dirname, "../renderer/index.html"),
).href;

// A study app needs no camera, microphone, location, notifications or devices, so pages never get them.
// Everything else (clipboard, fullscreen…) keeps Electron's default.
const deniedPermissions = new Set([
  "media",
  "display-capture",
  "geolocation",
  "notifications",
  "midi",
  "midiSysex",
  "hid",
  "serial",
  "usb",
  "idle-detection",
  "mediaKeySystem",
  "speaker-selection",
  "window-management",
]);
function installPermissionHandlers(): void {
  session.defaultSession.setPermissionRequestHandler(
    (_contents, permission, callback) =>
      callback(!deniedPermissions.has(permission)),
  );
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission) => !deniedPermissions.has(permission),
  );
}

let mainWindow: BrowserWindow | null = null;
let coreChild: UtilityProcess | null = null;
let coreRestartFailures = 0;
const exitedCores = new WeakSet<UtilityProcess>();
let holdCore = false;
let workspaceBusy = false;
let archiveSettled = Promise.resolve();
let releaseArchive = () => {};

function occupyWorkspace(): () => void {
  if (workspaceBusy) throw new Error("workspace-busy");
  workspaceBusy = true;
  archiveSettled = new Promise((resolve) => {
    releaseArchive = resolve;
  });
  return () => {
    workspaceBusy = false;
    releaseArchive();
  };
}
let quitting = false;
let workspacePath = "";
let autoBackups: AutoBackups | null = null;

/** Takes the workspace for a manual backup, restore, move or wipe. A running automatic backup gives way to it. */
async function takeWorkspace(): Promise<() => void> {
  const release = occupyWorkspace();
  try {
    await autoBackups?.stop();
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

/** Documents, or the test folder in unpackaged and e2e builds. Falls back to ~/Documents if the OS has none. */
function documentsFolder(): string | null {
  if (e2eSeam() && process.env["PYXIS_E2E"] === "1")
    return process.env["PYXIS_E2E_DOCUMENTS"] || null;
  try {
    return app.getPath("documents");
  } catch {
    return join(app.getPath("home"), "Documents");
  }
}

function setUpAutoBackups(): void {
  const documents = documentsFolder();
  autoBackups = new AutoBackups({
    stateFile: userFile("backups.json"),
    defaultFolder: () =>
      join(documents ?? app.getPath("documents"), "Pyxis backups"),
    workspace: () => workspacePath,
    userData: app.getPath("userData"),
    // Until core reports ready, pyxis.db can exist without its tables; a copy then would fail and wait an hour.
    busy: () =>
      workspaceBusy ||
      !coreChild ||
      keysReadyFor !== coreChild ||
      exitedCores.has(coreChild),
    start: (zip, waitForJobs) =>
      startLiveBackupWorker(
        join(import.meta.dirname, "archive-worker.js"),
        workspacePath,
        zip,
        waitForJobs,
      ),
    changed: (status: AutoBackupStatus) =>
      mainWindow?.webContents.send(mainChannels.autoBackupChanged, status),
    log: (message) => console.warn(message),
  });
  // Tests that do not name a Documents folder never back up on their own, so they cannot write into the real one.
  if (!documents) return;
  const testing = e2eSeam() && process.env["PYXIS_E2E"] === "1";
  // The first check waits a minute so it does not compete with startup, then checks every 10 minutes. Tests check
  // every 2 s: a first check that finds core still starting or a job running is postponed, and a slow runner must not
  // wait 10 minutes for the next one.
  autoBackups.start(testing ? 1000 : 60_000, testing ? 2000 : 10 * 60_000);
}

function broadcastAppearance(): void {
  const value = appearance();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(mainChannels.appearanceChanged, value);
  }
}

function savedWindowBounds(): {
  width: number;
  height: number;
  x?: number;
  y?: number;
} {
  const saved = readJson<{
    width?: number;
    height?: number;
    x?: number;
    y?: number;
  }>(userFile("window.json"));
  const width = saved?.width ?? 1280;
  const height = saved?.height ?? 832;
  const x = saved?.x;
  const y = saved?.y;
  if (x == null || y == null) return { width, height };
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapW =
      Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
    const overlapH =
      Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
    return overlapW > 80 && overlapH > 80;
  });
  return visible ? { width, height, x, y } : { width, height };
}

function createWindow(): void {
  const hiddenTest = e2eSeam() && process.env["PYXIS_E2E_HIDDEN"] === "1";
  const bounds = savedWindowBounds();
  const theme = resolvedTheme();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: theme === "dark" ? "#0d1015" : "#f6f5f1",
    title: "Pyxis",
    // Windows and Linux show the menu bar only while Alt is held.
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 22 },
        }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      ...(hiddenTest ? { backgroundThrottling: false, offscreen: true } : {}),
    },
  });

  if (!hiddenTest) mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.on("did-finish-load", () => {
    pageReady = true;
    rendererPortFor = null;
    connectRenderer();
  });

  const saveBounds = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getBounds();
    writeFileSync(userFile("window.json"), JSON.stringify(bounds));
  };
  // Moving or resizing fires many events a second; write once the window settles, and once more on close.
  let boundsTimer: NodeJS.Timeout | undefined;
  const saveBoundsSoon = (): void => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 500);
  };
  mainWindow.on("resize", saveBoundsSoon);
  mainWindow.on("move", saveBoundsSoon);
  mainWindow.on("close", () => {
    clearTimeout(boundsTimer);
    saveBounds();
  });
  // On macOS the app outlives its window; core restart messages must not reach a destroyed one.
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const hash = process.env["PYXIS_ROUTE"];
  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    const url = new URL(process.env["ELECTRON_RENDERER_URL"]);
    if (hash) url.hash = hash;
    void mainWindow.loadURL(url.toString());
  } else {
    void mainWindow.loadFile(
      join(import.meta.dirname, "../renderer/index.html"),
      {
        hash: hash?.replace(/^#/, ""),
      },
    );
  }
}

function storedKeys(): { anthropic?: string; openai?: string } {
  const stored = readJson<Record<string, string>>(userFile("keys.json")) ?? {};
  if (!safeStorage.isEncryptionAvailable()) return {};
  return decryptKeys(stored, (cipher) => safeStorage.decryptString(cipher));
}

let keysChain: Promise<void> = Promise.resolve();
let pageReady = false;
let keysReadyFor: UtilityProcess | null = null;
let rendererPortFor: UtilityProcess | null = null;

function pushKeys(removedProvider?: string): Promise<void> {
  const run = keysChain.then(() => deliverKeys(removedProvider));
  keysChain = run.catch(() => undefined);
  return run;
}

function deliverKeys(removedProvider?: string): Promise<void> {
  const child = coreChild;
  if (!child) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error("core-busy"));
    }, 3000);
    const onMessage = (data: { type?: string }) => {
      if (data?.type !== "keys-applied") return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve();
    };
    child.on("message", onMessage);
    child.postMessage({ type: "keys", ...storedKeys(), removedProvider });
  });
}

const pickedGrants = new Map<string, FileGrant>();
async function grantPickedPaths(paths: string[]): Promise<void> {
  return grantFiles(paths.map(pickedFileGrant));
}
async function grantFiles(grants: FileGrant[]): Promise<void> {
  for (const grant of grants) pickedGrants.set(grant.path, grant);
  const child = coreChild;
  if (!child || exitedCores.has(child)) throw new Error("core-busy");
  const id = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", applied);
      reject(new Error("core-busy"));
    }, 3000);
    const applied = (data: { type?: string; id?: string }) => {
      if (data.type !== "file-grants-applied" || data.id !== id) return;
      clearTimeout(timer);
      child.off("message", applied);
      resolve();
    };
    child.on("message", applied);
    child.postMessage({ type: "file-grants", id, grants });
  });
}

function connectRenderer(): void {
  if (
    !pageReady ||
    !coreChild ||
    keysReadyFor !== coreChild ||
    rendererPortFor === coreChild ||
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return;
  }
  rendererPortFor = coreChild;
  if (e2eSeam()) console.error("pyxis-e2e: renderer connected", coreChild.pid);
  const { port1, port2 } = new MessageChannelMain();
  coreChild.postMessage({ type: "renderer-port" }, [port1]);
  mainWindow.webContents.postMessage("pyxis:port", null, [port2]);
}

const CORE_READY_TIMEOUT_MS = 30_000;

function waitForCoreReady(
  child: UtilityProcess,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (err) reject(err);
      else resolve();
    };
    const onMessage = (data: { type?: string; reason?: string }) => {
      if (data?.type === "core-ready") done();
      else if (data?.type === "core-failed")
        done(
          new Error(
            data.reason === "workspace-newer"
              ? "workspace-newer"
              : "core-bootstrap-failed",
          ),
        );
    };
    const onExit = () => done(new Error("core-exited"));
    const timer = setTimeout(
      () => done(new Error("core-ready-timeout")),
      timeoutMs,
    );
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function startCore(strict = false): Promise<void> {
  let startupFailed = false;
  const captureLogs =
    e2eSeam() &&
    process.env.PYXIS_E2E === "1" &&
    process.env.PYXIS_E2E_CORE_STDIO !== "inherit";
  const child = utilityProcess.fork(join(import.meta.dirname, "core.js"), [], {
    serviceName: "pyxis-core",
    stdio: captureLogs ? "pipe" : "inherit",
  });
  if (captureLogs) {
    child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  }
  coreChild = child;
  configurePythonRuntime(workspacePath);
  let childExited = false;
  child.once("exit", () => {
    childExited = true;
    exitedCores.add(child);
  });
  function runtimeReply(message: unknown): void {
    if (childExited || coreChild !== child || quitting || holdCore) return;
    try {
      child.postMessage(message);
    } catch {
      /* The utility process may already have exited. */
    }
  }
  child.on(
    "message",
    (data: {
      type?: string;
      id?: string;
      operation?: string;
      payload?: unknown;
      deadline?: unknown;
    }) => {
      if (
        childExited ||
        coreChild !== child ||
        quitting ||
        holdCore ||
        data.type !== "runtime-request" ||
        !data.id ||
        !data.operation
      )
        return;
      void handleRuntimeRequest(
        data.operation,
        data.payload,
        typeof data.deadline === "number" ? data.deadline : undefined,
      ).then(
        (result) =>
          runtimeReply({ type: "runtime-result", id: data.id, result }),
        (error: unknown) =>
          runtimeReply({
            type: "runtime-result",
            id: data.id,
            error:
              error instanceof Error ? error.message : "runtime-unavailable",
          }),
      );
    },
  );
  keysReadyFor = null;
  rendererPortFor = null;
  let timedOut = false;
  // Generous: slow disks or antivirus can delay the synchronous DB open.
  const healthy = waitForCoreReady(child, CORE_READY_TIMEOUT_MS);
  child.postMessage({
    type: "bootstrap",
    workspacePath,
    grants: [...pickedGrants.values()],
    dev: e2eSeam(),
    // Seams that run code, such as the installer stand-in, stay off in a packaged app even with PYXIS_E2E=1.
    unpackaged: !app.isPackaged,
  });
  child.on("exit", (code) => {
    if (timedOut) return;
    if (quitting || holdCore || coreChild !== child) return;
    console.error(`pyxis-core exited (${code ?? "null"})`);
    coreRestartFailures += 1;
    if (coreRestartFailures >= 5) {
      mainWindow?.webContents.send(mainChannels.coreUnavailable, true);
      return;
    }
    setTimeout(
      () => {
        if (!quitting && !holdCore && coreChild === child) void startCore();
      },
      200 * 2 ** (coreRestartFailures - 1),
    );
  });
  let deliveringKeys = false;
  return healthy
    .catch((err: unknown) => {
      // Restarting cannot help: this workspace needs a newer Pyxis. Stop the restarts and say so once.
      if (err instanceof Error && err.message === "workspace-newer") {
        coreRestartFailures = 5;
        if (!newerWorkspaceShown) {
          newerWorkspaceShown = true;
          void showNewerWorkspace();
        }
      }
      if (err instanceof Error && err.message === "core-ready-timeout") {
        // Terminate the unhealthy core; it must not restart on its own.
        timedOut = true;
        exitedCores.add(child);
        child.kill();
        if (coreChild === child && !quitting)
          mainWindow?.webContents.send(mainChannels.coreUnavailable, true);
      }
      // A reported bootstrap failure exits on its own; kill covers a hang. The
      // exit handler then applies the bounded restart policy.
      else if (!exitedCores.has(child)) child.kill();
      throw err;
    })
    .then(() => {
      deliveringKeys = true;
      return pushKeys();
    })
    .catch((err: unknown) => {
      startupFailed = true;
      if (deliveringKeys) {
        timedOut = true;
        exitedCores.add(child);
        child.kill();
        if (coreChild === child && !quitting)
          mainWindow?.webContents.send(mainChannels.coreUnavailable, true);
      }
      if (strict) throw err;
      console.error(
        "pyxis-core: startup failed",
        err instanceof Error ? err.message : "unknown",
      );
    })
    .finally(() => {
      if (coreChild !== child || startupFailed || exitedCores.has(child))
        return;
      if (!startupFailed) {
        // Only a core that stays up counts as recovered. A crash that comes back right after each restart (a replayed
        // request that crashes it again) must still reach the 5-failure stop instead of looping forever.
        const stable = setTimeout(() => {
          if (coreChild === child && !exitedCores.has(child))
            coreRestartFailures = 0;
        }, 30_000);
        child.once("exit", () => clearTimeout(stable));
        mainWindow?.webContents.send(mainChannels.coreUnavailable, false);
      }
      keysReadyFor = child;
      connectRenderer();
    });
}

/**
 * The application menu, in the interface language the renderer last reported (the computer's language until then).
 * Every build installs it; development builds add reload and developer tools. A menu pick only tells the renderer which
 * command was chosen, and the renderer decides whether it may run now (see `src/renderer/src/app/menu-guard.ts`).
 */
let menuLanguage: MenuLanguage | null = null;

function sendMenuCommand(command: MenuCommand): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(mainChannels.menuCommand, command);
}

function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        platform: process.platform,
        language: menuLanguage ?? systemLanguage(),
        packaged: app.isPackaged,
        send: sendMenuCommand,
      }),
    ),
  );
}

let newerWorkspaceShown = false;

async function showNewerWorkspace(): Promise<void> {
  const options = {
    type: "warning" as const,
    title: "PoliTost Pyxis",
    message:
      "This workspace was saved by a newer version of Pyxis.\n\nQuesti dati sono stati salvati da una versione più recente di Pyxis.",
    detail:
      "Install the latest Pyxis to open it. Your data has not been changed.\n\nInstalla l'ultima versione di Pyxis per aprirli. I tuoi dati non sono stati modificati.",
    buttons: ["Download / Scarica", "OK"],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (response === 0)
    await shell.openExternal(
      "https://github.com/SuperTost100/politost-pyxis/releases/latest",
    );
}

function pauseCore(): Promise<void> {
  holdCore = true;
  disposePythonRuntime();
  const child = coreChild;
  const stopped =
    !child || exitedCores.has(child)
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            holdCore = false;
            reject(new Error("core-busy"));
          }, 3000);
          // Core checkpoints and closes the database before it exits, so the files copied next are complete.
          // One that does not exit in time is killed.
          const kill = setTimeout(() => child.kill(), 1500);
          child.once("exit", () => {
            clearTimeout(kill);
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          });
          child.postMessage({ type: "shutdown" });
        });
  return Promise.allSettled([stopped, invalidateRuntime(workspacePath)]).then(
    (results) => {
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    },
  );
}

function runArchive(
  op: "backup" | "restore" | "commit" | "recover",
  zip?: string,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error, cleanupComplete = true) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(cleanupComplete);
    };
    const worker = new Worker(join(import.meta.dirname, "archive-worker.js"), {
      workerData: { op, workspace: workspacePath, zip },
    });
    worker.once(
      "message",
      (message: {
        ok?: boolean;
        message?: string;
        cleanupComplete?: boolean;
      }) => {
        if (message.ok) finish(undefined, message.cleanupComplete);
        else finish(new Error(message.message || "backup-failed"));
      },
    );
    worker.once("error", (err) => {
      finish(err instanceof Error ? err : new Error("backup-failed"));
    });
    worker.once("exit", (code) => {
      if (!settled)
        finish(
          new Error(code === 0 ? "backup-worker-no-result" : "backup-failed"),
        );
    });
  });
}

function resumeCore(): Promise<void> {
  const ready = startCore();
  holdCore = false;
  return ready;
}

const zipFilter = [{ name: "Zip", extensions: ["zip"] }];

// Print windows keep their own channels (artifacts.ts); these handlers are for
// the main window only.
function requireMainSender(event: IpcMainInvokeEvent, code: string): void {
  if (event.sender.id !== mainWindow?.webContents.id) throw new Error(code);
}

function registerIpc(): void {
  ipcMain.handle(mainChannels.coreRetry, async (event) => {
    if (event.sender.id !== mainWindow?.webContents.id)
      throw new Error("core-untrusted-sender");
    if (coreChild && !exitedCores.has(coreChild)) return;
    coreRestartFailures = 0;
    await startCore();
  });
  ipcMain.handle(mainChannels.appearanceGet, () => appearance());
  ipcMain.handle(mainChannels.appearanceSet, (event, source: ThemeSource) => {
    requireMainSender(event, "main-untrusted-sender");
    if (source !== "system" && source !== "dark" && source !== "light") {
      throw new Error("invalid-theme");
    }
    const next = applyAppearance(source);
    broadcastAppearance();
    return next;
  });
  ipcMain.handle(mainChannels.openExternal, async (event, url: string) => {
    requireMainSender(event, "external-untrusted-sender");
    if (!allowedExternal(url)) throw new Error("blocked-url");
    await shell.openExternal(url);
  });
  ipcMain.handle(
    mainChannels.openDialog,
    async (event, options: OpenDialogOptions) => {
      if (event.sender.id !== mainWindow?.webContents.id)
        throw new Error("picker-untrusted-sender");
      const forced = process.env["PYXIS_E2E_FILE"];
      if (forced && e2eSeam()) {
        await grantPickedPaths([forced]);
        return [forced];
      }
      const dialogOptions = {
        title: options.title,
        properties: options.properties,
        filters: options.filters,
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled) return null;
      await grantPickedPaths(result.filePaths);
      return result.filePaths;
    },
  );
  ipcMain.handle(mainChannels.dropGrant, async (event, paths: unknown) => {
    requireMainSender(event, "picker-untrusted-sender");
    if (
      !Array.isArray(paths) ||
      paths.length > MAX_DROPPED_FILES ||
      paths.some((path) => typeof path !== "string")
    )
      throw new Error("drop-invalid");
    const extensions = new Set(SOURCE_EXTENSIONS.map((ext) => `.${ext}`));
    const grants: FileGrant[] = [];
    for (const path of paths as string[]) {
      try {
        grants.push(droppedFileGrant(path, extensions));
      } catch {
        // Counted below. Folders, unsupported types and unreadable paths are reported, not imported.
      }
    }
    if (grants.length) await grantFiles(grants);
    return {
      paths: grants.map((grant) => grant.selectedPath),
      skipped: paths.length - grants.length,
    };
  });
  const metadata = packageMetadata as { repository?: unknown; version: string };
  // The e2e seam stands in for GitHub, serves installers from a folder and installs into a stand-in AppImage.
  // Unpackaged builds only, like the installer stand-in.
  const seam = e2eSeam() ? updateSeam(process.env, app.isPackaged) : null;
  const fixture = seam?.fetch;
  const testAppImage = seam?.appImage;
  const repository = seam
    ? "PoliTost/pyxis-test"
    : githubRepository(metadata.repository);
  const current = app.isPackaged ? app.getVersion() : metadata.version;
  const checkUpdates = releaseChecker({
    repository,
    current,
    cachePath: userFile("updates.json"),
    ...(fixture ? { fetch: fixture } : {}),
  });
  ipcMain.handle(mainChannels.updatesCheck, (event, force: unknown) => {
    if (event.sender.id !== mainWindow?.webContents.id)
      throw new Error("updates-untrusted-sender");
    return checkUpdates(force === true);
  });
  ipcMain.handle(mainChannels.menuLanguage, (event, language: unknown) => {
    requireMainSender(event, "menu-untrusted-sender");
    if (!isMenuLanguage(language)) throw new Error("invalid-language");
    if (language === (menuLanguage ?? systemLanguage())) return;
    menuLanguage = language;
    installMenu();
  });
  const installer = updateInstaller({
    repository,
    current,
    dir: userFile("updates"),
    target: testAppImage
      ? { platform: "linux", arch: "x64", appImage: testAppImage }
      : {
          platform: process.platform,
          arch: process.arch,
          appImage:
            process.platform === "linux" ? process.env["APPIMAGE"] : undefined,
        },
    ...(fixture ? { fetch: fixture } : {}),
    emit: (view) =>
      mainWindow?.webContents.send(mainChannels.updatesChanged, view),
    openPath: (path) => shell.openPath(path),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    // The verified installer starts from the `quit` event, after Pyxis has closed its windows and stopped its work, so
    // it never finds Pyxis running. It runs on its own, by its full path and without a shell.
    launchAfterQuit: (path) => {
      installerAfterQuit = path;
    },
    log: (message) => console.warn(message),
    relaunch: (path) =>
      app.relaunch({ execPath: path, args: process.argv.slice(1) }),
    quit: () => app.quit(),
  });
  ipcMain.handle(mainChannels.updatesInstall, (event) => {
    requireMainSender(event, "updates-untrusted-sender");
    void installer.start();
  });
  ipcMain.handle(mainChannels.updatesCancel, (event) => {
    requireMainSender(event, "updates-untrusted-sender");
    installer.cancel();
  });
  ipcMain.handle(mainChannels.updatesState, (event) => {
    requireMainSender(event, "updates-untrusted-sender");
    return installer.state();
  });
  ipcMain.handle(mainChannels.updatesReveal, (event) => {
    requireMainSender(event, "updates-untrusted-sender");
    return installer.reveal();
  });
  ipcMain.handle(mainChannels.updatesFinish, (event, raw: unknown) => {
    requireMainSender(event, "updates-untrusted-sender");
    const input = raw as { activeJobs?: unknown; confirmed?: unknown } | null;
    if (
      !input ||
      !Number.isSafeInteger(input.activeJobs) ||
      (input.activeJobs as number) < 0 ||
      typeof input.confirmed !== "boolean"
    )
      throw new Error("updates-invalid");
    return installer.finish({
      workspaceBusy,
      activeJobs: input.activeJobs as number,
      confirmed: input.confirmed,
    });
  });
  registerArtifactHandlers(() => mainWindow, e2eSeam);
  ipcMain.handle(
    mainChannels.saveDialog,
    async (event, options: SaveDialogOptions) => {
      requireMainSender(event, "save-untrusted-sender");
      const dialogOptions = {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
      };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (result.canceled || !result.filePath) return null;
      return result.filePath;
    },
  );
  function authorizeKeys(senderId: number): void {
    if (senderId !== mainWindow?.webContents.id)
      throw new Error("keys-untrusted-sender");
  }
  function keyProvider(provider: unknown): "anthropic" | "openai" {
    if (provider !== "anthropic" && provider !== "openai")
      throw new Error("unknown-provider");
    return provider;
  }
  ipcMain.handle(mainChannels.terminalOpen, async (event, program: unknown) => {
    authorizeKeys(event.sender.id);
    if (program !== undefined && program !== "antigravity")
      throw new Error("unknown-program");
    await openTerminal(program, (path) => shell.openPath(path));
  });
  ipcMain.handle(mainChannels.keysStatus, (event) => {
    authorizeKeys(event.sender.id);
    const backend =
      process.platform === "linux"
        ? safeStorage.getSelectedStorageBackend()
        : process.platform === "darwin"
          ? "keychain"
          : "dpapi";
    const canSave =
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" || backend !== "basic_text");
    const keys = storedKeys();
    return {
      backend,
      canSave,
      configured: (["anthropic", "openai"] as const).filter(
        (provider) => !!keys[provider],
      ),
    };
  });
  ipcMain.handle(mainChannels.keysRemove, async (event, raw: unknown) => {
    authorizeKeys(event.sender.id);
    if (workspaceBusy) throw new Error("workspace-busy");
    const provider = keyProvider(raw);
    const stored =
      readJson<Record<string, string>>(userFile("keys.json")) ?? {};
    delete stored[provider];
    writeKeyStore(userFile("keys.json"), stored);
    await pushKeys(`${provider === "anthropic" ? "anthropic" : "openai"}-api`);
  });
  ipcMain.on("app:dev", (event) => {
    event.returnValue = !app.isPackaged;
  });
  ipcMain.on("app:system-language", (event) => {
    event.returnValue = systemLanguage();
  });
  ipcMain.handle("dev:killCore", (event) => {
    if (app.isPackaged) return;
    requireMainSender(event, "dev-untrusted-sender");
    coreChild?.kill();
  });
  ipcMain.handle(
    mainChannels.keysSet,
    async (event, raw: unknown, key: unknown) => {
      authorizeKeys(event.sender.id);
      if (workspaceBusy) throw new Error("workspace-busy");
      const provider = keyProvider(raw);
      if (typeof key !== "string" || !key.trim() || key.length > 4096)
        throw new Error("invalid-key");
      const backend =
        process.platform === "linux"
          ? safeStorage.getSelectedStorageBackend()
          : process.platform === "darwin"
            ? "keychain"
            : "dpapi";
      if (process.platform === "linux" && backend === "basic_text") {
        throw new Error("keyring-unavailable");
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("encryption-unavailable");
      }
      const stored =
        readJson<Record<string, string>>(userFile("keys.json")) ?? {};
      stored[provider] = safeStorage.encryptString(key).toString("base64");
      writeKeyStore(userFile("keys.json"), stored);
      await pushKeys();
    },
  );
  ipcMain.handle(mainChannels.planFetch, async (event, raw: string) => {
    requireMainSender(event, "plan-untrusted-sender");
    return fetchPlanText(raw);
  });
  ipcMain.handle(mainChannels.planFileTake, async (event) => {
    requireMainSender(event, "plan-untrusted-sender");
    const path = waitingPlanPath;
    waitingPlanPath = null;
    return path ? readOpenedPlan(path) : null;
  });
  ipcMain.handle(mainChannels.workspaceBackup, async (event) => {
    requireMainSender(event, "workspace-untrusted-sender");
    const release = await takeWorkspace();
    try {
      const forced = e2eSeam() ? process.env["PYXIS_E2E_SAVE"] : undefined;
      let filePath = forced;
      if (!filePath) {
        const result = mainWindow
          ? await dialog.showSaveDialog(mainWindow, {
              defaultPath: "pyxis-backup.zip",
              filters: zipFilter,
            })
          : await dialog.showSaveDialog({
              defaultPath: "pyxis-backup.zip",
              filters: zipFilter,
            });
        if (result.canceled || !result.filePath) return "cancelled";
        filePath = result.filePath;
      }
      await pauseCore();
      try {
        await runArchive("backup", filePath);
        return "saved";
      } finally {
        await resumeCore();
      }
    } finally {
      release();
    }
  });
  ipcMain.handle(mainChannels.workspaceRestore, async (event) => {
    requireMainSender(event, "workspace-untrusted-sender");
    const release = await takeWorkspace();
    try {
      const forced = e2eSeam() ? process.env["PYXIS_E2E_ZIP"] : undefined;
      let filePath = forced;
      if (!filePath) {
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, {
              properties: ["openFile"],
              filters: zipFilter,
            })
          : await dialog.showOpenDialog({
              properties: ["openFile"],
              filters: zipFilter,
            });
        filePath = result.filePaths[0];
        if (result.canceled || !filePath) return "cancelled";
      }
      await pauseCore();
      try {
        await runArchive("restore", filePath);
        ensureWorkspaceDirs(workspacePath);
        await startCore(true);
        holdCore = false;
      } catch (error) {
        await pauseCore();
        try {
          await runArchive("recover");
        } finally {
          // Even if recovery fails, core must come back or say it can't: a held core leaves every screen waiting.
          await resumeCore().catch(() =>
            mainWindow?.webContents.send(mainChannels.coreUnavailable, true),
          );
        }
        throw error;
      }
      // The old copy is held until core has validated and opened the restored
      // workspace. Cleanup must not roll back a working new copy.
      if (!(await runArchive("commit"))) {
        console.warn(
          "pyxis: restore succeeded; old workspace cleanup remains pending",
        );
      }
      return "restored";
    } finally {
      release();
    }
  });
  ipcMain.handle(mainChannels.workspaceMove, async (event) => {
    if (event.sender.id !== mainWindow?.webContents.id)
      throw new Error("workspace-untrusted-sender");
    const release = await takeWorkspace();
    try {
      const forced = e2eSeam() ? process.env["PYXIS_E2E_MOVE"] : undefined;
      const selected = forced
        ? [forced]
        : (
            await dialog.showOpenDialog(mainWindow!, {
              properties: ["openDirectory", "createDirectory"],
            })
          ).filePaths;
      if (!selected[0]) return { status: "cancelled" };
      const target = join(selected[0], "Pyxis workspace");
      const original = workspacePath;
      function savePath(path: string): void {
        const temporary = userFile("config.json.tmp");
        writeFileSync(
          temporary,
          JSON.stringify({ workspacePath: path }, null, 2),
        );
        renameSync(temporary, userFile("config.json"));
      }
      try {
        await pauseCore();
      } catch (error) {
        holdCore = false;
        if (!coreChild || exitedCores.has(coreChild)) await resumeCore();
        throw error;
      }
      let move: Awaited<ReturnType<typeof stageWorkspaceMove>> | undefined;
      try {
        move = await stageWorkspaceMove(original, target);
        savePath(move.path);
        workspacePath = move.path;
        await startCore(true);
        holdCore = false;
      } catch (error) {
        await pauseCore();
        const recovery = move ? await move.recoveryPath() : original;
        savePath(recovery);
        workspacePath = recovery;
        if (move && recovery !== move.path) {
          // Refusal to delete a replaced destination must not select it.
          // recoveryPath has already checked the original copy is healthy.
          await move.rollback().catch(() => undefined);
        }
        await resumeCore();
        throw error;
      }
      const cleaned = await move.commit().catch(() => false);
      return { status: "moved", path: workspacePath, cleanupPending: !cleaned };
    } finally {
      release();
    }
  });
  ipcMain.handle(mainChannels.workspacePath, (event) => {
    requireMainSender(event, "main-untrusted-sender");
    return workspacePath;
  });
  ipcMain.handle(mainChannels.workspaceWipe, async (event, options: unknown) => {
    requireMainSender(event, "workspace-untrusted-sender");
    // Deleting backups needs an explicit true; anything else keeps them.
    const deleteBackups =
      typeof options === "object" && options !== null && (options as { backups?: unknown }).backups === true;
    const release = await takeWorkspace();
    try {
      await pauseCore();
      let keysCleared = false;
      try {
        // SET-05: clear credentials before deleting study data, so an interrupted wipe cannot leave usable keys.
        // A later workspace deletion failure still leaves keys cleared, in keeping with the user's delete-all request.
        await keysChain;
        writeKeyStore(userFile("keys.json"), {});
        keysCleared = true;
        wipeWorkspace(workspacePath);
        if (!deleteBackups) return "wiped" as const;
        try {
          if (!autoBackups) throw new Error("backup-failed");
          // An e2e run without a test Documents folder must never reach the real one.
          if (documentsFolder() === null && autoBackups.status().isDefaultFolder) return "wiped" as const;
          autoBackups.deleteBackups();
          return "wiped" as const;
        } catch (error) {
          // The study data is already gone. The backups failing is reported, not thrown, so the wipe still counts.
          console.error("pyxis: automatic backups were not deleted", error);
          return "wiped-backups-left" as const;
        }
      } catch (err) {
        try {
          recoverInterruptedWipe(workspacePath);
        } catch {
          // The copy is still in .wipe. Core stays stopped until a later launch can finish.
        }
        throw keysCleared ? new Error("wipe-after-keys", { cause: err }) : err;
      } finally {
        if (!existsSync(join(workspacePath, ".wipe"))) {
          ensureWorkspaceDirs(workspacePath);
          await resumeCore();
        }
      }
    } finally {
      release();
    }
  });
}

function registerAutoBackupIpc(): void {
  const backups = (): AutoBackups => {
    if (!autoBackups) throw new Error("backup-failed");
    return autoBackups;
  };
  ipcMain.handle(mainChannels.autoBackupStatus, (event) => {
    requireMainSender(event, "workspace-untrusted-sender");
    return backups().status();
  });
  ipcMain.handle(
    mainChannels.autoBackupSetEnabled,
    (event, enabled: unknown) => {
      requireMainSender(event, "workspace-untrusted-sender");
      if (typeof enabled !== "boolean") throw new Error("invalid-setting");
      return backups().setEnabled(enabled);
    },
  );
  ipcMain.handle(mainChannels.autoBackupChooseFolder, async (event) => {
    requireMainSender(event, "workspace-untrusted-sender");
    const forced = e2eSeam() ? process.env["PYXIS_E2E_BACKUP_FOLDER"] : undefined;
    const selected = forced
      ? [forced]
      : (
          await dialog.showOpenDialog(mainWindow!, {
            defaultPath: backups().folder(),
            properties: ["openDirectory", "createDirectory"],
          })
        ).filePaths;
    if (!selected[0]) return null;
    const folder = checkBackupFolder(selected[0], {
      workspace: workspacePath,
      userData: app.getPath("userData"),
    });
    return backups().setFolder(folder);
  });
  ipcMain.handle(mainChannels.autoBackupOpenFolder, async (event) => {
    requireMainSender(event, "workspace-untrusted-sender");
    const status = backups().status();
    if (status.isDefaultFolder) mkdirSync(status.folder, { recursive: true });
    const failure = await shell.openPath(status.folder);
    if (failure) throw new Error("backup-folder-missing");
  });
  ipcMain.handle(mainChannels.autoBackupRunNow, (event) => {
    requireMainSender(event, "workspace-untrusted-sender");
    if (workspaceBusy) throw new Error("workspace-busy");
    return backups().runNow();
  });
  ipcMain.handle(mainChannels.autoBackupDismiss, (event) => {
    requireMainSender(event, "workspace-untrusted-sender");
    return backups().dismissNotice();
  });
}

function registerProtocols(): void {
  registerBlobProtocol(() => workspacePath);
  registerRuntimeProtocol(session.defaultSession, () => workspacePath);
}

/**
 * The plan file the system asked Pyxis to open, until the window has taken it. Only a path that main checked for a plan
 * file name is kept, and the renderer cannot set it: it asks for the file, and main reads it (see `plan-open.ts`).
 */
let waitingPlanPath: string | null = null;

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openPlanFile(path: string | null): void {
  if (!path) return;
  waitingPlanPath = path;
  // The window may not exist yet (a launch from the file), or have been closed on macOS. It takes the file when it loads.
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
    return;
  }
  showWindow();
  mainWindow.webContents.send(mainChannels.planFileWaiting);
}

// Windows and Linux hand the file to the first launch as an argument; a launch that finds Pyxis running hands it over
// as the second instance's arguments.
if (primaryInstance) waitingPlanPath = planFileFromArgv(process.argv.slice(1));
app.on("second-instance", (_event, argv, workingDirectory) => {
  const path = planFileFromArgv(argv.slice(1), workingDirectory);
  if (path) openPlanFile(path);
  else showWindow();
});
// macOS sends open-file for a double-click, a drop on the Dock icon and Open With, also before the app is ready.
app.on("open-file", (event, path) => {
  event.preventDefault();
  if (isPlanFileName(path)) openPlanFile(path);
});

app.whenReady().then(() => {
  if (!primaryInstance) return;
  if (
    process.platform === "darwin" &&
    e2eSeam() &&
    process.env["PYXIS_E2E_HIDDEN"] === "1"
  )
    app.setActivationPolicy("prohibited");
  mkdirSync(app.getPath("userData"), { recursive: true });
  try {
    for (;;) {
      try {
        workspacePath = ensureWorkspace();
        break;
      } catch (err) {
        if (!(err instanceof Error && err.message === "workspace-missing"))
          throw err;
        const retry = dialog.showMessageBoxSync({
          type: "warning",
          title: "PoliTost Pyxis",
          message:
            "Pyxis can't find its data folder.\n\nPyxis non trova la cartella dei dati.",
          detail:
            "If you moved it to an external drive, connect the drive and try again. Nothing has been changed.\n\nSe l'hai spostata su un disco esterno, collegalo e riprova. Non è stato modificato nulla.",
          buttons: ["Try again / Riprova", "Quit / Esci"],
          defaultId: 0,
          cancelId: 1,
        });
        if (retry !== 0) {
          app.exit(0);
          return;
        }
      }
    }
    recoverInterruptedWipe(workspacePath);
  } catch (err) {
    console.error(
      "pyxis: workspace recovery could not finish",
      err instanceof Error ? err.message : "unknown",
    );
    dialog.showErrorBox(
      "PoliTost Pyxis",
      "Pyxis could not safely recover the workspace. Your saved copies have been kept. Restore a verified backup or keep the workspace, .old, .restore and journal files together for recovery.\n\nPyxis non ha potuto recuperare i dati in sicurezza. Le copie salvate sono conservate. Ripristina un backup verificato oppure conserva insieme la cartella dei dati, .old, .restore e i file di recupero.",
    );
    app.exit(1);
    return;
  }
  if (existsSync(join(workspacePath, ".wipe"))) {
    console.error("pyxis: saved data is still in .wipe");
    app.exit(1);
    return;
  }
  applyAppearance(readAppearanceSource());
  installCsp();
  installMenu();
  installNavigationGuards();
  installPermissionHandlers();
  registerProtocols();
  registerIpc();
  setUpAutoBackups();
  registerAutoBackupIpc();
  nativeTheme.on("updated", broadcastAppearance);
  startCore();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitAfterArchive = false;

/** The verified Windows installer to start once Pyxis has exited (see `updateInstaller`). */
let installerAfterQuit: string | null = null;

let quitAfterAutoBackup = false;

app.on("before-quit", (event) => {
  // No check may start a backup from here on. A running one is stopped below.
  autoBackups?.dispose();
  // An automatic backup is stopped, not waited for: the next launch makes a new one.
  if (autoBackups?.running && !quitAfterAutoBackup) {
    event.preventDefault();
    quitAfterAutoBackup = true;
    void autoBackups
      .stop()
      .catch(() => undefined)
      .then(() => app.quit());
    return;
  }
  if (workspaceBusy) {
    event.preventDefault();
    if (!quitAfterArchive) {
      quitAfterArchive = true;
      void archiveSettled.then(() => app.quit());
    }
    return;
  }
  quitting = true;
  disposePythonRuntime();
  coreChild?.postMessage({ type: "shutdown" });
});

// `quit` is the last event before the process ends: the quit was not cancelled and the windows are closed.
app.on("quit", () => {
  if (!installerAfterQuit) return;
  const path = installerAfterQuit;
  installerAfterQuit = null;
  try {
    const child = spawn(path, [], { detached: true, stdio: "ignore" });
    // Pyxis is gone by now, so a start that fails can only be logged.
    child.once("error", (error) =>
      console.warn(`pyxis: installer not started (${error.message})`),
    );
    child.unref();
  } catch (error) {
    console.warn(`pyxis: installer not started (${(error as Error).message})`);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
