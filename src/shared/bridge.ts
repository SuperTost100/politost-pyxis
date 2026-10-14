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

/** Why an automatic backup did not finish. The renderer names the reason and the fix. */
export type AutoBackupFailure =
  | "folder-missing"
  | "folder-inside-data"
  | "permission"
  | "disk-full"
  | "too-large"
  | "too-many-files"
  | "failed";

export type AutoBackupStatus = {
  enabled: boolean;
  /** The folder backups go to: the chosen one, or "Pyxis backups" in Documents. */
  folder: string;
  isDefaultFolder: boolean;
  running: boolean;
  lastSuccessAt: number | null;
  last:
    | { at: number; ok: true; size: number }
    | { at: number; ok: false; reason: AutoBackupFailure; size?: number }
    | null;
  /** A failed automatic backup the student has not dismissed yet. */
  notice: AutoBackupFailure | null;
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
  autoBackups: {
    status(): Promise<AutoBackupStatus>;
    setEnabled(enabled: boolean): Promise<AutoBackupStatus>;
    /** Opens a folder picker. Rejects with `backup-folder-inside-data`, `backup-folder-permission` or `backup-folder-missing`. */
    chooseFolder(): Promise<AutoBackupStatus | null>;
    openFolder(): Promise<void>;
    /** Backs up to the automatic folder now, without waiting for jobs. */
    runNow(): Promise<AutoBackupStatus>;
    dismissNotice(): Promise<AutoBackupStatus>;
    onStatus(cb: (status: AutoBackupStatus) => void): () => void;
  };
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
  autoBackupStatus: "auto-backup:status",
  autoBackupSetEnabled: "auto-backup:set-enabled",
  autoBackupChooseFolder: "auto-backup:choose-folder",
  autoBackupOpenFolder: "auto-backup:open-folder",
  autoBackupRunNow: "auto-backup:run-now",
  autoBackupDismiss: "auto-backup:dismiss",
  autoBackupChanged: "auto-backup:changed",
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
