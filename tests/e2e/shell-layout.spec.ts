import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan } from "./seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { animationsSettled } from "./settled";
import { saveShot } from "./shots";

test("the window opens on Chiedi, with the greeting and the composer in the middle, and the brand goes back to it", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-shell-landing-"));
  let app = await launchPyxis({ userData });
  try {
    let page = await app.firstWindow();
    // Setup has no sidebar and its brand is plain text: setup cannot be left from there.
    await expect(page.locator(".px-brand")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Barra laterale" })).toHaveCount(0);
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
    // Centred in the chat area, which takes the window beside the app's sidebar.
    const column = (await page.locator(".ask-page").boundingBox())!;
    expect(Math.abs(heading.x + heading.width / 2 - (column.x + column.width / 2))).toBeLessThan(4);
    const sidebar = (await page.getByRole("complementary", { name: "Barra laterale" }).boundingBox())!;
    expect(sidebar.x).toBe(0);
    expect(column.x).toBeGreaterThanOrEqual(sidebar.width);

    // The brand opens Home from any other page.
    await page.getByRole("navigation", { name: "Sezioni" }).getByRole("link", { name: "Esami", exact: true }).click();
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

test("the sidebar navigates from settings, folds to icons and every shell page uses the full column", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-shell-layout-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);

    const side = page.getByRole("complementary", { name: "Barra laterale" });
    const doors = page.getByRole("navigation", { name: "Sezioni" });
    const door = (name: string) => doors.getByRole("link", { name, exact: true });
    const selected = doors.locator('[aria-current="page"]');
    await expect(selected).toHaveAccessibleName("Esami");

    await door("Nuova chat").click();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(selected).toHaveAccessibleName("Nuova chat");

    // Settings, from the profile's menu at the foot, belongs to no section: none is highlighted and each navigates.
    const settings = async () => {
      await side.getByRole("button", { name: /^Profilo/ }).click();
      await page.getByRole("menuitem", { name: "Impostazioni" }).click();
      await expect(page).toHaveURL(/#\/settings$/);
    };
    await settings();
    await expect(selected).toHaveCount(0);
    await door("Nuova chat").click();
    await expect(page).toHaveURL(/#\/ask$/);
    await settings();
    await door("Esami").click();
    await expect(page).toHaveURL(/#\/exams$/);

    // The Library has its own row, and Esami never leads back into it.
    const library = door("Libreria");
    await library.click();
    await expect(page).toHaveURL(/#\/exams\/library$/);
    await expect(library).toHaveAttribute("aria-current", "page");
    await expect(door("Esami")).not.toHaveAttribute("aria-current", "page");
    await door("Mappe").click();
    await expect(page).toHaveURL(/#\/maps$/);
    // Flashcard sits between Mappe and Libreria and is a section of its own.
    await expect(doors.getByRole("link")).toHaveText(["Nuova chat", "Esami", "Mappe", "Flashcard", "Libreria"].map((name) => new RegExp(`^${name}`)));
    await door("Flashcard").click();
    await expect(page).toHaveURL(/#\/flashcards$/);
    await expect(selected).toHaveAccessibleName("Flashcard");
    await door("Esami").click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(library).not.toHaveAttribute("aria-current", "page");

    // Ask, Maps and shared plans share one column width, Settings and its subpages share a wider one for the sidebar,
    // the exam list has its own 828px column with its padding, and the sidebar stays put at the left edge.
    const widths: number[] = [];
    const settingsWidths: number[] = [];
    const sideBoxes = new Set<string>();
    for (const hash of [
      "#/exams",
      "#/ask",
      "#/maps",
      "#/flashcards",
      "#/settings",
      "#/settings/appearance",
      "#/exams/get",
    ]) {
      await page.evaluate((next) => {
        window.location.hash = next;
      }, hash);
      await expect(page).toHaveURL(new RegExp(`${hash.replaceAll("/", "\\/")}$`));
      const box = (await side.boundingBox())!;
      sideBoxes.add(`${box.x},${box.y},${box.width},${box.height}`);
      // Chiedi runs edge to edge beside the sidebar, as wide as the other pages' column where it fits.
      if (hash === "#/ask") {
        const chat = (await page.locator(".ask-dock").boundingBox())!;
        const room = (await page.locator(".ask-layout").boundingBox())!.width;
        expect(Math.round(chat.width)).toBe(Math.min(768, Math.round(room)));
        continue;
      }
      const container = page.locator(".px-shell-container");
      await expect(container).toBeVisible();
      // The column changes width with the route, a moment after the hash: measure once the new page has laid out.
      await expect
        .poll(async () => Math.round((await container.boundingBox())!.width))
        .toBe(hash.startsWith("#/settings") ? 960 : hash === "#/exams" ? 876 : 768);
      // Maps loads its page on first visit; measure once it is there, so a late chunk can't hide a page of another width.
      if (hash === "#/maps") {
        await expect(page.getByRole("heading", { level: 1, name: "Mappe" })).toBeVisible();
        expect(Math.round((await page.locator(".px-maps").boundingBox())!.width)).toBe(
          Math.round((await page.locator(".shell-page").boundingBox())!.width),
        );
      }
      if (hash === "#/exams") continue;
      (hash.startsWith("#/settings") ? settingsWidths : widths).push(
        Math.round((await container.boundingBox())!.width),
      );
    }
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(768);
    expect(new Set(settingsWidths).size).toBe(1);
    expect(settingsWidths[0]).toBe(960);
    expect([...sideBoxes]).toEqual(["0,0,260,760"]);

    // Folded, the sidebar is a column of icons whose links keep their names, and it stays folded after a reload.
    await page.evaluate(() => {
      window.location.hash = "#/exams";
    });
    // On macOS the column also fits the traffic lights with the same margin on each side.
    const foldedWidth = process.platform === "darwin" ? 92 : 76;
    await side.getByRole("button", { name: "Riduci la barra" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await side.boundingBox())!.width).toBe(foldedWidth);
    // Folded, the mark itself unfolds the sidebar, as in Tost Work: there is no second button, and the focus moved to it.
    const unfold = side.getByRole("button", { name: "Espandi la barra" });
    await expect(unfold).toBeFocused();
    await expect(side.getByRole("link", { name: "Pyxis" })).toHaveCount(0);
    await expect(side.locator(".px-side-fold")).toHaveCount(0);
    // At rest it shows the mark; on hover the sidebar icon takes its place.
    const showing = () =>
      unfold.evaluate((button) =>
        [".px-brand-mark", ".px-side-unfold-icon"].map((part) => getComputedStyle(button.querySelector(part)!).opacity),
      );
    await page.mouse.move(900, 400);
    await unfold.blur();
    await expect.poll(showing).toEqual(["1", "0"]);
    await unfold.hover();
    await expect.poll(showing).toEqual(["0", "1"]);
    // Each row is its icon alone, 40px wide.
    expect((await door("Mappe").boundingBox())!.width).toBe(40);
    await expect(door("Esami")).toHaveAttribute("aria-current", "page");
    await page.reload();
    await expect.poll(async () => (await side.boundingBox())!.width).toBe(foldedWidth);
    await door("Mappe").click();
    await expect(page).toHaveURL(/#\/maps$/);
    await side.getByRole("button", { name: "Espandi la barra" }).click();
    await expect.poll(async () => (await side.boundingBox())!.width).toBe(260);

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

test("a notice opens in the page column, under the drag strip and Attività, no wider than its text", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-shell-notice-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_SAVE: join(userData, "exam.ics") } });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    const examAt = Date.now() + 10 * 86_400_000;
    seedPlan(db, { id: "p-notice", title: "Analisi 1", examAt });
    db.prepare("INSERT INTO plan_sessions (id,plan_id,date,created_at) VALUES (?,?,?,1)").run("p-notice", "p-notice", examAt);
    db.close();

    // Each combination the route audit checks first: Italian dark at 960, English light at 1280.
    for (const [language, theme, width] of [
      ["it", "dark", 960],
      ["en", "light", 1280],
    ] as const) {
      await page.evaluate(
        async ({ language, theme }) => {
          localStorage.setItem("pyxis.lang", language);
          await window.pyxis.setAppearance(theme);
          location.hash = "/plans/p-notice";
        },
        { language, theme },
      );
      await page.setViewportSize({ width, height: 800 });
      await page.reload();
      await page
        .locator(".px-plan-header-actions")
        .getByRole("button", { name: /^(Aggiungi al calendario|Add to calendar)$/ })
        .click();
      const notice = page.locator(".ant-message-notice", {
        hasText: /File del calendario salvato|Calendar file saved/,
      });
      await expect(notice).toBeVisible();
      await animationsSettled(page);
      const box = (await notice.boundingBox())!;
      const strip = (await page.locator(".px-drag").boundingBox())!;
      const tools = (await page.locator(".px-corner-tools").boundingBox())!;
      const side = (await page.getByRole("complementary", { name: /^(Barra laterale|Sidebar)$/ }).boundingBox())!;
      const column = (await page.locator(".px-column").boundingBox())!;
      // Below the strip that drags the window and below Attività, so it covers neither nor the traffic lights.
      expect(box.y).toBeGreaterThanOrEqual(strip.y + strip.height);
      expect(box.y).toBeGreaterThanOrEqual(tools.y + tools.height);
      // In the page column, centred on it, beside the sidebar.
      expect(box.x).toBeGreaterThanOrEqual(side.x + side.width);
      expect(Math.abs(box.x + box.width / 2 - (column.x + column.width / 2))).toBeLessThan(2);
      // As wide as its text, up to 560px, and a longer text wraps instead of spanning the window.
      expect(box.width).toBeLessThan(560);
      expect(await notice.evaluate((element) => getComputedStyle(element).maxWidth)).toBe("560px");
      // It adds nothing to the page's height: a page that could scroll while it shows would jump back when it closes.
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight)).toBe(0);
      await saveShot(page, `notice-${language}-${theme}-${width}.png`, { animations: "disabled" });
      await expect(notice).toHaveCount(0, { timeout: 10000 });
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
