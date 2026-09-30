import { contextBridge, ipcRenderer } from "electron";
import {
  mainChannels,
  type Appearance,
  type OpenDialogOptions,
  type PyxisBridge,
  type SaveDialogOptions,
  type ThemeSource,
} from "../shared/bridge";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const coreRestarted = {
  code: "core-restarted",
  messageKey: "errors.coreRestarted",
  params: {},
  detail: "",
};

let port: MessagePort | null = null;
const pending = new Map<string, Pending>();
const queued: unknown[] = [];
const broadcasts = new Map<string, Set<(value: unknown) => void>>();
const streams = new Map<string, (event: unknown) => void>();
const portListeners = new Set<() => void>();
let restarted: (() => void) | null = null;

function handle(data: unknown): void {
  if (!data || typeof data !== "object" || !("kind" in data)) return;
  const message = data as {
    kind: string;
    id?: string;
    ok?: boolean;
    value?: unknown;
    error?: unknown;
    event?: unknown;
    name?: string;
  };
  if (message.kind === "bcast" && message.name) {
    for (const cb of broadcasts.get(message.name) ?? []) cb(message.value);
    return;
  }
  if (!message.id) return;
  if (message.kind === "stream") {
    streams.get(message.id)?.(message.event);
    return;
  }
  if (message.kind === "end") {
    pending.get(message.id)?.resolve(undefined);
    pending.delete(message.id);
    streams.delete(message.id);
    return;
  }
  if (message.kind !== "res") return;
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.ok) item.resolve(message.value);
  else item.reject(message.error);
}

function post(message: unknown): void {
  if (port) port.postMessage(message);
  else queued.push(message);
}

ipcRenderer.on("pyxis:port", (event) => {
  const next = event.ports[0];
  if (!next) return;
  const lost = pending.size > 0;
  if (lost) {
    for (const item of pending.values()) item.reject(coreRestarted);
    pending.clear();
    streams.clear();
  }
  port?.close();
  port = next;
  port.onmessage = (ev: MessageEvent) => handle(ev.data);
  port.start();
  for (const message of queued) port.postMessage(message);
  queued.length = 0;
  if (lost && port) restarted?.();
  for (const cb of portListeners) cb();
});

const bridge: PyxisBridge = {
  platform: process.platform,
  dev: ipcRenderer.sendSync("app:dev") === true,
  getAppearance: () => ipcRenderer.invoke(mainChannels.appearanceGet),
  setAppearance: (source: ThemeSource) =>
    ipcRenderer.invoke(mainChannels.appearanceSet, source),
  onAppearance: (cb) => {
    const listener = (_event: unknown, appearance: Appearance) =>
      cb(appearance);
    ipcRenderer.on(mainChannels.appearanceChanged, listener);
    return () =>
      ipcRenderer.removeListener(mainChannels.appearanceChanged, listener);
  },
  openExternal: (url: string) =>
    ipcRenderer.invoke(mainChannels.openExternal, url),
  showOpenDialog: (options: OpenDialogOptions) =>
    ipcRenderer.invoke(mainChannels.openDialog, options),
  showSaveDialog: (options: SaveDialogOptions) =>
    ipcRenderer.invoke(mainChannels.saveDialog, options),
  keys: {
    set: (provider: string, key: string) =>
      ipcRenderer.invoke(mainChannels.keysSet, provider, key),
    status: () => ipcRenderer.invoke(mainChannels.keysStatus),
  },
  invoke(name, input) {
    const id = crypto.randomUUID();
    const result = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    post({ kind: "req", id, name, input });
    return result;
  },
  stream(name, input, onEvent) {
    const id = crypto.randomUUID();
    streams.set(id, onEvent);
    const result = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    post({ kind: "req", id, name, input });
    return {
      result,
      cancel() {
        post({ kind: "cancel", id });
      },
    };
  },
  on(name, cb) {
    const set = broadcasts.get(name) ?? new Set();
    set.add(cb);
    broadcasts.set(name, set);
    return () => set.delete(cb);
  },
  onPort(cb) {
    portListeners.add(cb);
    return () => portListeners.delete(cb);
  },
  onCoreRestarted(cb) {
    restarted = cb;
    return () => {
      if (restarted === cb) restarted = null;
    };
  },
  killCore: () => ipcRenderer.invoke("dev:killCore"),
};

contextBridge.exposeInMainWorld("pyxis", bridge);
