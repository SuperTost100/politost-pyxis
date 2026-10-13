import type {
  UpdateFinishResult,
  UpdateInstallView,
  UpdateView,
} from "./updates";
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
  /** Downloads and verifies the installer for this computer. Only a click on Download and install calls it. */
  installUpdate(): Promise<void>;
  /** Stops a running download, or clears a finished or failed one. */
  cancelUpdate(): Promise<void>;
  updateState(): Promise<UpdateInstallView>;
  onUpdateState(cb: (view: UpdateInstallView) => void): () => void;
  /** Opens the disk image again, or shows the downloaded file in its folder again. */
  revealUpdate(): Promise<void>;
  /** Closes Pyxis to finish the update, once workspace work is done and running jobs are confirmed. */
  finishUpdate(input: {
    activeJobs: number;
    confirmed: boolean;
  }): Promise<UpdateFinishResult>;
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
  updatesInstall: "updates:install",
  updatesCancel: "updates:cancel",
  updatesState: "updates:state",
  updatesChanged: "updates:changed",
  updatesReveal: "updates:reveal",
  updatesFinish: "updates:finish",
} as const;
