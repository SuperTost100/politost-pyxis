import { decryptKeys } from "./decrypt-keys";
import { spawn } from "node:child_process";
import { writeKeyStore } from "./key-store";
import { randomUUID } from "node:crypto";
import { pickedFileGrant, type FileGrant } from "../core/ipc/file-grants";
import { fetchPlanText } from "./plan-fetch";
import { stageWorkspaceMove } from "./workspace-move";
import { renameSync } from "node:fs";
import packageMetadata from "../../package.json";
import { githubRepository, releaseChecker } from "./updates";
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
  BrowserWindow,
  dialog,
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
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { registerBlobProtocol } from "./blob-protocol";
import { recoverInterruptedWipe, wipeWorkspace } from "../core/share/wipe";
import { ensureWorkspace, ensureWorkspaceDirs } from "./workspace";
import {
  mainChannels,
  type Appearance,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type ThemeSource,
} from "../shared/bridge";

const isDev = !!process.env["ELECTRON_RENDERER_URL"];

function e2eSeam(): boolean {
  // ponytail: a normal install ignores these paths. The dist test sets PYXIS_E2E=1.
  return !app.isPackaged || process.env["PYXIS_E2E"] === "1";
}
const userDataOverride = process.env["PYXIS_USER_DATA"];
if (userDataOverride) app.setPath("userData", userDataOverride);

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
  const devOrigin = process.env["ELECTRON_RENDERER_URL"] ?? "";
  const csp = isDev
    ? `default-src 'self' ${devOrigin}; script-src 'self' ${devOrigin}; style-src 'self' 'unsafe-inline' ${devOrigin}; img-src 'self' data: blob: pyxis-blob: ${devOrigin}; font-src 'self' data: ${devOrigin}; connect-src 'self' pyxis-blob: ${devOrigin} ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'`
    : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: pyxis-blob:; font-src 'self' data:; connect-src 'self' pyxis-blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'`;

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
    contents.on("will-navigate", (event, url) => {
      const devOrigin = process.env["ELECTRON_RENDERER_URL"];
      if (devOrigin && url.startsWith(devOrigin)) return;
      const current = contents.getURL();
      if (current.startsWith("file:") && url.startsWith("file:")) return;
      event.preventDefault();
    });
  });
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
  const bounds = savedWindowBounds();
  const theme = resolvedTheme();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: theme === "dark" ? "#0d1015" : "#f6f5f1",
    title: "Pyxis",
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
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
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
  mainWindow.on("resize", saveBounds);
  mainWindow.on("move", saveBounds);

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
  const grants = paths.map(pickedFileGrant);
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
    const onMessage = (data: { type?: string }) => {
      if (data?.type === "core-ready") done();
      else if (data?.type === "core-failed")
        done(new Error("core-bootstrap-failed"));
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
  const child = utilityProcess.fork(join(import.meta.dirname, "core.js"), [], {
    serviceName: "pyxis-core",
    stdio: "inherit",
  });
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
      void handleRuntimeRequest(data.operation, data.payload).then(
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
        coreRestartFailures = 0;
        mainWindow?.webContents.send(mainChannels.coreUnavailable, false);
      }
      keysReadyFor = child;
      connectRenderer();
    });
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
          child.once("exit", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          });
          child.kill();
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
  const metadata = packageMetadata as { repository?: unknown; version: string };
  const releaseFixture =
    e2eSeam() && process.env["PYXIS_E2E_RELEASE"]
      ? JSON.parse(process.env["PYXIS_E2E_RELEASE"]!)
      : null;
  const checkUpdates = releaseChecker({
    repository: releaseFixture
      ? "PoliTost/pyxis-test"
      : githubRepository(metadata.repository),
    current: app.isPackaged ? app.getVersion() : metadata.version,
    cachePath: userFile("updates.json"),
    ...(releaseFixture
      ? {
          fetch: async () =>
            new Response(JSON.stringify(releaseFixture), { status: 200 }),
        }
      : {}),
  });
  ipcMain.handle(mainChannels.updatesCheck, (event) => {
    if (event.sender.id !== mainWindow?.webContents.id)
      throw new Error("updates-untrusted-sender");
    return checkUpdates();
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
  ipcMain.handle(mainChannels.terminalOpen, async (event) => {
    authorizeKeys(event.sender.id);
    if (process.platform === "darwin") {
      const error = await shell.openPath(
        "/System/Applications/Utilities/Terminal.app",
      );
      if (error) throw new Error("terminal-unavailable");
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const child =
        process.platform === "win32"
          ? spawn("cmd.exe", ["/c", "start", "", "cmd.exe"], {
              detached: true,
              stdio: "ignore",
            })
          : spawn("x-terminal-emulator", [], {
              detached: true,
              stdio: "ignore",
            });
      child.once("error", () => reject(new Error("terminal-unavailable")));
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
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
  ipcMain.handle("dev:killCore", (event) => {
    if (app.isPackaged) return;
    requireMainSender(event, "dev-untrusted-sender");
    coreChild?.kill();
  });
  ipcMain.handle(
    mainChannels.keysSet,
    async (event, raw: unknown, key: unknown) => {
      authorizeKeys(event.sender.id);
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
  ipcMain.handle(mainChannels.workspaceBackup, async (event) => {
    requireMainSender(event, "workspace-untrusted-sender");
    const release = occupyWorkspace();
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
    const release = occupyWorkspace();
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
        await runArchive("recover");
        await resumeCore();
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
    const release = occupyWorkspace();
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
  ipcMain.handle(mainChannels.workspaceWipe, async (event) => {
    requireMainSender(event, "workspace-untrusted-sender");
    const release = occupyWorkspace();
    try {
      await pauseCore();
      try {
        wipeWorkspace(workspacePath);
        return "wiped" as const;
      } catch (err) {
        try {
          recoverInterruptedWipe(workspacePath);
        } catch {
          // The copy is still in .wipe. Core stays stopped until a later launch can finish.
        }
        throw err;
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

function registerProtocols(): void {
  registerBlobProtocol(() => workspacePath);
  registerRuntimeProtocol(session.defaultSession, () => workspacePath);
}

app.whenReady().then(() => {
  mkdirSync(app.getPath("userData"), { recursive: true });
  try {
    workspacePath = ensureWorkspace();
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
  installNavigationGuards();
  registerProtocols();
  registerIpc();
  nativeTheme.on("updated", broadcastAppearance);
  startCore();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitAfterArchive = false;

app.on("before-quit", (event) => {
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
