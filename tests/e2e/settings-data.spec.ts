import { importPickedSource } from "./picked-source";
import { expect, test } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan } from "./seed";
import { expectNoAxeViolations } from "./axe";

const packageVersion = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
).version as string;
// The fake release is always one minor version ahead, so a version bump never hides the notice.
const [major = 0, minor = 0] = packageVersion.split(".").map(Number);
const newerTag = `v${major}.${minor + 1}.0`;

test("SET-05/06 verified workspace move, failed move recovery and daily release notice", async () => {
  test.setTimeout(90000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-settings-data-"));
  const parent = join(userData, "destination");
  mkdirSync(parent);
  const text =
    "The work done by a constant force is the scalar product of force and displacement.";
  const sourcePath = join(userData, "energy.txt");
  writeFileSync(sourcePath, text);
  const env = {
    PYXIS_E2E_MOVE: parent,
    PYXIS_E2E_RELEASE: JSON.stringify({
      tag_name: newerTag,
      body: "New study tools.\n".repeat(1200),
      draft: false,
      prerelease: false,
    }),
  };
  let app = await launchPyxis({ userData, env });
  try {
    let page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Exams; wait so a reload or route change cannot land on setup.
    await expect(page).toHaveURL(/#\/exams$/);
    const imported = (await importPickedSource(page, app, sourcePath)) as {
      sourceId: string;
    };
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(() =>
              window.pyxis.invoke("sources.list", {}),
            )) as Array<{ id: string; status: string }>
          ).find((s) => s.id === imported.sourceId)?.status,
      )
      .toBe("ready");
    const original = await page.evaluate(() => window.pyxis.workspacePath());
    const db = new DatabaseSync(join(original, "pyxis.db"), { timeout: 10000 });
    seedPlan(db, { id: "move-plan", title: "Energy" });
    const blob = db
      .prepare("SELECT blob_sha FROM sources WHERE id=?")
      .get(imported.sourceId) as { blob_sha: string };
    db.close();
    const expected = await page.evaluate(() =>
      window.pyxis.invoke("plans.list", {}),
    );
    await page.evaluate(() => {
      location.hash = "/settings/data";
    });
    await page
      .getByRole("button", { name: "Sposta lo spazio di lavoro", exact: true })
      .click();
    await expect(
      page.getByText("Spazio di lavoro spostato.", { exact: true }),
    ).toBeVisible();
    const moved = realpathSync.native(join(parent, "Pyxis workspace"));
    expect(await page.evaluate(() => window.pyxis.workspacePath())).toBe(moved);
    expect(existsSync(original)).toBe(false);
    expect(
      readFileSync(
        join(moved, "blobs", blob.blob_sha.slice(0, 2), blob.blob_sha),
        "utf8",
      ),
    ).toBe(text);
    expect(
      await page.evaluate(() => window.pyxis.invoke("plans.list", {})),
    ).toEqual(expected);
    expect(
      await page.evaluate(
        async (sha) => (await fetch(`pyxis-blob://${sha}`)).text(),
        blob.blob_sha,
      ),
    ).toBe(text);
    await expect(
      page.evaluate(() => window.pyxis.moveWorkspace()),
    ).rejects.toThrow();
    expect(
      await page.evaluate(() => window.pyxis.invoke("plans.list", {})),
    ).toEqual(expected);
    expect(await page.evaluate(() => window.pyxis.workspacePath())).toBe(moved);
    for (const [language, theme, width] of [
      ["it", "dark", 1280],
      ["it", "light", 960],
      ["en", "dark", 1280],
      ["en", "light", 960],
    ] as const) {
      await page.evaluate(
        async ({ language, theme }) => {
          localStorage.setItem("pyxis.lang", language);
          localStorage.removeItem("pyxis-dismissed-release");
          await window.pyxis.setAppearance(theme);
          location.hash = "/settings/updates";
        },
        { language, theme },
      );
      await page.reload();
      await page.setViewportSize({ width, height: 800 });
      const notice = page.locator(".px-update-notice");
      await expect(notice).toBeVisible();
      await notice
        .getByRole("button", { name: /^(Dettagli|Details)$/ })
        .click();
      await expect(notice.locator("pre")).toBeVisible();
      const box = await notice.boundingBox();
      expect(box!.height).toBeLessThanOrEqual(680);
      await expectNoAxeViolations(page, { include: [".px-update-notice"] });
      mkdirSync(".shots", { recursive: true });
      await page.screenshot({
        path: `.shots/m14-update-${language}-${theme}-${width}.png`,
      });
      await notice
        .getByRole("button", { name: /^(Chiudi avviso|Dismiss notice)$/ })
        .click();
      await expect(notice).not.toBeVisible();
      await page.evaluate(() => {
        location.hash = "/settings/about";
      });
      await page.locator(".px-about-notices > summary").click();
      await page
        .locator(".px-about-search input")
        .fill("@politost/content-core");
      await expect(page.locator(".px-about-packages > li")).toHaveCount(1);
      await expect(page.locator(".px-about-packages")).toContainText("MIT");
      await page.locator(".px-about-packages > li summary").click();
      await page.locator(".px-about-license > summary").click();
      const license = page.locator(".px-about-license pre");
      await license.focus();
      await expect(license).toBeFocused();
      await expectNoAxeViolations(page, { include: [".px-about"] });
      await page.locator(".px-about").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `.shots/m14-about-${language}-${theme}-${width}.png`,
      });
      const update = await page.evaluate(() => window.pyxis.checkUpdates());
      expect(update.state).toBe("available");
      expect(update.current).toBe(packageVersion);
    }
    await app.close();
    app = await launchPyxis({ userData, env });
    page = await app.firstWindow();
    await expect
      .poll(() => page.evaluate(() => window.pyxis.workspacePath()))
      .toBe(moved);
    expect(
      await page.evaluate(() => window.pyxis.invoke("plans.list", {})),
    ).toEqual(expected);
    expect(
      await page.evaluate(
        async (sha) => (await fetch(`pyxis-blob://${sha}`)).text(),
        blob.blob_sha,
      ),
    ).toBe(text);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a manual backup saved over the live database is refused and the data stays", async () => {
  test.setTimeout(60000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-backup-inside-"));
  const database = join(userData, "workspace", "pyxis.db");
  const env = {
    // A Linux save dialog keeps the name as typed, so "pyxis.db" in the workspace reaches main unchanged.
    PYXIS_E2E_SAVE: database,
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => {
      location.hash = "/settings/data";
    });
    await page
      .getByRole("button", { name: "Copia di sicurezza", exact: true })
      .click();
    await expect(
      page.getByText(
        "Salva la copia fuori dai dati di Pyxis. Lì andrebbe persa insieme a loro, o potrebbe sostituire i tuoi dati.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(readFileSync(database).subarray(0, 15).toString()).toBe(
      "SQLite format 3",
    );
    expect(
      await page.evaluate(() => window.pyxis.invoke("profile.get", {})),
    ).not.toBeNull();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("Free up space removes a file nothing uses, keeps a source's file and says how much it freed (#111)", async () => {
  test.setTimeout(90000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-free-space-"));
  const sourcePath = join(userData, "lavoro.txt");
  writeFileSync(sourcePath, "Il lavoro di una forza costante è il prodotto scalare di forza e spostamento.");
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    const imported = (await importPickedSource(page, app, sourcePath)) as { sourceId: string };
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(() => window.pyxis.invoke("sources.list", {}))) as Array<{
              id: string;
              status: string;
            }>
          ).find((s) => s.id === imported.sourceId)?.status,
      )
      .toBe("ready");
    const workspace = await page.evaluate(() => window.pyxis.workspacePath());
    const db = new DatabaseSync(join(workspace, "pyxis.db"), { timeout: 10000 });
    const kept = (db.prepare("SELECT blob_sha FROM sources WHERE id=?").get(imported.sourceId) as { blob_sha: string })
      .blob_sha;
    db.close();
    // A file a deleted plan left behind: a blob name that no row names.
    const orphan = "ab".padEnd(64, "0");
    mkdirSync(join(workspace, "blobs", "ab"), { recursive: true });
    const orphanFile = join(workspace, "blobs", "ab", orphan);
    writeFileSync(orphanFile, Buffer.alloc(2048, 1));
    writeFileSync(`${orphanFile}.json`, JSON.stringify({ mime: "application/pdf", ext: "pdf" }));

    await page.evaluate(() => {
      location.hash = "/settings/data";
    });
    await expect(page.getByText(/^Elimina i file salvati che nessun piano/)).toBeVisible();
    const button = page.getByRole("button", { name: "Libera spazio", exact: true });
    await button.click();
    await expect(page.getByText(/^Liberati \d/)).toBeVisible();
    expect(existsSync(orphanFile)).toBe(false);
    expect(existsSync(`${orphanFile}.json`)).toBe(false);
    expect(existsSync(join(workspace, "blobs", kept.slice(0, 2), kept))).toBe(true);
    await button.click();
    await expect(
      page.getByText("Niente da liberare. Tutti i file salvati sono ancora in uso.", { exact: true }),
    ).toBeVisible();
    mkdirSync(".shots", { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((theme) => window.pyxis.setAppearance(theme), theme);
      await button.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `.shots/free-space-${theme}.png` });
      await expectNoAxeViolations(page, { include: [".px-settings-subpage"] });
    }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
