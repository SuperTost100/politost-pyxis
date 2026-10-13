import type { MenuCommand, MenuLanguage } from "./menu";
import type { UpdateView } from "./updates";
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
  configured: Array<"anthropic" | "openai">;
};

export interface PyxisBridge {
  platform: string;
  dev: boolean;
  /** The interface language a new profile starts in, from the computer's preferred languages. */
  systemLanguage: "it" | "en";
  getAppearance(): Promise<Appearance>;
  setAppearance(source: ThemeSource): Promise<Appearance>;
  onAppearance(cb: (appearance: Appearance) => void): () => void;
  /** Opens the system terminal, running Antigravity when asked so the student can sign in. */
  openTerminal(program?: "antigravity"): Promise<void>;
  openExternal(url: string): Promise<void>;
  showOpenDialog(options: OpenDialogOptions): Promise<string[] | null>;
  showSaveDialog(options: SaveDialogOptions): Promise<string | null>;
  /** Grants dropped files to core and returns their paths. Only real `File` objects from a drop name a path. */
  grantDroppedFiles(files: File[]): Promise<{ paths: string[]; skipped: number }>;
  keys: {
    set(provider: string, key: string): Promise<void>;
    status(): Promise<KeyStatus>;
    remove(provider: string): Promise<void>;
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
  onCoreUnavailable(cb: (unavailable: boolean) => void): () => void;
  retryCore(): Promise<void>;
  killCore(): Promise<void>;
  backupWorkspace(): Promise<"saved" | "cancelled">;
  restoreWorkspace(): Promise<"restored" | "cancelled">;
  workspacePath(): Promise<string>;
  moveWorkspace(): Promise<
    | { status: "cancelled" }
    | { status: "moved"; path: string; cleanupPending: boolean }
  >;
  wipeWorkspace(): Promise<"wiped">;
  fetchPlan(url: string): Promise<string>;
  saveArtifact(input: {
    filename: string;
    base64: string;
  }): Promise<"saved" | "cancelled">;
  exportPdf(input: {
    filename: string;
    markdown: string;
  }): Promise<"saved" | "cancelled">;
  printData(): Promise<{ markdown: string } | null>;
  printReady(): Promise<void>;
  checkUpdates(): Promise<UpdateView>;
  /** Tells main which language to write the application menu in. Main rebuilds the menu when it changes. */
  setMenuLanguage(language: MenuLanguage): Promise<void>;
  /** Runs when the student picks a menu item or presses its shortcut. Unknown commands never arrive. */
  onMenuCommand(cb: (command: MenuCommand) => void): () => void;
}

export const mainChannels = {
  coreUnavailable: "core:unavailable",
  coreRetry: "core:retry",
  appearanceGet: "appearance:get",
  appearanceSet: "appearance:set",
  appearanceChanged: "appearance:changed",
  openExternal: "shell:openExternal",
  openDialog: "dialog:open",
  saveDialog: "dialog:save",
  dropGrant: "dialog:grant-dropped",
  keysSet: "keys:set",
  keysStatus: "keys:status",
  keysRemove: "keys:remove",
  terminalOpen: "terminal:open",
  workspaceBackup: "workspace:backup",
  workspaceRestore: "workspace:restore",
  workspacePath: "workspace:path",
  workspaceMove: "workspace:move",
  workspaceWipe: "workspace:wipe",
  planFetch: "plan:fetch",
  artifactSave: "artifact:save",
  pdfExport: "artifact:pdf",
  printData: "print:data",
  printReady: "print:ready",
  updatesCheck: "updates:check",
  menuLanguage: "menu:language",
  menuCommand: "menu:command",
} as const;
