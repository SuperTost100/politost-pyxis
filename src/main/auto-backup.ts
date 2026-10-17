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
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  AutoBackupFailure,
  AutoBackupFile,
  AutoBackupStatus,
} from "../shared/bridge";
import { inside } from "./workspace-move";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/**
 * Daily backups kept in the folder: the newest ones. Retention also keeps one weekly and one monthly backup (see
 * `retainedBackups`), so a computer holds at most KEEP + 2 of its own.
 */
export const KEEP = 3;
/** shortcut: Settings lists only the newest 12 backups, since each one costs unpacking its database; add paging if folders hold more. */
const MAX_LISTED = 12;
/** A backup that keeps finding jobs runs anyway after this long, so a job stuck in the queue cannot stop backups. */
export const JOB_WAIT_LIMIT = 3 * HOUR;
/**
 * Only files with exactly this name are automatic backups. Retention never touches anything else. The last part is the
 * ID of the computer that wrote it (see `AutoBackupState.backupId`); Pyxis 0.3.1 and earlier wrote names without one.
 */
export const AUTO_BACKUP_NAME =
  /^pyxis-auto-backup-\d{4}-\d{2}-\d{2}-\d{6}(?:-([0-9a-f]{8}))?\.zip$/;
const BACKUP_ID = /^[0-9a-f]{8}$/;
/** The temporary folder backupWorkspace makes beside the archive (mkdtemp adds six characters). */
const TEMPORARY_NAME = /^\.pyxis-backup-[A-Za-z0-9]{6}$/;
const FAILURES: readonly AutoBackupFailure[] = [
  "folder-missing",
  "folder-inside-data",
  "permission",
  "disk-full",
  "too-large",
  "too-many-files",
  "unverified",
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
  /**
   * Eight hex digits in the name of every automatic backup this computer writes, made on its first one. Retention only
   * deletes files with this ID, so two computers sharing a synced folder never delete each other's backups.
   */
  backupId: string | null;
};

export const initialState: AutoBackupState = {
  enabled: true,
  folder: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  last: null,
  toldTooLarge: false,
  backupId: null,
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
          ? {
              at,
              ok: true,
              size: time(last.size) ?? 0,
              // Backups recorded before Pyxis checked them were never verified.
              verified: last.verified === true,
            }
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
    backupId:
      typeof raw.backupId === "string" && BACKUP_ID.test(raw.backupId)
        ? raw.backupId
        : null,
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

/** `pyxis-auto-backup-2026-10-13-210512-1a2b3c4d.zip`, in local time so the student can read it. */
export function autoBackupName(at: Date, backupId: string): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `pyxis-auto-backup-${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}-${backupId}.zip`;
}

/**
 * The automatic backups in the folder written by one of `owners` (or by any computer), newest first. Only regular files whose whole name
 * matches the automatic pattern count; folders, links and every other file are left out. The owner of a name without
 * an ID is null.
 */
function automaticBackups(
  folder: string,
  owners: ReadonlyArray<string | null> | "all",
): string[] {
  return (
    readdirSync(folder)
      .filter((name) => {
        const match = AUTO_BACKUP_NAME.exec(name);
        return (
          match !== null &&
          (owners === "all" || owners.includes(match[1] ?? null))
        );
      })
      .filter((name) => {
        const info = lstatSync(join(folder, name));
        return info.isFile() && !info.isSymbolicLink();
      })
      // With one owner, the name holds the date and time, so it sorts by age.
      .sort()
      .reverse()
  );
}

/** The local date and time in an automatic backup's name, as a timestamp. NaN for a name that is not one. */
export function backupTime(name: string): number {
  const match = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!match) return Number.NaN;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  return new Date(year!, month! - 1, day, hour, minute, second).getTime();
}

/** Days since 1 January 1970 of the local date in a name, counted so the number does not jump at a time change. */
function backupDay(name: string): number {
  const [year, month, day] = name
    .slice("pyxis-auto-backup-".length, "pyxis-auto-backup-".length + 10)
    .split("-")
    .map(Number);
  return Math.floor(Date.UTC(year!, month! - 1, day) / DAY);
}

/** A week runs Monday to Sunday (1 January 1970 was a Thursday). */
const backupWeek = (name: string) => Math.floor((backupDay(name) + 3) / 7);
const backupMonth = (name: string) =>
  Number(name.slice(18, 22)) * 12 + Number(name.slice(23, 25));

/**
 * Which of one computer's automatic backups retention keeps: the newest `daily`, one weekly and one monthly. It replays
 * the backups from the oldest. A backup leaving the newest `daily` becomes the weekly one when it is from a later
 * calendar week than the current weekly one, and drops otherwise. The weekly one it replaces becomes the monthly one
 * when it is from a later month than the current monthly one, and drops otherwise. So at most `daily` + 2 are kept, the
 * weekly and monthly ones are always older than the newest `daily`, and a backup that was kept stays kept until a
 * newer one takes its place. Replaying what is left in the folder gives the same result as the day-by-day history.
 * `names` are the computer's backups, oldest first.
 */
export function retainedBackups(
  names: readonly string[],
  daily = KEEP,
): Set<string> {
  const recent: string[] = [];
  let weekly: string | undefined;
  let monthly: string | undefined;
  for (const name of names) {
    recent.push(name);
    if (recent.length <= daily) continue;
    const left = recent.shift()!;
    if (weekly !== undefined && backupWeek(left) <= backupWeek(weekly))
      continue;
    const replaced = weekly;
    weekly = left;
    if (
      replaced !== undefined &&
      (monthly === undefined || backupMonth(replaced) > backupMonth(monthly))
    )
      monthly = replaced;
  }
  const kept = new Set(recent);
  for (const name of [weekly, monthly]) if (name !== undefined) kept.add(name);
  return kept;
}

/**
 * Deletes this computer's automatic backups that retention does not keep (`retainedBackups`: the newest `keep` plus one
 * weekly and one monthly). Backups with another ID, and those without one, are never pruned: nothing proves this
 * computer wrote them. `written` names the backup just made: it is always kept and counts as one of the `keep`, even
 * when a clock set back gives it an older name than the rest.
 */
export function pruneAutoBackups(
  folder: string,
  backupId: string,
  keep = KEEP,
  written?: string,
): string[] {
  const all = automaticBackups(folder, [backupId]);
  const kept = retainedBackups(
    all.filter((name) => name !== written).reverse(),
    written !== undefined && all.includes(written)
      ? Math.max(keep - 1, 0)
      : keep,
  );
  const removed = all.filter((name) => name !== written && !kept.has(name));
  for (const name of removed) rmSync(join(folder, name), { force: true });
  return removed;
}

/**
 * "Delete all data": deletes this computer's automatic backups and those from Pyxis 0.3.1 and earlier, whose names have
 * no ID. The student asked for their backups to go, and an old one can't be told apart from another computer's. Backups
 * with another computer's ID stay.
 */
export function deleteAutoBackups(
  folder: string,
  backupId: string | null,
): string[] {
  const removed = automaticBackups(folder, [backupId, null]);
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

/**
 * Checks the file a manual backup is saved as. Inside the workspace it could replace `pyxis.db` with the archive (a GTK
 * save dialog doesn't add `.zip`), and a copy kept inside the workspace or the app's data is lost with it, so both are
 * refused, as for the automatic folder.
 */
export function checkBackupDestination(
  file: string,
  places: { workspace: string; userData: string },
): void {
  if (!isAbsolute(file)) throw new Error("backup-folder-missing");
  let real = file;
  try {
    real = join(realpathSync.native(dirname(file)), basename(file));
  } catch {
    // A folder that does not exist is compared by its path; the backup then fails to write there.
  }
  for (const place of [places.workspace, places.userData]) {
    let protectedPath = place;
    try {
      protectedPath = realpathSync.native(place);
    } catch {
      // A place that does not exist yet is compared by the path it will have.
    }
    if (inside(protectedPath, real) || inside(place, file))
      throw new Error("backup-destination-inside-data");
  }
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
  if (message === "backup-unverified") return "unverified";
  if (code === "ENOSPC" || code === "EDQUOT") return "disk-full";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS")
    return "permission";
  if (code === "ENOENT" || code === "ENOTDIR") return "folder-missing";
  return "failed";
}

/**
 * These end an attempt without counting as a failure: the next check simply tries again. `backup-empty`: the workspace
 * has no study data yet.
 */
const POSTPONED = new Set([
  "backup-empty",
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
  requireData: boolean,
): LiveBackupRun {
  const stop = new SharedArrayBuffer(4);
  const worker = new Worker(script, {
    workerData: {
      op: "live-backup",
      workspace,
      zip,
      stop,
      waitForJobs,
      requireData,
    },
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
  /** A manual backup, restore, move or wipe holds the workspace, or core has not opened it yet. */
  busy: () => boolean;
  /** requireData: skip a workspace with no study data (automatic backups only). */
  start: (
    zip: string,
    waitForJobs: boolean,
    requireData: boolean,
  ) => LiveBackupRun;
  /** Checks archives in a worker (the database of each one passes integrity_check); one answer per path. */
  verify: (zips: string[]) => Promise<boolean[]>;
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
  /** Archives already checked, by path, size and change time, so reopening Settings does not unpack them again. */
  private readonly verified = new Map<string, boolean>();
  private listing: Promise<AutoBackupFile[]> | null = null;
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

  /**
   * The automatic backups in the folder that can be restored, newest first: files of any computer, since a reinstall
   * gets a new ID and its own older backups then look foreign. Each is unpacked and checked once (see `verify`); one
   * that fails is left out. Only the newest MAX_LISTED are looked at.
   */
  list(): Promise<AutoBackupFile[]> {
    // Settings asks twice while it mounts; one check serves both.
    this.listing ??= this.readList().finally(() => {
      this.listing = null;
    });
    return this.listing;
  }

  private async readList(): Promise<AutoBackupFile[]> {
    const folder = this.folder();
    let names: string[];
    try {
      names = automaticBackups(folder, "all");
    } catch {
      // A folder that is not there (a drive that is not connected) has no backups to list.
      return [];
    }
    const found: Array<AutoBackupFile & { key: string }> = [];
    for (const name of names) {
      try {
        const info = statSync(join(folder, name));
        found.push({
          name,
          at: backupTime(name),
          size: info.size,
          key: `${name}|${info.size}|${info.mtimeMs}`,
        });
      } catch {
        // Deleted since the listing.
      }
      if (found.length >= MAX_LISTED) break;
    }
    // The name is the date; ties and clocks set back sort by the file name.
    found.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
    const unknown = found.filter((file) => !this.verified.has(file.key));
    if (unknown.length) {
      let answers: boolean[];
      try {
        answers = await this.deps.verify(
          unknown.map((file) => join(folder, file.name)),
        );
      } catch (error) {
        // Not knowing is not the same as broken: nothing is cached, and the list shows what is already known.
        this.deps.log?.(
          `pyxis: backups not checked (${error instanceof Error ? error.message : "unknown"})`,
        );
        answers = [];
      }
      unknown.forEach((file, index) => {
        if (answers[index] !== undefined)
          this.verified.set(file.key, answers[index]!);
      });
    }
    return found
      .filter((file) => this.verified.get(file.key) === true)
      .map(({ name, at, size }) => ({ name, at, size }));
  }

  /**
   * The path of a backup the student picked from the list. The name is checked against the automatic pattern and must be
   * a regular file in the backup folder, so a name from the renderer cannot reach another path.
   */
  resolve(name: string): string {
    if (!AUTO_BACKUP_NAME.test(name)) throw new Error("backup-missing");
    const path = join(this.folder(), name);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("not-file");
    } catch {
      throw new Error("backup-missing");
    }
    return path;
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

  /**
   * "Delete all data" with the backups ticked: removes this computer's automatic backups and those without an ID (see
   * deleteAutoBackups), and leftover temporary folders, with the same name checks as retention, so nothing else in the
   * folder is touched. The last result named a file that is gone,
   * so it is forgotten; the time of the last success stays, so a new backup does not start right away. Throws
   * backup-folder-missing when a chosen folder can't be reached, because its backups may still be there.
   */
  deleteBackups(): void {
    const state = this.state();
    const folder = this.folder(state);
    this.notice = null;
    this.dismissed = null;
    this.save({ ...state, last: null, toldTooLarge: false });
    if (!existsSync(folder)) {
      if (state.folder === null) return;
      throw new Error("backup-folder-missing");
    }
    deleteAutoBackups(folder, state.backupId);
    // An infinite now makes every temporary folder count as stale. The caller holds the workspace, so none is in use.
    removeStaleTemporaries(folder, Number.POSITIVE_INFINITY);
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

  /**
   * "Back up now": the same folder and file names, without waiting for jobs or for the day to pass. It backs up an empty
   * workspace too, since the student asked for it.
   */
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
    let backupId = "";
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
      backupId = this.backupId();
      let at = started;
      let zip = join(folder, autoBackupName(new Date(at), backupId));
      // Two backups in the same second must not replace each other.
      while (existsSync(zip)) {
        at += 1000;
        zip = join(folder, autoBackupName(new Date(at), backupId));
      }
      run = this.deps.start(zip, waitForJobs, automatic);
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
          // The worker checks the archive before it reports success, so a backup that got here verified.
          last: { at: started, ok: true, size, verified: true },
          toldTooLarge: false,
        });
        this.remember(zip);
      }
      this.tidy(folder, backupId, basename(zip));
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

  /** Records that a backup this run just wrote and checked needs no second look. */
  private remember(zip: string): void {
    try {
      const info = statSync(zip);
      this.verified.set(`${basename(zip)}|${info.size}|${info.mtimeMs}`, true);
    } catch {
      // Gone already; the list checks whatever is there.
    }
  }

  /** This computer's ID for backup names. The first backup makes it and saves it before any file carries it. */
  private backupId(): string {
    const state = this.state();
    if (state.backupId) return state.backupId;
    const backupId = randomBytes(4).toString("hex");
    writeAutoBackupState(this.deps.stateFile, { ...state, backupId });
    return backupId;
  }

  private tidy(folder: string, backupId: string, written: string): void {
    try {
      pruneAutoBackups(folder, backupId, KEEP, written);
      removeStaleTemporaries(folder, this.now());
    } catch (error) {
      // The new backup is safe; an old one that could not be removed is tried again after the next backup.
      this.deps.log?.(
        `pyxis: old automatic backups not removed (${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
      );
    }
  }
}
