import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan } from "./seed";
import { animationsSettled } from "./settled";
import { saveShot } from "./shots";

const corner = (page: Page) => page.locator(".px-corner-tools").getByRole("button", { name: /^Attività/ });

/** The animation running on the hands of the Attività clock, or "none". */
const hands = (page: Page) =>
  page.locator(".px-corner-tools .px-jobs-hands").evaluate((element) => getComputedStyle(element).animationName);

/** Starts demo jobs: three short steps each, one at a time, so the later ones wait. */
const startDemos = (page: Page, count: number) =>
  page.evaluate(async (n) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) ids.push((await window.pyxis.invoke("jobs.startDemo", {})).jobId);
    return ids;
  }, count);

test("the Attività clock turns only while jobs run, and stands still with reduced motion", async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-jobs-clock-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // Nothing runs: a still clock.
    await expect(corner(page).locator(".px-jobs-clock")).toBeVisible();
    await expect(corner(page).locator(".px-jobs-clock.is-running")).toHaveCount(0);
    await expect.poll(() => hands(page)).toBe("none");

    await startDemos(page, 4);
    await expect(corner(page).locator(".px-jobs-clock.is-running")).toBeVisible();
    await expect(corner(page)).toHaveAccessibleName(/in corso/);
    await expect.poll(() => hands(page)).toBe("px-jobs-hands");
    // With reduced motion the hands stay where they are and the count says jobs run.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => hands(page)).toBe("none");
    await expect(corner(page).locator(".px-jobs-part .meta")).toHaveText(/^[1-4]$/);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // Once they finish, the clock stops.
    await expect(corner(page).locator(".px-jobs-clock.is-running")).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(() => hands(page)).toBe("none");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Ferma tutte stops every running job at once, and they wait under C'è bisogno di te with Riprendi", async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-jobs-stop-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const ids = await startDemos(page, 5);
    await corner(page).click();
    const list = page.locator(".px-jobs");
    const running = list.getByRole("region", { name: "In corso" });
    await expect(running).toBeVisible();
    // Each running row shows the Pyxis mark at work, never a bare spinner.
    await expect(running.locator(".px-logo-working").first()).toBeVisible();
    await expect(list.locator(".px-spin")).toHaveCount(0);

    // Stopping asks nothing: the stopped jobs move to C'è bisogno di te as one item.
    await running.getByRole("button", { name: "Ferma tutte" }).click();
    await expect(running).toHaveCount(0);
    const needs = list.getByRole("region", { name: "C'è bisogno di te" });
    await expect(needs.getByText(/^Hai fermato [2-5] attività$/)).toBeVisible();
    await expect(needs.getByText("Le hai fermate tu. Riprendile quando vuoi da dove erano arrivate.")).toBeVisible();
    await needs.getByRole("button", { name: /^Mostra le [2-5] attività$/ }).click();
    await expect(needs.getByRole("listitem").filter({ hasText: /^Preparo il (primo|secondo|terzo) passo$/ }).first()).toBeVisible();
    await expectNoAxeViolations(page);

    // Riprendi tutte puts them back to work, from where they stopped, and they finish.
    await needs.getByRole("button", { name: "Riprendi tutte" }).click();
    await expect(needs).toHaveCount(0);
    await expect(list.getByRole("region", { name: "In corso" })).toBeVisible();
    await expect(corner(page).locator(".px-jobs-clock.is-running")).toHaveCount(0, { timeout: 30_000 });
    // Every one of them finished.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    try {
      const state = db.prepare("SELECT state FROM jobs WHERE id = ?");
      for (const id of ids) expect(state.get(id)).toEqual({ state: "succeeded" });
    } finally {
      db.close();
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a linked folder's readings show as one row that opens in place on the files", async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-jobs-group-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    const now = Date.now();
    // A folder being read: three files running, two read already, five recorded and waiting for the queue. Seeded after
    // start-up, so the runner leaves the rows as they are.
    db.prepare("INSERT INTO linked_folders(id, path, mode, created_at) VALUES ('f', ?, 'root', ?)").run(
      join(userData, "Università"),
      now,
    );
    const job = db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,step_label,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    );
    const read = (title: string) => JSON.stringify({ sourceId: `s-${title}`, title, folderId: "f", linked: true });
    const names = ["Slide lezione 3, cinematica", "Temi d'esame 2024", "Chimica generale, capitolo 4"];
    names.forEach((name, index) =>
      job.run(`run-${index}`, "source-import", read(name), "running", 0.3, "sources.jobs.extract", now + index, now),
    );
    for (const index of [0, 1])
      job.run(`done-${index}`, "source-import", read(`Letto ${index}`), "succeeded", 1, null, now - 60_000, now - 1_000);
    const file = db.prepare(
      "INSERT INTO linked_files(folder_id, rel_path, subfolder, size, mtime_ms, pending) VALUES ('f', ?, 'Fisica 1', 10, 1, 1)",
    );
    for (let index = 0; index < 5; index += 1) file.run(`Fisica 1/nota ${index}.txt`);
    db.close();
    await page.reload();

    await corner(page).click();
    const list = page.locator(".px-jobs");
    const running = list.getByRole("region", { name: "In corso" });
    const row = running.getByRole("button", { name: /^Leggo le fonti · 2 di 10/ });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect(row).toContainText("Dalla cartella Università");
    await expect(row.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "29");
    // The files already read count on the row instead of being listed again under Finite oggi.
    await expect(list.getByRole("region", { name: "Finite oggi" })).toHaveCount(0);
    const files = running.locator(".px-jobs-more");
    await expect(files).toHaveAttribute("inert", "");

    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(files).not.toHaveAttribute("inert", "");
    for (const name of names) await expect(files.getByText(name)).toBeVisible();
    await expect(files.getByText("Sto leggendo")).toHaveCount(3);
    await expect(files.getByText("Altri 5 in attesa · 2 già letti")).toBeVisible();
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "working-states/jobs-group.png");

    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "false");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("the maps page shows the Pyxis mark at work while the maps are built", async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-maps-working-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seedPlan(db, { id: "p", title: "Fisica 1", language: "it", topics: [{ id: "t", title: "Cinematica" }] });
    // A build still writing, seeded after start-up, so the runner leaves it running.
    db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,created_at,updated_at) VALUES('map','map-build',?,'running',0,1,1)",
    ).run(JSON.stringify({ input: { planId: "p", topicId: "t" } }));
    db.close();
    await page.evaluate(() => {
      location.hash = "#/plans/p/map/t";
    });
    const working = page.locator(".px-map-working");
    await expect(working).toBeVisible();
    await expect(working.getByRole("status")).toHaveText(/^Creo la mappa «.+»…$/);
    await expect(working.locator(".px-logo-working")).toBeVisible();
    // The empty state and its button wait until the build is over.
    await expect(page.getByRole("button", { name: "Crea la mappa" })).toHaveCount(0);
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "working-states/maps-building.png");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("nothing inside the Attività button moves while the pointer is over it, pressed on it, focused on it or it is open", async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-jobs-hover-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    const now = Date.now();
    const job = db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,step_label,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    );
    // One job running and one stopped for a problem, so the button shows both counts and the divider.
    job.run("j-run", "source-import", JSON.stringify({ sourceId: "a" }), "running", 0.4, "sources.jobs.extract", null, now, now);
    job.run("j-failed", "ocr-data-download", "{}", "failed", 0.5, "sources.jobs.ocrData", "ocr-data-offline", now, now);
    db.close();
    await page.reload();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const button = corner(page);
    await expect(button.locator(".px-jobs-sep")).toBeVisible();

    // The button and everything in it: both parts, the clock, the alert icon, both counts and the divider.
    const boxes = () =>
      button.evaluate((element) =>
        [element, ...element.querySelectorAll(".px-jobs-part, .px-jobs-sep, svg, .meta")].map((child) => {
          const rect = child.getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n * 100) / 100);
        }),
      );
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((next) => window.pyxis.setAppearance(next), theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.mouse.move(640, 400);
      await page.waitForTimeout(300);
      const idle = await boxes();
      expect(idle).toHaveLength(8);

      await button.hover();
      await expect(button).toHaveCSS("background-color", /^rgb\(/);
      await page.waitForTimeout(300);
      expect(await boxes(), `${theme}: hovered`).toEqual(idle);

      await page.mouse.down();
      await page.waitForTimeout(300);
      expect(await boxes(), `${theme}: pressed`).toEqual(idle);
      await page.mouse.up();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await page.waitForTimeout(300);
      expect(await boxes(), `${theme}: open`).toEqual(idle);
      await page.keyboard.press("Escape");
      await expect(button).toHaveAttribute("aria-expanded", "false");

      await page.mouse.move(640, 400);
      await page.waitForTimeout(300);
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS("outline-style", "solid");
      expect(await boxes(), `${theme}: keyboard focus`).toEqual(idle);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
