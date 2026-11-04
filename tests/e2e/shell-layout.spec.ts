import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan } from "./seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

test("the window opens on Chiedi, with the greeting and the composer in the middle, and the brand goes back to it", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-shell-landing-"));
  let app = await launchPyxis({ userData });
  try {
    let page = await app.firstWindow();
    // During setup the brand is plain text: setup cannot be left from the top bar.
    await expect(page.locator(".px-brand")).toBeVisible();
    await expect(page.getByRole("link", { name: "Pyxis", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);

    // Home: the greeting, then the composer right under it, the pair near the middle of the window.
    const greeting = page.getByRole("heading", { level: 1 });
    await expect(greeting).toHaveText(/^(Buongiorno|Buon pomeriggio|Buonasera)$/);
    const composer = page.locator(".px-composer");
    await expect(page.getByRole("textbox", { name: "Messaggio" })).toBeVisible();
    const heading = (await greeting.boundingBox())!;
    const box = (await composer.boundingBox())!;
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(box.y).toBeGreaterThan(heading.y + heading.height);
    expect(box.y - (heading.y + heading.height)).toBeLessThan(48);
    const middle = (heading.y + box.y + box.height) / 2;
    expect(middle).toBeGreaterThan(viewport.height * 0.35);
    expect(middle).toBeLessThan(viewport.height * 0.65);
    expect(Math.abs(heading.x + heading.width / 2 - viewport.width / 2)).toBeLessThan(40);

    // The brand opens Home from any other page.
    await page.locator("header nav").getByRole("link", { name: "Esami", exact: true }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.getByRole("link", { name: "Pyxis", exact: true }).click();
    await expect(page).toHaveURL(/#\/ask$/);

    // The next start opens on Chiedi too.
    await app.close();
    app = await launchPyxis({ userData });
    page = await app.firstWindow();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^(Buongiorno|Buon pomeriggio|Buonasera)$/);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("doors navigate from settings and every shell page uses the full column", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-shell-layout-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);

    const doors = page.getByRole("navigation", { name: "Sezioni" });
    const door = (name: string) => doors.getByRole("link", { name, exact: true });
    const selected = doors.locator('[aria-current="page"]');
    await expect(selected).toHaveText("Esami");

    await door("Chiedi").click();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(selected).toHaveText("Chiedi");

    // Settings belongs to no door: neither is highlighted and both navigate.
    await page.getByRole("link", { name: "Impostazioni", exact: true }).click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(selected).toHaveCount(0);
    await door("Chiedi").click();
    await expect(page).toHaveURL(/#\/ask$/);

    await page.getByRole("link", { name: "Impostazioni", exact: true }).click();
    await expect(selected).toHaveCount(0);
    await door("Esami").click();
    await expect(page).toHaveURL(/#\/exams$/);

    // The book icon opens the Library and is marked as the current tool there.
    const library = page.getByRole("link", { name: "Libreria", exact: true });
    await library.click();
    await expect(page).toHaveURL(/#\/exams\/library$/);
    await expect(library).toHaveAttribute("aria-current", "page");
    await door("Esami").click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(library).not.toHaveAttribute("aria-current", "page");

    // Exams and Ask share one column width, Settings and its subpages share a wider one for the sidebar, and the logo stays put.
    const widths: number[] = [];
    const settingsWidths: number[] = [];
    const logoX: number[] = [];
    for (const hash of [
      "#/exams",
      "#/ask",
      "#/maps",
      "#/settings",
      "#/settings/appearance",
      "#/exams/get",
    ]) {
      await page.evaluate((next) => {
        window.location.hash = next;
      }, hash);
      const container = page.locator(".px-shell-container");
      await expect(container).toBeVisible();
      // The column changes width with the route, a moment after the hash: measure once the new page has laid out.
      await expect(page).toHaveURL(new RegExp(`${hash.replaceAll("/", "\\/")}$`));
      await expect
        .poll(async () => Math.round((await container.boundingBox())!.width))
        .toBe(hash.startsWith("#/settings") ? 960 : 768);
      // Maps loads its page on first visit; measure once it is there, so a late chunk can't hide a page of another width.
      if (hash === "#/maps") {
        await expect(page.getByRole("heading", { level: 1, name: "Mappe" })).toBeVisible();
        expect(Math.round((await page.locator(".px-maps").boundingBox())!.width)).toBe(
          Math.round((await page.locator(".shell-page").boundingBox())!.width),
        );
      }
      (hash.startsWith("#/settings") ? settingsWidths : widths).push(
        Math.round((await container.boundingBox())!.width),
      );
      logoX.push(Math.round((await page.locator("header .px-brand").boundingBox())!.x));
    }
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(768);
    expect(new Set(settingsWidths).size).toBe(1);
    expect(settingsWidths[0]).toBe(960);
    expect(new Set(logoX).size).toBe(1);

    // The header spans the window: the mark and name at the left edge, the sections right after them, the icons at
    // the right edge.
    await page.evaluate(() => {
      window.location.hash = "#/exams";
    });
    const header = (await page.locator("header.px-top").boundingBox())!;
    const logo = (await page.locator("header .px-brand").boundingBox())!;
    const doorsBox = (await doors.boundingBox())!;
    const settings = (await page.getByRole("link", { name: "Impostazioni", exact: true }).boundingBox())!;
    // macOS leaves room for the traffic lights (80px); elsewhere the logo sits at the edge.
    if (process.platform === "darwin") {
      expect(logo.x).toBeGreaterThanOrEqual(78);
      expect(logo.x).toBeLessThan(90);
    } else expect(logo.x).toBeLessThan(40);
    expect(doorsBox.x - (logo.x + logo.width)).toBeGreaterThan(0);
    expect(doorsBox.x - (logo.x + logo.width)).toBeLessThan(40);
    expect(header.x + header.width - (settings.x + settings.width)).toBeLessThan(40);

    // A click on the door that is already active goes to that door's root.
    await page.evaluate(() => {
      window.location.hash = "#/exams/library";
    });
    await expect(page).toHaveURL(/#\/exams\/library$/);
    await door("Esami").click();
    await expect(page).toHaveURL(/#\/exams$/);

    // A plan page offers a way back to the exams.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seedPlan(db, { id: "p-1", title: "Fisica 1", language: "it", target: 0.75 });
    db.close();
    await page.evaluate(() => {
      window.location.hash = "#/plans/p-1";
    });
    await page.getByRole("main").getByRole("link", { name: "Esami", exact: true }).click();
    await expect(page).toHaveURL(/#\/exams$/);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
