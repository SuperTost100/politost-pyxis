import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  mainChannels,
  type Appearance,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type ThemeSource,
} from "../shared/bridge";

const isDev = !!process.env["ELECTRON_RENDERER_URL"];

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
    ? `default-src 'self' ${devOrigin}; script-src 'self' ${devOrigin}; style-src 'self' 'unsafe-inline' ${devOrigin}; img-src 'self' data: blob: pyxis-blob: ${devOrigin}; font-src 'self' data: ${devOrigin}; connect-src 'self' ${devOrigin} ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'`
    : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: pyxis-blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'`;

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

function broadcastAppearance(): void {
  const value = appearance();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(mainChannels.appearanceChanged, value);
  }
}

function createWindow(): void {
  const saved = readJson<{
    width?: number;
    height?: number;
    x?: number;
    y?: number;
  }>(userFile("window.json"));
  const theme = resolvedTheme();
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 832,
    x: saved?.x,
    y: saved?.y,
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

function startCore(): void {
  const child = utilityProcess.fork(join(import.meta.dirname, "core.js"), [], {
    serviceName: "pyxis-core",
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (code !== 0) console.error(`pyxis-core exited (${code ?? "null"})`);
  });
}

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
  ipcMain.handle(mainChannels.keysSet, () => {
    const backend = safeStorage.getSelectedStorageBackend();
    if (process.platform === "linux" && backend === "basic_text") {
      throw new Error("keyring-unavailable");
    }
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("encryption-unavailable");
    throw new Error("not-ready");
  });
}

function registerProtocols(): void {
  const miss = (scheme: string) => {
    protocol.handle(scheme, () => new Response("not found", { status: 404 }));
  };
  miss("pyxis-blob");
  miss("pyxis-runtime");
}

app.whenReady().then(() => {
  mkdirSync(app.getPath("userData"), { recursive: true });
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
