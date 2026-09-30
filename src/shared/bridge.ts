export type ThemeSource = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

export type Appearance = {
  source: ThemeSource;
  resolved: ResolvedTheme;
};

export type FileFilter = { name: string; extensions: string[] };

export type OpenDialogOptions = {
  title?: string;
  properties?: Array<"openFile" | "openDirectory" | "multiSelections">;
  filters?: FileFilter[];
};

export type SaveDialogOptions = {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
};

export type KeyStatus = {
  backend: string;
  canSave: boolean;
};

export interface PyxisBridge {
  platform: string;
  dev: boolean;
  getAppearance(): Promise<Appearance>;
  setAppearance(source: ThemeSource): Promise<Appearance>;
  onAppearance(cb: (appearance: Appearance) => void): () => void;
  openExternal(url: string): Promise<void>;
  showOpenDialog(options: OpenDialogOptions): Promise<string[] | null>;
  showSaveDialog(options: SaveDialogOptions): Promise<string | null>;
  keys: {
    set(provider: string, key: string): Promise<void>;
    status(): Promise<KeyStatus>;
  };
  invoke(name: string, input: unknown): Promise<unknown>;
  stream(
    name: string,
    input: unknown,
    onEvent: (event: unknown) => void,
  ): { result: Promise<unknown>; cancel: () => void };
  on(name: string, cb: (value: unknown) => void): () => void;
  onPort(cb: () => void): () => void;
  onCoreRestarted(cb: () => void): () => void;
  killCore(): Promise<void>;
  backupWorkspace(): Promise<"saved" | "cancelled">;
  restoreWorkspace(): Promise<"restored" | "cancelled">;
  fetchPlan(url: string): Promise<string>;
}

export const mainChannels = {
  appearanceGet: "appearance:get",
  appearanceSet: "appearance:set",
  appearanceChanged: "appearance:changed",
  openExternal: "shell:openExternal",
  openDialog: "dialog:open",
  saveDialog: "dialog:save",
  keysSet: "keys:set",
  keysStatus: "keys:status",
  workspaceBackup: "workspace:backup",
  workspaceRestore: "workspace:restore",
  planFetch: "plan:fetch",
} as const;
