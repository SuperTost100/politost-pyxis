import { contextBridge, ipcRenderer } from "electron";
import {
  mainChannels,
  type Appearance,
  type OpenDialogOptions,
  type PyxisBridge,
  type SaveDialogOptions,
  type ThemeSource,
} from "../shared/bridge";

const bridge: PyxisBridge = {
  platform: process.platform,
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
};

contextBridge.exposeInMainWorld("pyxis", bridge);
