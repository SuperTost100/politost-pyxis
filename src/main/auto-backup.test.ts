import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_BACKUP_NAME,
  AutoBackups,
  BackupError,
  DAY,
  JOB_WAIT_LIMIT,
  autoBackupName,
  backupDue,
  checkBackupFolder,
  failureReason,
  initialState,
  pruneAutoBackups,
  readAutoBackupState,
  removeStaleTemporaries,
  writeAutoBackupState,
  type AutoBackupDeps,
  type LiveBackupRun,
} from "./auto-backup";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pyxis-auto-backup-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(root, 0o700);
    } catch {
      // Already gone.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const HOUR = 60 * 60 * 1000;
const NOON = new Date(2026, 9, 13, 12, 0, 0).getTime();

describe("backupDue", () => {
  it("is due with no backup yet, then not again until a day has passed", () => {
    expect(backupDue(initialState, NOON)).toBe(true);
    const done = { ...initialState, lastSuccessAt: NOON, lastAttemptAt: NOON };
    expect(backupDue(done, NOON + HOUR)).toBe(false);
    // Later the same day, even across midnight: still not twice in 24 hours.
    expect(backupDue(done, NOON + 23 * HOUR)).toBe(false);
    expect(backupDue(done, NOON + DAY)).toBe(true);
  });

  it("is never due while off", () => {
    expect(backupDue({ ...initialState, enabled: false }, NOON)).toBe(false);
  });

  it("retries a failure after an hour, and a too-large workspace after a day", () => {
    const failed = (reason: "folder-missing" | "too-large") => ({
      ...initialState,
      lastAttemptAt: NOON,
      last: { at: NOON, ok: false as const, reason },
    });
    expect(backupDue(failed("folder-missing"), NOON + 59 * 60 * 1000)).toBe(
      false,
    );
    expect(backupDue(failed("folder-missing"), NOON + HOUR)).toBe(true);
    expect(backupDue(failed("too-large"), NOON + 12 * HOUR)).toBe(false);
    expect(backupDue(failed("too-large"), NOON + DAY)).toBe(true);
  });

  it("is due when the clock was set back past the last backup", () => {
    const done = { ...initialState, lastSuccessAt: NOON, lastAttemptAt: NOON };
    expect(backupDue(done, NOON - HOUR)).toBe(true);
  });
});

describe("saved settings", () => {
  it("default to on in Documents and survive a damaged file", () => {
    const root = tempRoot();
    const file = join(root, "backups.json");
    expect(readAutoBackupState(file)).toEqual(initialState);
    writeFileSync(file, "{not json");
    expect(readAutoBackupState(file)).toEqual(initialState);
    writeFileSync(
      file,
      JSON.stringify({
        enabled: "no",
        folder: "relative/path",
        lastSuccessAt: -1,
        last: { at: 5, ok: false, reason: "made-up" },
      }),
    );
    expect(readAutoBackupState(file)).toEqual(initialState);
    const saved = {
      ...initialState,
      enabled: false,
      folder: root,
      lastSuccessAt: 10,
      lastAttemptAt: 20,
      last: {
        at: 20,
        ok: false as const,
        reason: "too-large" as const,
        size: 3,
      },
      toldTooLarge: true,
    };
    writeAutoBackupState(file, saved);
    expect(readAutoBackupState(file)).toEqual(saved);
    expect(readdirSync(root)).toEqual(["backups.json"]);
  });
});

describe("retention", () => {
  it("names backups by local date and time so they sort by age", () => {
    const name = autoBackupName(new Date(2026, 0, 2, 3, 4, 5));
    expect(name).toBe("pyxis-auto-backup-2026-01-02-030405.zip");
    expect(AUTO_BACKUP_NAME.test(name)).toBe(true);
  });

  it("keeps the newest three automatic backups and touches nothing else", () => {
    const folder = tempRoot();
    const automatic = [1, 2, 3, 4, 5].map((day) =>
      autoBackupName(new Date(2026, 9, day, 9, 0, 0)),
    );
    for (const name of automatic) writeFileSync(join(folder, name), "zip");
    const others = [
      "pyxis-backup.zip",
      "notes.txt",
      `${automatic[0]}.part`,
      "pyxis-auto-backup-2026-10-01-0900.zip",
      // Differently cased, on a date no real backup here uses: macOS and Windows would treat the same name as one file.
      "Pyxis-auto-backup-2026-10-09-090000.zip",
    ];
    for (const name of others) writeFileSync(join(folder, name), "keep");
    // A folder and a link with a backup's name are not files Pyxis wrote.
    mkdirSync(join(folder, autoBackupName(new Date(2020, 0, 1, 0, 0, 0))));
    const outside = join(tempRoot(), "outside.zip");
    writeFileSync(outside, "outside");
    symlinkSync(
      outside,
      join(folder, autoBackupName(new Date(2020, 0, 2, 0, 0, 0))),
    );

    expect(pruneAutoBackups(folder).sort()).toEqual(automatic.slice(0, 2));
    const left = readdirSync(folder);
    for (const name of [...automatic.slice(2), ...others])
      expect(left).toContain(name);
    expect(left).toHaveLength(3 + others.length + 2);
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  it("never prunes the backup just written, even when the clock went back", () => {
    const folder = tempRoot();
    const older = [1, 2, 3].map((day) =>
      autoBackupName(new Date(2026, 9, day, 9, 0, 0)),
    );
    // The clock was set back a year, so the new backup sorts before every old one.
    const written = autoBackupName(new Date(2025, 9, 1, 9, 0, 0));
    for (const name of [...older, written])
      writeFileSync(join(folder, name), "zip");

    // Without the name the oldest-looking file is pruned: that is the bug this guards.
    expect(pruneAutoBackups(folder, 3, written)).toEqual([older[0]]);
    expect(readdirSync(folder).sort()).toEqual([written, older[1], older[2]]);
    expect(pruneAutoBackups(folder, 3, written)).toEqual([]);
  });

  it("removes only stale temporary folders a backup left behind", () => {
    const folder = tempRoot();
    const old = (Date.now() - 2 * DAY) / 1000;
    const make = (name: string, files: string[], stale = true) => {
      mkdirSync(join(folder, name));
      for (const file of files) writeFileSync(join(folder, name, file), "x");
      if (stale) utimesSync(join(folder, name), old, old);
    };
    make(".pyxis-backup-abc123", ["pyxis.db", "backup.zip"]);
    make(".pyxis-backup-def456", ["pyxis.db"], false);
    make(".pyxis-backup-ghi789", ["pyxis.db", "thesis.docx"]);
    make(".pyxis-backup-toolong1", ["pyxis.db"]);
    make("pyxis-backup-abc123", ["pyxis.db"]);
    expect(removeStaleTemporaries(folder, Date.now())).toEqual([
      ".pyxis-backup-abc123",
    ]);
    expect(readdirSync(folder).sort()).toEqual([
      ".pyxis-backup-def456",
      ".pyxis-backup-ghi789",
      ".pyxis-backup-toolong1",
      "pyxis-backup-abc123",
    ]);
  });
});

describe("checkBackupFolder", () => {
  function places() {
    const root = tempRoot();
    const userData = join(root, "userData");
    const workspace = join(userData, "workspace");
    const moved = join(root, "Moved", "Pyxis workspace");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(moved, { recursive: true });
    return { root, userData, workspace, moved };
  }

  it("accepts a folder outside the data and returns its real path", () => {
    const p = places();
    const folder = join(p.root, "Documents", "Pyxis backups");
    mkdirSync(folder, { recursive: true });
    expect(
      checkBackupFolder(folder, {
        workspace: p.workspace,
        userData: p.userData,
      }),
    ).toBe(realpathSync.native(folder));
    // The write probe leaves nothing behind.
    expect(readdirSync(folder)).toEqual([]);
    // Next to a moved workspace is fine: only inside it is refused.
    expect(
      checkBackupFolder(join(p.root, "Moved"), {
        workspace: p.moved,
        userData: p.userData,
      }),
    ).toBe(realpathSync.native(join(p.root, "Moved")));
  });

  it("refuses a folder inside the workspace or inside the app data", () => {
    const p = places();
    const inWorkspace = join(p.moved, "backups");
    const inUserData = join(p.userData, "backups");
    mkdirSync(inWorkspace);
    mkdirSync(inUserData);
    const options = { workspace: p.moved, userData: p.userData };
    for (const folder of [inWorkspace, p.moved, inUserData, p.userData])
      expect(() => checkBackupFolder(folder, options)).toThrow(
        "backup-folder-inside-data",
      );
    // A link that leads into the data is judged by where it leads.
    const link = join(p.root, "link");
    symlinkSync(inWorkspace, link);
    expect(() => checkBackupFolder(link, options)).toThrow(
      "backup-folder-inside-data",
    );
  });

  it("names a missing folder and one that cannot be written", () => {
    const p = places();
    const options = { workspace: p.workspace, userData: p.userData };
    expect(() =>
      checkBackupFolder(join(p.root, "unplugged", "USB"), options),
    ).toThrow("backup-folder-missing");
    writeFileSync(join(p.root, "file"), "");
    expect(() => checkBackupFolder(join(p.root, "file"), options)).toThrow(
      "backup-folder-missing",
    );
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = join(p.root, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      expect(() => checkBackupFolder(locked, options)).toThrow(
        "backup-folder-permission",
      );
      chmodSync(locked, 0o700);
    }
  });
});

describe("failureReason", () => {
  it("maps worker and file-system errors to what the student is told", () => {
    expect(failureReason("backup-too-large:3000000000")).toBe("too-large");
    expect(failureReason("backup-too-many-files")).toBe("too-many-files");
    expect(failureReason("backup-folder-missing")).toBe("folder-missing");
    expect(failureReason("backup-folder-inside-data")).toBe(
      "folder-inside-data",
    );
    expect(failureReason("ENOSPC: no space left", "ENOSPC")).toBe("disk-full");
    expect(failureReason("EACCES: denied", "EACCES")).toBe("permission");
    expect(failureReason("EROFS: read-only", "EROFS")).toBe("permission");
    expect(failureReason("ENOENT: gone", "ENOENT")).toBe("folder-missing");
    expect(failureReason("backup-corrupt")).toBe("failed");
  });
});

describe("AutoBackups", () => {
  type Outcome = "ok" | Error;
  function setup(options: { outcomes?: Outcome[]; folder?: string } = {}) {
    const root = tempRoot();
    const userData = join(root, "userData");
    const workspace = join(userData, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "pyxis.db"), "");
    const documents = join(root, "Documents");
    mkdirSync(documents);
    const stateFile = join(userData, "backups.json");
    if (options.folder)
      writeAutoBackupState(stateFile, {
        ...initialState,
        folder: options.folder,
      });
    let now = NOON;
    let busy = false;
    const outcomes = [...(options.outcomes ?? [])];
    const runs: Array<{ zip: string; waitForJobs: boolean }> = [];
    const statuses: unknown[] = [];
    const deps: AutoBackupDeps = {
      stateFile,
      defaultFolder: () => join(documents, "Pyxis backups"),
      workspace: () => workspace,
      userData,
      busy: () => busy,
      now: () => now,
      changed: (status) => statuses.push(status),
      start: (zip, waitForJobs): LiveBackupRun => {
        runs.push({ zip, waitForJobs });
        const outcome = outcomes.shift() ?? "ok";
        if (outcome === "ok") writeFileSync(zip, "backup bytes");
        return {
          done: outcome === "ok" ? Promise.resolve() : Promise.reject(outcome),
          stop: async () => undefined,
        };
      },
    };
    const make = () => new AutoBackups(deps);
    return {
      root,
      documents,
      stateFile,
      runs,
      statuses,
      make,
      backups: make(),
      setNow: (value: number) => {
        now = value;
      },
      setBusy: (value: boolean) => {
        busy = value;
      },
    };
  }

  it("backs up into Pyxis backups in Documents on the first check, and not again the same day", async () => {
    const t = setup();
    expect(await t.backups.check()).toBe("saved");
    const folder = join(t.documents, "Pyxis backups");
    expect(readdirSync(folder)).toEqual([autoBackupName(new Date(NOON))]);
    expect(t.runs[0]!.waitForJobs).toBe(true);
    const status = t.backups.status();
    expect(status).toMatchObject({
      enabled: true,
      folder,
      isDefaultFolder: true,
      running: false,
      lastSuccessAt: NOON,
      last: { at: NOON, ok: true, size: 12 },
      notice: null,
    });
    // A relaunch later the same day.
    t.setNow(NOON + 6 * HOUR);
    expect(await t.make().check()).toBe("not-due");
    t.setNow(NOON + DAY);
    expect(await t.make().check()).toBe("saved");
    expect(t.runs).toHaveLength(2);
  });

  it("keeps three automatic backups in its folder after each success", async () => {
    const t = setup();
    for (let day = 0; day < 5; day += 1) {
      t.setNow(NOON + day * DAY);
      expect(await t.backups.check()).toBe("saved");
    }
    const folder = join(t.documents, "Pyxis backups");
    expect(readdirSync(folder).sort()).toEqual(
      [2, 3, 4].map((day) => autoBackupName(new Date(NOON + day * DAY))),
    );
  });

  it("does nothing while off", async () => {
    const t = setup();
    t.backups.setEnabled(false);
    expect(await t.backups.check()).toBe("off");
    expect(t.runs).toHaveLength(0);
    expect(t.backups.status().enabled).toBe(false);
  });

  it("skips while a manual backup, restore or move holds the workspace", async () => {
    const t = setup();
    t.setBusy(true);
    expect(await t.backups.check()).toBe("busy");
    expect(t.runs).toHaveLength(0);
    t.setBusy(false);
    expect(await t.backups.check()).toBe("saved");
  });

  it("waits for jobs without recording a failure, then stops waiting after the limit", async () => {
    const jobs = () => new BackupError("backup-jobs-active");
    const t = setup({ outcomes: [jobs(), jobs(), jobs()] });
    expect(await t.backups.check()).toBe("postponed");
    t.setNow(NOON + HOUR);
    expect(await t.backups.check()).toBe("postponed");
    expect(t.backups.status()).toMatchObject({ last: null, notice: null });
    expect(t.runs.map((run) => run.waitForJobs)).toEqual([true, true]);
    t.setNow(NOON + JOB_WAIT_LIMIT + 1);
    // The third outcome is used up by a run that no longer waits; the worker would not check jobs at all.
    await t.backups.check();
    expect(t.runs.at(-1)!.waitForJobs).toBe(false);
  });

  it("tries again later when core changed the workspace during the copy, without a notice", async () => {
    const t = setup({ outcomes: [new BackupError("backup-changed")] });
    expect(await t.backups.check()).toBe("postponed");
    expect(t.backups.status()).toMatchObject({ last: null, notice: null });
    expect(await t.backups.check()).toBe("saved");
  });

  it("reports a failure with its reason, keeps a dismissal for the session and says it again next launch", async () => {
    const full = () => new BackupError("ENOSPC: no space left", "ENOSPC");
    const t = setup({ outcomes: [full(), full(), full()] });
    expect(await t.backups.check()).toBe("failed");
    expect(t.backups.status()).toMatchObject({
      last: { at: NOON, ok: false, reason: "disk-full" },
      notice: "disk-full",
    });
    t.backups.dismissNotice();
    expect(t.backups.status().notice).toBeNull();
    // Not retried within the hour; after it, the same failure stays dismissed in this session.
    t.setNow(NOON + 30 * 60 * 1000);
    expect(await t.backups.check()).toBe("not-due");
    t.setNow(NOON + HOUR);
    expect(await t.backups.check()).toBe("failed");
    expect(t.backups.status().notice).toBeNull();
    // A relaunch says it again.
    expect(t.make().status().notice).toBe("disk-full");
  });

  it("says a missing folder without starting a copy, and a success clears the notice", async () => {
    const t = setup({ folder: "/no/such/drive/Backups" });
    expect(await t.backups.check()).toBe("failed");
    expect(t.runs).toHaveLength(0);
    expect(t.backups.status()).toMatchObject({
      folder: "/no/such/drive/Backups",
      isDefaultFolder: false,
      notice: "folder-missing",
      last: { ok: false, reason: "folder-missing" },
    });
    const folder = join(t.root, "USB");
    mkdirSync(folder);
    t.backups.setFolder(folder);
    expect(t.backups.status().notice).toBeNull();
    expect(await t.backups.check()).toBe("saved");
    expect(t.backups.status()).toMatchObject({
      folder,
      notice: null,
      last: { ok: true },
    });
  });

  it("refuses to write into the workspace even if the saved folder points there", async () => {
    const t = setup();
    const inside = join(t.root, "userData", "workspace", "backups");
    mkdirSync(inside);
    writeAutoBackupState(t.stateFile, { ...initialState, folder: inside });
    expect(await t.make().check()).toBe("failed");
    expect(t.runs).toHaveLength(0);
    expect(readAutoBackupState(t.stateFile).last).toMatchObject({
      reason: "folder-inside-data",
    });
  });

  it("says a workspace over the size limit once, not on every launch", async () => {
    const big = () => new BackupError("backup-too-large:3221225472");
    const t = setup({ outcomes: [big(), big(), "ok", big()] });
    expect(await t.backups.check()).toBe("failed");
    expect(t.backups.status()).toMatchObject({
      notice: "too-large",
      last: { ok: false, reason: "too-large", size: 3221225472 },
    });
    // The next launch, and the next daily attempt, stay quiet.
    const relaunched = t.make();
    expect(relaunched.status().notice).toBeNull();
    t.setNow(NOON + DAY);
    expect(await relaunched.check()).toBe("failed");
    expect(relaunched.status().notice).toBeNull();
    expect(relaunched.status().last).toMatchObject({ reason: "too-large" });
    // After the student frees space a backup succeeds; a later overflow is said again.
    t.setNow(NOON + 2 * DAY);
    expect(await relaunched.check()).toBe("saved");
    t.setNow(NOON + 3 * DAY);
    expect(await relaunched.check()).toBe("failed");
    expect(relaunched.status().notice).toBe("too-large");
  });

  it("backs up now on request, without waiting for jobs, and shows no notice for its failure", async () => {
    const t = setup({
      outcomes: ["ok", new BackupError("EACCES: denied", "EACCES")],
    });
    const status = await t.backups.runNow();
    expect(t.runs[0]!.waitForJobs).toBe(false);
    expect(status.last).toMatchObject({ ok: true });
    // The automatic check then counts it as today's backup.
    expect(await t.backups.check()).toBe("not-due");
    const failed = await t.backups.runNow();
    expect(failed).toMatchObject({
      last: { ok: false, reason: "permission" },
      notice: null,
    });
    t.setBusy(true);
    await expect(t.backups.runNow()).rejects.toThrow("workspace-busy");
  });

  it("gives two backups in the same second different names", async () => {
    const t = setup();
    await t.backups.runNow();
    await t.backups.runNow();
    expect(t.runs.map((run) => run.zip.slice(-10))).toEqual([
      "120000.zip",
      "120001.zip",
    ]);
  });

  it("keeps the backup it just wrote when the clock went back", async () => {
    const t = setup();
    const folder = join(t.documents, "Pyxis backups");
    mkdirSync(folder);
    const older = [1, 2, 3].map((day) =>
      autoBackupName(new Date(2026, 9, day, 9, 0, 0)),
    );
    for (const name of older) writeFileSync(join(folder, name), "zip");
    t.setNow(new Date(2025, 9, 1, 9, 0, 0).getTime());
    expect(await t.backups.check()).toBe("saved");
    const written = autoBackupName(new Date(2025, 9, 1, 9, 0, 0));
    expect(readdirSync(folder).sort()).toEqual([written, older[1], older[2]]);
  });

  it("stops its timers on dispose and no longer checks", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.backups.start(1000, 2000);
      t.backups.dispose();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.runs).toHaveLength(0);
      expect(await t.backups.check()).toBe("off");
      expect(t.runs).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not record a finished backup in the state of a folder chosen while it ran", async () => {
    const t = setup();
    const chosen = join(t.root, "Other drive");
    mkdirSync(chosen);
    let finish!: () => void;
    const backups = new AutoBackups({
      stateFile: t.stateFile,
      defaultFolder: () => join(t.documents, "Pyxis backups"),
      workspace: () => join(t.root, "userData", "workspace"),
      userData: join(t.root, "userData"),
      busy: () => false,
      now: () => NOON,
      changed: () => undefined,
      start: (zip) => ({
        done: new Promise<void>((resolve) => {
          finish = () => {
            writeFileSync(zip, "backup bytes");
            resolve();
          };
        }),
        stop: async () => undefined,
      }),
    });
    const check = backups.check();
    await vi.waitFor(() => expect(backups.running).toBe(true));
    backups.setFolder(chosen);
    finish();
    await check;
    // The new folder has not been backed up yet, so its first check must still run.
    expect(readAutoBackupState(t.stateFile)).toMatchObject({
      folder: chosen,
      lastSuccessAt: null,
      lastAttemptAt: null,
      last: null,
    });
    expect(backups.status()).toMatchObject({ folder: chosen, notice: null });
  });

  it("does not record a failure in the state of a folder chosen while it ran", async () => {
    const t = setup();
    const chosen = join(t.root, "Other drive");
    mkdirSync(chosen);
    let fail!: () => void;
    const backups = new AutoBackups({
      stateFile: t.stateFile,
      defaultFolder: () => join(t.documents, "Pyxis backups"),
      workspace: () => join(t.root, "userData", "workspace"),
      userData: join(t.root, "userData"),
      busy: () => false,
      now: () => NOON,
      changed: () => undefined,
      start: () => ({
        done: new Promise<void>((_, reject) => {
          fail = () => reject(new BackupError("backup-failed", "ENOSPC"));
        }),
        stop: async () => undefined,
      }),
    });
    const check = backups.check();
    await vi.waitFor(() => expect(backups.running).toBe(true));
    backups.setFolder(chosen);
    fail();
    await check;
    expect(readAutoBackupState(t.stateFile)).toMatchObject({
      folder: chosen,
      last: null,
      lastAttemptAt: null,
    });
    expect(backups.status().notice).toBeNull();
  });

  it("stops a running backup when the workspace is needed", async () => {
    const t = setup();
    let release!: () => void;
    const stop = vi.fn(async () => release());
    const backups = new AutoBackups({
      stateFile: t.stateFile,
      defaultFolder: () => join(t.documents, "Pyxis backups"),
      workspace: () => join(t.root, "userData", "workspace"),
      userData: join(t.root, "userData"),
      busy: () => false,
      now: () => NOON,
      changed: () => undefined,
      start: () => ({
        done: new Promise<void>((_, reject) => {
          release = () => reject(new BackupError("backup-cancelled"));
        }),
        stop,
      }),
    });
    const check = backups.check();
    await vi.waitFor(() => expect(backups.running).toBe(true));
    await backups.stop();
    expect(await check).toBe("postponed");
    expect(stop).toHaveBeenCalledOnce();
    expect(backups.running).toBe(false);
    expect(backups.status()).toMatchObject({ last: null, notice: null });
    expect(existsSync(join(t.documents, "Pyxis backups"))).toBe(true);
  });
  it("deletes its own backups and leftovers on request, and nothing else in the folder", async () => {
    const t = setup();
    expect(await t.backups.check()).toBe("saved");
    const folder = join(t.documents, "Pyxis backups");
    const leftover = join(folder, ".pyxis-backup-abc123");
    mkdirSync(leftover);
    writeFileSync(join(leftover, "pyxis.db"), "copy");
    writeFileSync(join(folder, "notes.txt"), "mine");
    writeFileSync(join(folder, "pyxis-auto-backup-old.zip"), "not ours");
    mkdirSync(join(folder, autoBackupName(new Date(NOON - DAY))));
    t.statuses.length = 0;
    t.backups.deleteBackups();
    expect(readdirSync(folder).sort()).toEqual([
      "notes.txt",
      autoBackupName(new Date(NOON - DAY)),
      "pyxis-auto-backup-old.zip",
    ]);
    // The last result named a file that is gone. The day still counts, so no new backup starts right away.
    expect(t.backups.status()).toMatchObject({
      last: null,
      notice: null,
      lastSuccessAt: NOON,
    });
    expect(t.statuses).toHaveLength(1);
    t.setNow(NOON + HOUR);
    expect(await t.backups.check()).toBe("not-due");
  });

  it("has nothing to delete when the default folder was never made", () => {
    const t = setup();
    expect(() => t.backups.deleteBackups()).not.toThrow();
    expect(existsSync(join(t.documents, "Pyxis backups"))).toBe(false);
  });

  it("says a chosen folder it cannot reach still holds backups", () => {
    const t = setup({ folder: "/no/such/drive/Backups" });
    expect(() => t.backups.deleteBackups()).toThrow("backup-folder-missing");
  });
});
