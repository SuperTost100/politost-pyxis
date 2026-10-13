import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
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

const automatic = /^pyxis-auto-backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/;
const HOUR = 60 * 60 * 1000;

function launch(env: Record<string, string | undefined>) {
  const full = { ...process.env, PYXIS_E2E: "1", ...env };
  delete full.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env: full as Record<string, string>,
  });
}

function backupsIn(folder: string): string[] {
  return existsSync(folder)
    ? readdirSync(folder)
        .filter((name) => automatic.test(name))
        .sort()
    : [];
}

test("automatic backups: first launch, not twice a day, a day later with retention, and restore", async () => {
  test.setTimeout(180_000);
  const root = mkdtempSync(join(tmpdir(), "pyxis-auto-backup-"));
  const userData = join(root, "userData");
  const documents = join(root, "Documents");
  mkdirSync(documents);
  const folder = join(documents, "Pyxis backups");
  const env = { PYXIS_USER_DATA: userData, PYXIS_E2E_DOCUMENTS: documents };
  try {
    // First launch: the folder does not exist yet; Pyxis creates it and backs up shortly after starting.
    let app = await launch(env);
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
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
    await app.close();

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
    await app.close();

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
    await app.close();
  } finally {
    // Windows can hold the folder for a moment after the app exits.
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
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
  try {
    const app = await launch({
      PYXIS_USER_DATA: userData,
      PYXIS_E2E_DOCUMENTS: documents,
      PYXIS_E2E_BACKUP_FOLDER: inside,
    });
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const notice = page.locator(".px-backup-notice");
    await expect(notice).toContainText(
      "La copia automatica non è riuscita. La cartella delle copie non è disponibile.",
      { timeout: 30_000 },
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
    await app.close();
  } finally {
    // Windows can hold the folder for a moment after the app exits.
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
});
