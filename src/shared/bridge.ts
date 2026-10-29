import type { ErrorFields } from "./error-fields";
import type { MenuCommand, MenuLanguage } from "./menu";
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
  /** The finished archive failed its check (see `verifyBackupArchive`) and was deleted. */
  | "unverified"
  | "failed";

export type AutoBackupStatus = {
  enabled: boolean;
  /** The folder backups go to: the chosen one, or "Pyxis backups" in Documents. */
  folder: string;
  isDefaultFolder: boolean;
  running: boolean;
  lastSuccessAt: number | null;
  last:
    | { at: number; ok: true; size: number; verified: boolean }
    | { at: number; ok: false; reason: AutoBackupFailure; size?: number }
    | null;
  /** A failed automatic backup the student has not dismissed yet. */
  notice: AutoBackupFailure | null;
};

/**
 * An automatic backup in the folder that can be restored. `at` is the time in its name. `verified` is false when the
 * check could not run for it (drive unplugged, temporary folder full); restoring it checks it again. A copy that
 * failed its check is not listed.
 */
export type AutoBackupFile = {
  name: string;
  at: number;
  size: number;
  verified: boolean;
};

/** Study reminders: off by default; `time` is local, "HH:MM". */
export type ReminderSettings = { enabled: boolean; time: string };
/** The settings, and whether this system can show notifications at all. */
export type ReminderView = ReminderSettings & { supported: boolean };

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
  /** Without a name, asks for a backup file. With the name of an automatic backup from `autoBackups.list`, restores that one. */
  restoreWorkspace(backup?: string): Promise<"restored" | "cancelled">;
  workspacePath(): Promise<string>;
  moveWorkspace(): Promise<
    | { status: "cancelled" }
    | { status: "moved"; path: string; cleanupPending: boolean }
  >;
  /** With backups, also deletes the automatic backups. "wiped-backups-left": the data is gone, the backups could not be. */
  wipeWorkspace(options: { backups: boolean }): Promise<"wiped" | "wiped-backups-left">;
  autoBackups: {
    status(): Promise<AutoBackupStatus>;
    setEnabled(enabled: boolean): Promise<AutoBackupStatus>;
    /** Opens a folder picker. Rejects with `backup-folder-inside-data`, `backup-folder-permission` or `backup-folder-missing`. */
    chooseFolder(): Promise<AutoBackupStatus | null>;
    openFolder(): Promise<void>;
    /** Backs up to the automatic folder now, without waiting for jobs. */
    runNow(): Promise<AutoBackupStatus>;
    dismissNotice(): Promise<AutoBackupStatus>;
    /** The automatic backups that passed their check, newest first. Unpacks ones not checked yet, so it can take a while. */
    list(): Promise<AutoBackupFile[]>;
    onStatus(cb: (status: AutoBackupStatus) => void): () => void;
  };
  reminders: {
    get(): Promise<ReminderView>;
    /** Rejects with `invalid-setting` for a time that is not "HH:MM". */
    set(settings: ReminderSettings): Promise<ReminderView>;
  };
  /** A page main asks the app to open, such as a click on a study reminder. Only a plan page or Flashcards. */
  onOpenPath(cb: (path: string) => void): () => void;
  fetchPlan(url: string): Promise<string>;
  /**
   * Plan files the system opened with Pyxis (double-click, Open with, a second launch). Main keeps the path, so the
   * renderer cannot name one; it only asks for the file that is waiting.
   */
  openedPlan: {
    /** The waiting plan file's text, once; null when none is waiting. */
    take(): Promise<OpenedPlan | null>;
    /** A plan file is waiting. Runs whenever one is opened while the window is up. */
    onWaiting(cb: () => void): () => void;
  };
  saveArtifact(input: {
    filename: string;
    base64: string;
  }): Promise<"saved" | "cancelled">;
  /** `svg` is a concept map's drawing, printed on its own page before the Markdown. */
  exportPdf(input: {
    filename: string;
    markdown: string;
    svg?: string;
  }): Promise<"saved" | "cancelled">;
  printData(): Promise<{ markdown: string; svg?: string } | null>;
  printReady(): Promise<void>;
  /** `force` is for a student asking again: it skips the cache, though main still waits a minute between requests. */
  checkUpdates(force?: boolean): Promise<UpdateView>;
  /** Tells main which language to write the application menu in. Main rebuilds the menu when it changes. */
  setMenuLanguage(language: MenuLanguage): Promise<void>;
  /** Runs when the student picks a menu item or presses its shortcut. Unknown commands never arrive. */
  onMenuCommand(cb: (command: MenuCommand) => void): () => void;
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
  /**
   * Hands a window error to main's crash reporter. Main drops it at once while the crash-report switch is off, and
   * otherwise scrubs it before it is stored or sent (src/main/crash-reports.ts).
   */
  reportError(fields: ErrorFields): void;
}

export const mainChannels = {
  coreUnavailable: "core:unavailable",
  coreRetry: "core:retry",
  appearanceGet: "appearance:get",
  appearanceSet: "appearance:set",
  appearanceChanged: "appearance:changed",
  openExternal: "shell:openExternal",
  openDialog: "dialog:open",
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
  autoBackupList: "auto-backup:list",
  remindersGet: "reminders:get",
  remindersSet: "reminders:set",
  openPath: "app:open-path",
  planFetch: "plan:fetch",
  planFileTake: "plan-file:take",
  planFileWaiting: "plan-file:waiting",
  artifactSave: "artifact:save",
  pdfExport: "artifact:pdf",
  printData: "print:data",
  printReady: "print:ready",
  updatesCheck: "updates:check",
  menuLanguage: "menu:language",
  menuCommand: "menu:command",
  updatesInstall: "updates:install",
  updatesCancel: "updates:cancel",
  updatesState: "updates:state",
  updatesChanged: "updates:changed",
  updatesReveal: "updates:reveal",
  updatesFinish: "updates:finish",
  crashReport: "crash:report",
} as const;

/** The most a plan file opened from disk or dropped on the window may hold: as much as a linked plan (`MAX_LINKED_PLAN_BYTES`). */
export const MAX_OPENED_PLAN_BYTES = 320 * 1024 * 1024;

/** A plan file the system opened with Pyxis, read in main. */
export type OpenedPlan =
  | { ok: true; text: string }
  | { ok: false; reason: "not-a-plan-file" | "too-big" | "unreadable" };
