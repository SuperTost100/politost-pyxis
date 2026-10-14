import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { Worker } from "node:worker_threads";
import type { AutoBackupFailure, AutoBackupStatus } from "../shared/bridge";
import { inside } from "./workspace-move";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Automatic backups kept in the folder. Older ones Pyxis made are deleted. */
export const KEEP = 3;
/** A backup that keeps finding jobs runs anyway after this long, so a job stuck in the queue cannot stop backups. */
export const JOB_WAIT_LIMIT = 3 * HOUR;
/** Only files with exactly this name are automatic backups. Retention never touches anything else. */
export const AUTO_BACKUP_NAME =
  /^pyxis-auto-backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/;
/** The temporary folder backupWorkspace makes beside the archive (mkdtemp adds six characters). */
const TEMPORARY_NAME = /^\.pyxis-backup-[A-Za-z0-9]{6}$/;
const FAILURES: readonly AutoBackupFailure[] = [
  "folder-missing",
  "folder-inside-data",
  "permission",
  "disk-full",
  "too-large",
  "too-many-files",
  "failed",
];

export type AutoBackupState = {
  enabled: boolean;
  /** null: "Pyxis backups" in Documents. */
  folder: string | null;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  last: AutoBackupStatus["last"];
  /** The too-large notice was shown once; it stays quiet until a backup succeeds again. */
  toldTooLarge: boolean;
};

export const initialState: AutoBackupState = {
  enabled: true,
  folder: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  last: null,
  toldTooLarge: false,
};

const time = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

/** Reads the saved settings. A missing or damaged file gives the defaults: on, in Documents. */
export function readAutoBackupState(file: string): AutoBackupState {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { ...initialState };
  } catch {
    return { ...initialState };
  }
  const last = raw.last as Record<string, unknown> | null | undefined;
  const at = time(last?.at);
  return {
    enabled: raw.enabled !== false,
    folder:
      typeof raw.folder === "string" && isAbsolute(raw.folder)
        ? raw.folder
        : null,
    lastSuccessAt: time(raw.lastSuccessAt),
    lastAttemptAt: time(raw.lastAttemptAt),
    last:
      at === null
        ? null
        : last?.ok === true
          ? { at, ok: true, size: time(last.size) ?? 0 }
          : FAILURES.includes(last?.reason as AutoBackupFailure)
            ? {
                at,
                ok: false,
                reason: last!.reason as AutoBackupFailure,
                ...(time(last!.size) !== null
                  ? { size: time(last!.size)! }
                  : {}),
              }
            : null,
    toldTooLarge: raw.toldTooLarge === true,
  };
}

export function writeAutoBackupState(
  file: string,
  state: AutoBackupState,
): void {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2));
  renameSync(temporary, file);
}

/** Whether an automatic backup should run now: on, a day after the last success, and not right after a failure. */
export function backupDue(state: AutoBackupState, now: number): boolean {
  if (!state.enabled) return false;
  // A clock set back makes "now" earlier than the last backup; that must not stop backups for days.
  const elapsed = (at: number | null) =>
    at === null || now < at || now - at >= DAY;
  if (!elapsed(state.lastSuccessAt)) return false;
  if (state.last && !state.last.ok && state.lastAttemptAt !== null) {
    // Too large stays too large until the student removes something: try once a day. Other causes (a drive that is not
    // connected, a full disk) can clear at any time: try every hour.
    const wait = state.last.reason === "too-large" ? DAY : HOUR;
    if (now >= state.lastAttemptAt && now - state.lastAttemptAt < wait)
      return false;
  }
  return true;
}

/** `pyxis-auto-backup-2026-10-13-210512.zip`, in local time so the student can read it. */
export function autoBackupName(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `pyxis-auto-backup-${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}.zip`;
}

/**
 * Deletes automatic backups beyond the newest `keep`. Only regular files whose whole name matches the automatic
 * pattern count; folders, links and every other file in the folder are left alone. `written` names the backup just
 * made: it is always kept and counts as one of the `keep`, even when a clock set back gives it an older name than the
 * rest.
 */
export function pruneAutoBackups(
  folder: string,
  keep = KEEP,
  written?: string,
): string[] {
  const all = readdirSync(folder)
    .filter((name) => AUTO_BACKUP_NAME.test(name))
    .filter((name) => {
      const info = lstatSync(join(folder, name));
      return info.isFile() && !info.isSymbolicLink();
    })
    // The name holds the date and time, so it sorts by age.
    .sort()
    .reverse();
  const kept = written !== undefined && all.includes(written);
  const removed = all
    .filter((name) => name !== written)
    .slice(kept ? Math.max(keep - 1, 0) : keep);
  for (const name of removed) rmSync(join(folder, name), { force: true });
  return removed;
}

/**
 * Removes temporary folders a backup left when Pyxis was closed in the middle of it. Only a folder with the exact
 * temporary name, older than a day, that holds nothing but the backup's own two files.
 */
export function removeStaleTemporaries(folder: string, now: number): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(folder)) {
    if (!TEMPORARY_NAME.test(name)) continue;
    const path = join(folder, name);
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    if (now - info.mtimeMs < DAY) continue;
    const entries = readdirSync(path);
    if (
      entries.some(
        (entry) =>
          !["pyxis.db", "backup.zip"].includes(entry) ||
          !lstatSync(join(path, entry)).isFile(),
      )
    )
      continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * Checks a backup folder and returns its real path. A folder inside the workspace or inside the app's own data would be
 * lost together with the data it protects, so both are refused. The folder must exist and accept new files.
 */
export function checkBackupFolder(
  folder: string,
  places: { workspace: string; userData: string },
): string {
  if (!isAbsolute(folder)) throw new Error("backup-folder-missing");
  let real: string;
  try {
    real = realpathSync.native(folder);
    if (!statSync(real).isDirectory()) throw new Error("not-a-directory");
  } catch {
    throw new Error("backup-folder-missing");
  }
  for (const place of [places.workspace, places.userData]) {
    let protectedPath = place;
    try {
      protectedPath = realpathSync.native(place);
    } catch {
      // A place that does not exist yet is compared by the path it will have.
    }
    if (inside(protectedPath, real) || inside(place, folder))
      throw new Error("backup-folder-inside-data");
  }
  try {
    rmSync(mkdtempSync(join(real, ".pyxis-check-")), { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOSPC" || code === "EDQUOT") return real;
    throw new Error("backup-folder-permission");
  }
  return real;
}

/** Turns a worker or file-system error into the reason the student sees. */
export function failureReason(
  message: string,
  code?: string,
): AutoBackupFailure {
  if (message.startsWith("backup-too-large")) return "too-large";
  if (message === "backup-too-many-files") return "too-many-files";
  if (message === "backup-folder-missing") return "folder-missing";
  if (message === "backup-folder-inside-data") return "folder-inside-data";
  if (message === "backup-folder-permission") return "permission";
  if (code === "ENOSPC" || code === "EDQUOT") return "disk-full";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS")
    return "permission";
  if (code === "ENOENT" || code === "ENOTDIR") return "folder-missing";
  return "failed";
}

/** These end an attempt without counting as a failure: the next check simply tries again. */
const POSTPONED = new Set([
  "backup-jobs-active",
  "backup-changed",
  "backup-cancelled",
]);

export class BackupError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export type LiveBackupRun = {
  done: Promise<void>;
  /** Asks the copy to stop and resolves once it has. */
  stop(): Promise<void>;
};

/**
 * Runs a live backup in a worker thread: core keeps running and the main thread stays free. Stop sets a shared flag the
 * copy checks between chunks; a copy stuck in one long step is terminated after a grace period and its temporary folder
 * removed here.
 */
export function startLiveBackupWorker(
  script: string,
  workspace: string,
  zip: string,
  waitForJobs: boolean,
): LiveBackupRun {
  const stop = new SharedArrayBuffer(4);
  const worker = new Worker(script, {
    workerData: { op: "live-backup", workspace, zip, stop, waitForJobs },
  });
  let temporary: string | undefined;
  let exited = false;
  const finished = new Promise<void>((resolve) =>
    worker.once("exit", () => {
      exited = true;
      resolve();
    }),
  );
  const done = new Promise<void>((resolve, reject) => {
    worker.on(
      "message",
      (message: {
        temporary?: string;
        ok?: boolean;
        message?: string;
        code?: string;
      }) => {
        if (message.temporary) {
          temporary = message.temporary;
          return;
        }
        if (message.ok) resolve();
        else
          reject(
            new BackupError(message.message || "backup-failed", message.code),
          );
      },
    );
    worker.once("error", (error) =>
      reject(
        new BackupError(
          error instanceof Error ? error.message : "backup-failed",
        ),
      ),
    );
    void finished.then(() => reject(new BackupError("backup-cancelled")));
  });
  done.catch(() => undefined);
  return {
    done,
    async stop() {
      Atomics.store(new Int32Array(stop), 0, 1);
      let timer: NodeJS.Timeout | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 15_000);
      });
      await Promise.race([finished, grace]);
      clearTimeout(timer);
      if (!exited) {
        await worker.terminate();
        if (temporary) rmSync(temporary, { recursive: true, force: true });
      }
    },
  };
}

export type AutoBackupDeps = {
  stateFile: string;
  /** "Pyxis backups" in Documents. Created when it is the destination and missing. */
  defaultFolder: () => string;
  workspace: () => string;
  userData: string;
  /** A manual backup, restore, move or wipe holds the workspace. */
  busy: () => boolean;
  start: (zip: string, waitForJobs: boolean) => LiveBackupRun;
  changed: (status: AutoBackupStatus) => void;
  now?: () => number;
  log?: (message: string) => void;
};

/**
 * Automatic backups while the app is open. A check runs shortly after launch and then on an interval; it backs up when
 * the last success is a day old, skips while the workspace is busy, and waits for jobs. Nothing here stops core.
 */
export class AutoBackups {
  private current: LiveBackupRun | null = null;
  private notice: AutoBackupFailure | null = null;
  private dismissed: AutoBackupFailure | null = null;
  private waitingSince: number | null = null;
  private timers: NodeJS.Timeout[] = [];
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly deps: AutoBackupDeps) {
    this.now = deps.now ?? Date.now;
    const state = this.state();
    // A failure from the last session is still a failure: say so again, except too-large, which is said once.
    if (
      state.enabled &&
      state.last &&
      !state.last.ok &&
      state.last.reason !== "too-large"
    )
      this.notice = state.last.reason;
  }

  private state(): AutoBackupState {
    return readAutoBackupState(this.deps.stateFile);
  }

  private save(state: AutoBackupState): void {
    writeAutoBackupState(this.deps.stateFile, state);
    this.deps.changed(this.status());
  }

  get running(): boolean {
    return this.current !== null;
  }

  folder(state = this.state()): string {
    return state.folder ?? this.deps.defaultFolder();
  }

  status(): AutoBackupStatus {
    const state = this.state();
    return {
      enabled: state.enabled,
      folder: this.folder(state),
      isDefaultFolder: state.folder === null,
      running: this.current !== null,
      lastSuccessAt: state.lastSuccessAt,
      last: state.last,
      notice:
        state.enabled && this.notice && this.notice !== this.dismissed
          ? this.notice
          : null,
    };
  }

  /** Starts the checks. Until then nothing backs up on its own (tests without a Documents folder never start them). */
  start(firstCheckIn: number, every: number): void {
    this.timers.push(
      setTimeout(() => void this.check(), firstCheckIn),
      setInterval(() => void this.check(), every),
    );
  }

  /** Stops the timers for good. Quitting calls it first, so no check starts a backup while Pyxis closes. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  setEnabled(enabled: boolean): AutoBackupStatus {
    const state = this.state();
    this.save({ ...state, enabled });
    if (enabled && this.timers.length) void this.check();
    return this.status();
  }

  /** Saves a folder that checkBackupFolder accepted. A new folder gets a fresh start: its first check backs up. */
  setFolder(folder: string): AutoBackupStatus {
    const state = this.state();
    this.notice = null;
    this.dismissed = null;
    this.save({
      ...state,
      folder,
      lastSuccessAt: null,
      lastAttemptAt: null,
      last: null,
    });
    if (this.timers.length) void this.check();
    return this.status();
  }

  dismissNotice(): AutoBackupStatus {
    this.dismissed = this.notice;
    this.deps.changed(this.status());
    return this.status();
  }

  /** Stops a running backup and waits for it, so a manual backup, restore, move or wipe can take the workspace. */
  async stop(): Promise<void> {
    const run = this.current;
    if (run) await run.stop();
  }

  /** The automatic check. Returns what it did, for tests and logs. */
  async check(): Promise<
    "off" | "not-due" | "busy" | "running" | "saved" | "postponed" | "failed"
  > {
    if (this.disposed) return "off";
    if (this.current) return "running";
    const state = this.state();
    if (!state.enabled) return "off";
    if (!backupDue(state, this.now())) return "not-due";
    if (this.deps.busy()) return "busy";
    const waitForJobs =
      this.waitingSince === null ||
      this.now() - this.waitingSince < JOB_WAIT_LIMIT;
    return this.run(waitForJobs, true);
  }

  /** "Back up now": the same folder and file names, without waiting for jobs or for the day to pass. */
  async runNow(): Promise<AutoBackupStatus> {
    if (this.current || this.deps.busy()) throw new Error("workspace-busy");
    const result = await this.run(false, false);
    if (result === "postponed") throw new Error("backup-changed");
    return this.status();
  }

  private async run(
    waitForJobs: boolean,
    automatic: boolean,
  ): Promise<"saved" | "postponed" | "failed"> {
    const started = this.now();
    const startState = this.state();
    let folder = this.folder(startState);
    let run: LiveBackupRun | null = null;
    // The student can choose another folder while the copy runs. The result then belongs to the old folder: recording
    // it would tell the new folder it has a backup when it has none.
    const folderChanged = () => this.state().folder !== startState.folder;
    try {
      if (!existsSync(join(this.deps.workspace(), "pyxis.db")))
        return "postponed";
      if (this.state().folder === null) mkdirSync(folder, { recursive: true });
      folder = checkBackupFolder(folder, {
        workspace: this.deps.workspace(),
        userData: this.deps.userData,
      });
      let at = started;
      let zip = join(folder, autoBackupName(new Date(at)));
      // Two backups in the same second must not replace each other.
      while (existsSync(zip)) {
        at += 1000;
        zip = join(folder, autoBackupName(new Date(at)));
      }
      run = this.deps.start(zip, waitForJobs);
      this.current = run;
      this.deps.changed(this.status());
      await run.done;
      this.waitingSince = null;
      const size = statSync(zip).size;
      if (!folderChanged()) {
        this.notice = null;
        this.dismissed = null;
        this.save({
          ...this.state(),
          lastSuccessAt: started,
          lastAttemptAt: started,
          last: { at: started, ok: true, size },
          toldTooLarge: false,
        });
      }
      this.tidy(folder, basename(zip));
      return "saved";
    } catch (error) {
      const message = error instanceof Error ? error.message : "backup-failed";
      const code =
        error instanceof BackupError
          ? error.code
          : (error as NodeJS.ErrnoException)?.code;
      if (message === "backup-jobs-active") this.waitingSince ??= started;
      if (folderChanged()) {
        this.deps.log?.(
          `pyxis: automatic backup ended after the folder changed (${message})`,
        );
        return "postponed";
      }
      if (POSTPONED.has(message)) {
        this.deps.log?.(`pyxis: automatic backup postponed (${message})`);
        return "postponed";
      }
      const reason = failureReason(message, code);
      const size = /^backup-too-large:(\d+)$/.exec(message)?.[1];
      const state = this.state();
      let toldTooLarge = state.toldTooLarge;
      if (automatic && (reason !== "too-large" || !toldTooLarge)) {
        this.notice = reason;
        if (this.dismissed !== reason) this.dismissed = null;
        if (reason === "too-large") toldTooLarge = true;
      }
      this.deps.log?.(`pyxis: automatic backup failed (${reason})`);
      this.save({
        ...state,
        lastAttemptAt: started,
        last: {
          at: started,
          ok: false,
          reason,
          ...(size ? { size: Number(size) } : {}),
        },
        toldTooLarge,
      });
      return "failed";
    } finally {
      if (run && this.current === run) {
        this.current = null;
        this.deps.changed(this.status());
        // setFolder's own check found this run still going; the new folder gets its first backup now.
        if (folderChanged() && this.timers.length) void this.check();
      }
    }
  }

  private tidy(folder: string, written: string): void {
    try {
      pruneAutoBackups(folder, KEEP, written);
      removeStaleTemporaries(folder, this.now());
    } catch (error) {
      // The new backup is safe; an old one that could not be removed is tried again after the next backup.
      this.deps.log?.(
        `pyxis: old automatic backups not removed (${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
      );
    }
  }
}
