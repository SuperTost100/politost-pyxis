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
import { httpPlanUrl } from "../shared/plan-file";

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
  const out: { anthropic?: string; openai?: string } = {};
  if (!safeStorage.isEncryptionAvailable()) return out;
  for (const id of ["anthropic", "openai"] as const) {
    const cipher = stored[id];
    if (!cipher) continue;
    out[id] = safeStorage.decryptString(Buffer.from(cipher, "base64"));
  }
  return out;
}

let keysChain: Promise<void> = Promise.resolve();
let pageReady = false;
let keysReadyFor: UtilityProcess | null = null;
let rendererPortFor: UtilityProcess | null = null;

function pushKeys(): Promise<void> {
  const run = keysChain.then(() => deliverKeys());
  keysChain = run.catch(() => undefined);
  return run;
}

function deliverKeys(): Promise<void> {
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
    child.postMessage({ type: "keys", ...storedKeys() });
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

function startCore(): Promise<void> {
  const child = utilityProcess.fork(join(import.meta.dirname, "core.js"), [], {
    serviceName: "pyxis-core",
    stdio: "inherit",
  });
  coreChild = child;
  configurePythonRuntime(workspacePath);
  let childExited = false;
  child.once("exit", () => {
    childExited = true;
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
  child.postMessage({
    type: "bootstrap",
    workspacePath,
    dev: e2eSeam(),
  });
  child.on("exit", (code) => {
    if (quitting || holdCore || coreChild !== child) return;
    console.error(`pyxis-core exited (${code ?? "null"})`);
    setTimeout(() => {
      if (!quitting && !holdCore && coreChild === child) startCore();
    }, 200);
  });
  return pushKeys()
    .catch((err: unknown) => {
      console.error(
        "pyxis-core: keys were not applied",
        err instanceof Error ? err.message : "unknown",
      );
    })
    .finally(() => {
      if (coreChild !== child) return;
      keysReadyFor = child;
      connectRenderer();
    });
}

function pauseCore(): Promise<void> {
  holdCore = true;
  disposePythonRuntime();
  const child = coreChild;
  const stopped = !child
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
  return Promise.all([stopped, invalidateRuntime(workspacePath)]).then(
    () => undefined,
  );
}

function runArchive(op: "backup" | "restore", zip: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    const worker = new Worker(join(import.meta.dirname, "archive-worker.js"), {
      workerData: { op, workspace: workspacePath, zip },
    });
    worker.once("message", (message: { ok?: boolean; message?: string }) => {
      if (message.ok) finish();
      else finish(new Error(message.message || "backup-failed"));
    });
    worker.once("error", (err) => {
      finish(err instanceof Error ? err : new Error("backup-failed"));
    });
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error("backup-failed"));
    });
  });
}

function resumeCore(): Promise<void> {
  const ready = startCore();
  holdCore = false;
  return ready;
}

const zipFilter = [{ name: "Zip", extensions: ["zip"] }];

function registerIpc(): void {
  ipcMain.handle(mainChannels.appearanceGet, () => appearance());
  ipcMain.handle(mainChannels.appearanceSet, (_event, source: ThemeSource) => {
    if (source !== "system" && source !== "dark" && source !== "light") {
      throw new Error("invalid-theme");
    }
    const next = applyAppearance(source);
    broadcastAppearance();
    return next;
  });
  ipcMain.handle(mainChannels.openExternal, async (_event, url: string) => {
    if (!allowedExternal(url)) throw new Error("blocked-url");
    await shell.openExternal(url);
  });
  ipcMain.handle(
    mainChannels.openDialog,
    async (_event, options: OpenDialogOptions) => {
      const forced = process.env["PYXIS_E2E_FILE"];
      if (forced && e2eSeam()) return [forced];
      const dialogOptions = {
        title: options.title,
        properties: options.properties,
        filters: options.filters,
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled) return null;
      return result.filePaths;
    },
  );
  ipcMain.handle(
    mainChannels.saveDialog,
    async (_event, options: SaveDialogOptions) => {
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
  ipcMain.handle(mainChannels.keysStatus, () => {
    const backend = safeStorage.getSelectedStorageBackend();
    const canSave = process.platform !== "linux" || backend !== "basic_text";
    return { backend, canSave };
  });
  ipcMain.on("app:dev", (event) => {
    event.returnValue = !app.isPackaged;
  });
  ipcMain.handle("dev:killCore", () => {
    if (app.isPackaged) return;
    coreChild?.kill();
  });
  ipcMain.handle(
    mainChannels.keysSet,
    async (_event, provider: string, key: string) => {
      if (provider !== "anthropic" && provider !== "openai") {
        throw new Error("unknown-provider");
      }
      const backend = safeStorage.getSelectedStorageBackend();
      if (process.platform === "linux" && backend === "basic_text") {
        throw new Error("keyring-unavailable");
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("encryption-unavailable");
      }
      const stored =
        readJson<Record<string, string>>(userFile("keys.json")) ?? {};
      stored[provider] = safeStorage.encryptString(key).toString("base64");
      writeFileSync(userFile("keys.json"), JSON.stringify(stored));
      await pushKeys();
    },
  );
  ipcMain.handle(mainChannels.planFetch, async (_event, raw: string) => {
    const url = httpPlanUrl(raw);
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || !response.body) throw new Error("plan-url");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.byteLength;
      if (size > 1_000_000) {
        await reader.cancel();
        throw new Error("plan-url");
      }
      chunks.push(step.value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  });
  ipcMain.handle(mainChannels.workspaceBackup, async () => {
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
  ipcMain.handle(mainChannels.workspaceRestore, async () => {
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
        return "restored";
      } finally {
        await resumeCore();
      }
    } finally {
      release();
    }
  });
  ipcMain.handle(mainChannels.workspacePath, () => workspacePath);
  ipcMain.handle(mainChannels.workspaceWipe, async () => {
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
  registerBlobProtocol(workspacePath);
  registerRuntimeProtocol(session.defaultSession, workspacePath);
}

app.whenReady().then(() => {
  mkdirSync(app.getPath("userData"), { recursive: true });
  workspacePath = ensureWorkspace();
  try {
    recoverInterruptedWipe(workspacePath);
  } catch (err) {
    console.error(
      "pyxis: an unfinished wipe could not be restored",
      err instanceof Error ? err.message : "unknown",
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
