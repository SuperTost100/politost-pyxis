import AxeBuilder from "@axe-core/playwright";
import {
  _electron as electron,
  type ElectronApplication,
  expect,
  test,
} from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { quitPyxis } from "./app-exit";
import { animationsSettled } from "./settled";

const automatic = /^pyxis-auto-backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/;
const HOUR = 60 * 60 * 1000;

/** Main's own log lines, such as "pyxis: automatic backup failed (permission)". */
const mainLog: string[] = [];
test.beforeEach(() => {
  mainLog.length = 0;
});

async function launch(env: Record<string, string | undefined>) {
  const full = { ...process.env, PYXIS_E2E: "1", ...env };
  delete full.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env: full as Record<string, string>,
  });
  for (const stream of [app.process().stdout, app.process().stderr])
    stream?.on("data", (chunk) =>
      mainLog.push(
        ...String(chunk)
          .split(/\r?\n/)
          .filter((line) => line.startsWith("pyxis:")),
      ),
    );
  return app;
}

/**
 * After a failed step Pyxis is still open. Prints what the automatic backups were doing, then closes it so the test
 * folder can be removed and the step's own error is the one reported.
 */
async function closeAfterFailure(app: ElectronApplication | undefined) {
  if (!app) return;
  const status = await app
    .windows()[0]
    ?.evaluate(() => window.pyxis.autoBackups.status())
    .catch((error: Error) => error.message);
  console.log(
    `Automatic backups when the step failed: ${JSON.stringify(status)}\nMain log:\n${mainLog.join("\n") || "(empty)"}`,
  );
  await app.close().catch(() => undefined);
}

function backupsIn(folder: string): string[] {
  return existsSync(folder)
    ? readdirSync(folder)
        .filter((name) => automatic.test(name))
        .sort()
    : [];
}

/**
 * Removes a test folder once Pyxis has quit. Retries for a few seconds, since a virus scanner can still have a new file
 * open, then fails naming every file still held.
 */
function removeTestFolder(root: string) {
  try {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  } catch (error) {
    const held: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else
          try {
            rmSync(path, { force: true });
          } catch {
            held.push(path);
          }
      }
    };
    walk(root);
    throw new Error(
      `${(error as Error).message}; still held: ${held.join(", ") || "only folders"}`,
    );
  }
}

test("automatic backups: first launch, not twice a day, a day later with retention, and restore", async () => {
  test.setTimeout(180_000);
  const root = mkdtempSync(join(tmpdir(), "pyxis-auto-backup-"));
  const userData = join(root, "userData");
  const documents = join(root, "Documents");
  mkdirSync(documents);
  const folder = join(documents, "Pyxis backups");
  const env = { PYXIS_USER_DATA: userData, PYXIS_E2E_DOCUMENTS: documents };
  let app: ElectronApplication | undefined;
  try {
    // First launch: the folder does not exist yet; Pyxis creates it and backs up shortly after starting.
    app = await launch(env);
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Exams; wait so that move cannot override the next page.
    await expect(page).toHaveURL(/#\/exams$/);
    await expect
      .poll(() => backupsIn(folder), { timeout: 30_000 })
      .toHaveLength(1);
    const first = backupsIn(folder)[0]!;
    await page.evaluate(() => {
      location.hash = "/settings/data";
    });
    await expect(page.getByText(/^Ultima copia: .+\.$/)).toBeVisible();
    await expect(
      page.getByText(`Cartella: ${folder}`, { exact: true }),
    ).toBeVisible();
    const workspace = await page.evaluate(() => window.pyxis.workspacePath());
    const db = new DatabaseSync(join(workspace, "pyxis.db"), {
      timeout: 10000,
    });
    db.exec(
      "INSERT INTO plans (id,title,status,created_at,updated_at) VALUES ('auto-plan','Motion','ready',1,1)",
    );
    db.close();
    await quitPyxis(app);

    // Second launch the same day: no new backup.
    app = await launch(env);
    page = await app.firstWindow();
    await page.evaluate(() => {
      location.hash = "/settings/data";
    });
    await expect(page.getByText(/^Ultima copia: .+\.$/)).toBeVisible();
    // The first check runs a second after core starts; give it time to do nothing.
    await page.waitForTimeout(4000);
    expect(backupsIn(folder)).toEqual([first]);
    await quitPyxis(app);

    // A day later, with three older automatic backups and two other files in the folder.
    const stateFile = join(userData, "backups.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.lastSuccessAt -= 25 * HOUR;
    state.lastAttemptAt -= 25 * HOUR;
    state.last.at -= 25 * HOUR;
    writeFileSync(stateFile, JSON.stringify(state));
    const older = [1, 2, 3].map(
      (day) => `pyxis-auto-backup-2020-01-0${day}-090000.zip`,
    );
    for (const name of older) writeFileSync(join(folder, name), "old");
    writeFileSync(join(folder, "notes.txt"), "mine");
    writeFileSync(join(folder, "pyxis-backup.zip"), "a manual backup");
    app = await launch(env);
    page = await app.firstWindow();
    await expect
      .poll(() => backupsIn(folder).filter((name) => !older.includes(name)), {
        timeout: 30_000,
      })
      .toHaveLength(2);
    // Old backups are pruned just after the new one is saved; wait for that before reading the list.
    await expect.poll(() => backupsIn(folder).length).toBe(3);
    const newest = backupsIn(folder).at(-1)!;
    expect(newest > first).toBe(true);
    // Three kept: today's two and the newest of the old ones. The student's own files stay.
    expect(backupsIn(folder)).toEqual([older[2], first, newest]);
    expect(readFileSync(join(folder, "notes.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(folder, "pyxis-backup.zip"), "utf8")).toBe(
      "a manual backup",
    );
    expect(readdirSync(folder).filter((name) => name.startsWith("."))).toEqual(
      [],
    );

    // The scheduled backup restores through the ordinary restore flow.
    await page.evaluate(() =>
      window.pyxis.invoke("plans.delete", { planId: "auto-plan" }),
    );
    expect(
      await page.evaluate(() => window.pyxis.invoke("plans.list", {})),
    ).toHaveLength(0);
    await app.evaluate(
      (_electron, path) => {
        process.env.PYXIS_E2E_ZIP = path;
      },
      join(folder, newest),
    );
    await page.evaluate(() => {
      location.hash = "/settings/data";
    });
    await page.getByRole("button", { name: "Ripristina", exact: true }).click();
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: /^Sostituisci / }).click(),
    ]);
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.pyxis.invoke("plans.list", {}))).map(
          (plan) => plan.title,
        ),
      )
      .toEqual(["Motion"]);
    // Close only once no backup is writing, so no file in the test folder is still open when it is removed.
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.pyxis.autoBackups.status()).running,
        ),
      )
      .toBe(false);
    // Quitting right after a restore leaves nothing running: not the core started for the restored workspace, not
    // the one it replaced.
    await quitPyxis(app);
    app = undefined;
  } finally {
    await closeAfterFailure(app);
    removeTestFolder(root);
  }
});

test("a missing backup folder shows a notice with the fix, and choosing another folder backs up", async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(join(tmpdir(), "pyxis-auto-backup-missing-"));
  const userData = join(root, "userData");
  const documents = join(root, "Documents");
  const usb = join(root, "USB", "Backups");
  mkdirSync(userData, { recursive: true });
  mkdirSync(documents);
  writeFileSync(
    join(userData, "backups.json"),
    JSON.stringify({ enabled: true, folder: usb }),
  );
  const inside = join(userData, "Backups");
  mkdirSync(inside);
  let app: ElectronApplication | undefined;
  try {
    app = await launch({
      PYXIS_USER_DATA: userData,
      PYXIS_E2E_DOCUMENTS: documents,
      PYXIS_E2E_BACKUP_FOLDER: inside,
    });
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const notice = page.locator(".px-backup-notice");
    await expect(notice).toContainText(
      "La copia automatica non è riuscita. La cartella delle copie non è disponibile.",
      // The first check waits for core to start and its queue to empty, which can take a while on a slow runner.
      { timeout: 60_000 },
    );
    expect(
      (
        await new AxeBuilder({ page })
          .setLegacyMode()
          .include(".px-backup-notice")
          .analyze()
      ).violations,
    ).toEqual([]);
    mkdirSync(".shots", { recursive: true });
    await page.screenshot({ path: ".shots/auto-backup-notice.png" });
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Exams; wait so that move cannot override the next page.
    await expect(page).toHaveURL(/#\/exams$/);
    await notice
      .getByRole("button", { name: "Impostazioni copie", exact: true })
      .click();
    await expect(page).toHaveURL(/#\/settings\/data$/);
    await expect(
      page.getByText(
        "La cartella delle copie non è disponibile. Collega il disco su cui si trova, oppure scegli un'altra cartella.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(`Cartella: ${usb}`, { exact: true }),
    ).toBeVisible();

    // A folder inside Pyxis's own data is refused and the saved folder stays.
    await page
      .getByRole("button", { name: "Cambia cartella", exact: true })
      .click();
    await expect(
      page.getByText(/^Quella cartella è dentro i dati di Pyxis/),
    ).toBeVisible();
    await expect(
      page.getByText(`Cartella: ${usb}`, { exact: true }),
    ).toBeVisible();

    // Plugging the drive back in is enough: Back up now writes there and the notice goes.
    mkdirSync(usb, { recursive: true });
    await page.getByRole("button", { name: "Copia ora", exact: true }).click();
    await expect.poll(() => backupsIn(usb)).toHaveLength(1);
    await expect(page.getByText(/^Ultima copia: .+\.$/)).toBeVisible();
    await expect(notice).toHaveCount(0);

    // Turned off, the switch says so and the setting is saved.
    await page
      .getByRole("switch", { name: "Copia di sicurezza automatica" })
      .click();
    await expect(page.getByText(/^Spenta\./)).toBeVisible();
    expect(
      JSON.parse(readFileSync(join(userData, "backups.json"), "utf8")).enabled,
    ).toBe(false);
    await quitPyxis(app);
    app = undefined;
  } finally {
    await closeAfterFailure(app);
    removeTestFolder(root);
  }
});

test("quitting during an automatic backup stops it and leaves no Pyxis process behind", async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(join(tmpdir(), "pyxis-auto-backup-quit-"));
  const userData = join(root, "userData");
  const documents = join(root, "Documents");
  const stateFile = join(userData, "backups.json");
  mkdirSync(userData);
  mkdirSync(documents);
  const env = { PYXIS_USER_DATA: userData, PYXIS_E2E_DOCUMENTS: documents };
  let app: ElectronApplication | undefined;
  try {
    // The first launch only creates the workspace.
    writeFileSync(stateFile, JSON.stringify({ enabled: false }));
    app = await launch(env);
    let page = await app.firstWindow();
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const workspace = await page.evaluate(() => window.pyxis.workspacePath());
    await quitPyxis(app);

    // 128 MB of random bytes take a few seconds to compress, long enough to quit in the middle of the copy.
    const db = new DatabaseSync(join(workspace, "pyxis.db"));
    db.exec(
      "CREATE TABLE ballast (data BLOB); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 128) INSERT INTO ballast SELECT randomblob(1048576) FROM n",
    );
    db.close();
    writeFileSync(stateFile, JSON.stringify({ enabled: true }));
    app = await launch(env);
    page = await app.firstWindow();
    await expect
      .poll(
        () =>
          page.evaluate(
            async () => (await window.pyxis.autoBackups.status()).running,
          ),
        { intervals: [100] },
      )
      .toBe(true);
    await quitPyxis(app);
    app = undefined;
    // The stopped copy leaves neither a backup nor its temporary folder.
    expect(readdirSync(join(documents, "Pyxis backups"))).toEqual([]);
  } finally {
    await closeAfterFailure(app);
    removeTestFolder(root);
  }
});

test("a check that finds core still starting waits for it instead of failing", async () => {
  test.setTimeout(60_000);
  const root = mkdtempSync(join(tmpdir(), "pyxis-auto-backup-start-"));
  const userData = join(root, "userData");
  const documents = join(root, "Documents");
  mkdirSync(join(userData, "workspace"), { recursive: true });
  mkdirSync(documents);
  // Core has created pyxis.db but not its tables yet, and stays there for 4 s, past the first check after 1 s.
  writeFileSync(join(userData, "workspace", "pyxis.db"), "");
  let app: ElectronApplication | undefined;
  try {
    app = await launch({
      PYXIS_USER_DATA: userData,
      PYXIS_E2E_DOCUMENTS: documents,
      PYXIS_E2E_CORE_DELAY: "4000",
    });
    const page = await app.firstWindow();
    await expect
      .poll(() => backupsIn(join(documents, "Pyxis backups")), {
        timeout: 30_000,
      })
      .toHaveLength(1);
    expect(
      (await page.evaluate(() => window.pyxis.autoBackups.status())).notice,
    ).toBeNull();
    await quitPyxis(app);
    app = undefined;
  } finally {
    await closeAfterFailure(app);
    removeTestFolder(root);
  }
});

test("Delete all data deletes the automatic backups when ticked, keeps them when not, and says when it can't", async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(join(tmpdir(), "pyxis-auto-backup-wipe-"));
  const userData = join(root, "userData");
  const documents = join(root, "Documents");
  mkdirSync(documents);
  const folder = join(documents, "Pyxis backups");
  let app: ElectronApplication | undefined;
  try {
    app = await launch({
      PYXIS_USER_DATA: userData,
      PYXIS_E2E_DOCUMENTS: documents,
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect
      .poll(() => backupsIn(folder), { timeout: 30_000 })
      .toHaveLength(1);
    writeFileSync(join(folder, "notes.txt"), "mine");
    writeFileSync(join(folder, "pyxis-backup.zip"), "a manual backup");

    // Ticked by default: only Pyxis's own backups go.
    await page.evaluate(() => {
      location.hash = "/settings/data";
    });
    await page
      .getByRole("button", { name: "Cancella tutti i dati", exact: true })
      .click();
    const tick = page.getByRole("checkbox", {
      name: "Cancella anche le copie automatiche",
    });
    await expect(tick).toBeChecked();
    await expect(
      page.getByText(`Pyxis cancella solo i suoi file di copia in ${folder}.`, {
        exact: true,
      }),
    ).toBeVisible();
    const axe = await new AxeBuilder({ page })
      .setLegacyMode()
      .include(".px-settings-danger")
      .analyze();
    expect(axe.violations).toEqual([]);
    mkdirSync(".shots", { recursive: true });
    await page
      .locator(".px-settings-danger")
      .screenshot({ path: ".shots/wipe-backups.png" });
    await tick.uncheck();
    await expect(
      page.getByText(/^Le copie automatiche restano nella tua cartella/),
    ).toBeVisible();
    await tick.check();
    await page
      .getByRole("button", { name: "Cancella per sempre", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Salta" })).toBeVisible();
    expect(backupsIn(folder)).toEqual([]);
    expect(readdirSync(folder).sort()).toEqual([
      "notes.txt",
      "pyxis-backup.zip",
    ]);

    // Not ticked: the backups stay.
    const kept = "pyxis-auto-backup-2020-01-01-090000.zip";
    writeFileSync(join(folder, kept), "old");
    expect(
      await page.evaluate(() => window.pyxis.wipeWorkspace({ backups: false })),
    ).toBe("wiped");
    expect(backupsIn(folder)).toEqual([kept]);

    // A chosen folder that isn't there: the data goes, and Pyxis says the backups may still be there.
    const unplugged = join(root, "USB", "Backups");
    const stateFile = join(userData, "backups.json");
    writeFileSync(
      stateFile,
      JSON.stringify({
        ...JSON.parse(readFileSync(stateFile, "utf8")),
        folder: unplugged,
      }),
    );
    await page.reload();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => {
      location.hash = "/settings/data";
    });
    await page
      .getByRole("button", { name: "Cancella tutti i dati", exact: true })
      .click();
    await expect(
      page.getByText(
        `Pyxis cancella solo i suoi file di copia in ${unplugged}.`,
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Cancella per sempre", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "I tuoi dati sono stati cancellati",
    });
    await expect(dialog).toContainText(
      `Pyxis non è riuscito a cancellare le copie automatiche in ${unplugged}.`,
    );
    await animationsSettled(page);
    await dialog.getByRole("button", { name: "OK" }).click();
    await expect(page.getByRole("button", { name: "Salta" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.pyxis.invoke("profile.get", {})))
      .toBeNull();
    await quitPyxis(app);
    app = undefined;
  } finally {
    await closeAfterFailure(app);
    removeTestFolder(root);
  }
});
