import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

test("settings show six pages in a sidebar from 960px and drill down below it", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-settings-layout-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping setup opens Exams; a route set before that lands is replaced by it.
    await fromChiediToExams(page);
    const sidebar = page.getByRole("navigation", { name: "Impostazioni" });
    const back = page.getByRole("button", { name: "Torna alle impostazioni" });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      window.location.hash = "#/settings";
    });
    // Two panes: the six pages are in the sidebar, Informazioni at its foot, and one is already open beside it.
    const pages = sidebar.getByRole("button");
    await expect(pages).toHaveText([
      "Profilo",
      "Strumenti AI",
      /^Studio/,
      "Aspetto e lingua",
      "Dati e privacy",
      "Informazioni",
    ]);
    await expect(sidebar.getByRole("button", { name: "Profilo" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1, name: "Profilo" })).toBeVisible();
    const foot = (await pages.last().boundingBox())!;
    const above = (await pages.nth(4).boundingBox())!;
    expect(foot.y - (above.y + above.height)).toBeGreaterThan(100);
    await expect(back).toHaveCount(0);

    await sidebar.getByRole("button", { name: "Aspetto e lingua" }).click();
    await expect(page).toHaveURL(/#\/settings\/appearance$/);
    await expect(sidebar.getByRole("button", { name: "Aspetto e lingua" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("heading", { level: 2, name: "Tema" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Italiano" })).toBeChecked();
    await expect(back).toHaveCount(0);

    // A link to one section opens the page that holds it, at that section.
    await page.evaluate(() => {
      window.location.hash = "#/settings/updates";
    });
    await expect(sidebar.getByRole("button", { name: "Informazioni" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 2, name: "Aggiornamenti" })).toBeInViewport();
    // A section that fits in the window opens without scrolling the page's titles away, even in a short window.
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.evaluate(() => {
      window.location.hash = "#/settings/version";
    });
    await expect(page.getByRole("heading", { level: 2, name: "Versione e licenze" })).toBeInViewport();
    await expect(page.getByRole("heading", { level: 1, name: "Informazioni" })).toBeInViewport({ ratio: 1 });
    // With the licences open the version section is taller than the window. From the page's own link, scrolled into the
    // middle of that section, the version link brings its heading back.
    await page.evaluate(() => {
      window.location.hash = "#/settings/about";
    });
    await page.locator(".px-about-notices > summary").click();
    const version = page.locator("#settings-version");
    await expect.poll(async () => (await version.boundingBox())!.height).toBeGreaterThan(1200);
    await page.evaluate(() => {
      const top = document.getElementById("settings-version")!.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: top + 400 });
    });
    await expect(page.getByRole("heading", { level: 2, name: "Versione e licenze" })).not.toBeInViewport();
    await page.evaluate(() => {
      window.location.hash = "#/settings/version";
    });
    await expect(page.getByRole("heading", { level: 2, name: "Versione e licenze" })).toBeInViewport();
    // It stops below the strip that drags the window on macOS, here forced on, not behind it.
    await page.evaluate(() => (document.documentElement.dataset.platform = "darwin"));
    await page.evaluate(() => {
      window.location.hash = "#/settings/updates";
    });
    await page.evaluate(() => {
      const top = document.getElementById("settings-version")!.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: top + 400 });
    });
    await page.evaluate(() => {
      window.location.hash = "#/settings/version";
    });
    const headingTop = () =>
      page.evaluate(() => Math.round(document.querySelector("#settings-version h2")!.getBoundingClientRect().top));
    // The scroll lands near the top, below the strip. Before it, the heading sits above the window, so both bounds are
    // checked together.
    await expect
      .poll(async () => {
        const top = await headingTop();
        return top >= 28 && top < 120;
      })
      .toBe(true);
    await page.evaluate(() => (document.documentElement.dataset.platform = "linux"));
    await page.locator(".px-about-notices > summary").click();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      window.location.hash = "#/settings/reminders";
    });
    await expect(sidebar.getByRole("button", { name: /^Studio/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 2, name: "Promemoria di studio" })).toBeInViewport();
    await page.evaluate(() => {
      window.location.hash = "#/settings/diagnostics";
    });
    await expect(sidebar.getByRole("button", { name: "Strumenti AI" })).toHaveAttribute("aria-current", "page");
    // Diagnostics has no section of its own: the page opens at the engines section, wherever the window was scrolled.
    await expect
      .poll(() => page.evaluate(() => Math.round(document.getElementById("settings-engines")!.getBoundingClientRect().top)))
      .toBeLessThan(200);
    await expect
      .poll(() => page.evaluate(() => Math.round(document.getElementById("settings-engines")!.getBoundingClientRect().top)))
      .toBeGreaterThanOrEqual(0);

    // The two Data buttons have the standard 12px gap between them.
    await sidebar.getByRole("button", { name: "Dati e privacy" }).click();
    const backup = (await page.getByRole("button", { name: "Copia di sicurezza", exact: true }).boundingBox())!;
    const restore = (await page.getByRole("button", { name: "Ripristina", exact: true }).boundingBox())!;
    expect(Math.round(restore.x - (backup.x + backup.width))).toBe(12);

    // Crossing 960px re-lays the page out without remounting the open section, so an open drawer stays open.
    await page.evaluate(() =>
      window.pyxis.invoke("engines.acknowledge", {
        providers: ["claude", "codex", "agent", "antigravity"],
      }),
    );
    await sidebar.getByRole("button", { name: "Strumenti AI" }).click();
    await page.getByRole("switch", { name: "Opzioni avanzate" }).click();
    await page.getByRole("button", { name: /^Claude Code/ }).click();
    const drawer = page.getByRole("dialog", { name: "Claude Code", exact: true });
    await expect(drawer).toBeVisible();
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(sidebar).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(sidebar).toBeVisible();
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: /^(Close|Chiudi)$/ }).click();
    await expect(drawer).toHaveCount(0);
    await sidebar.getByRole("button", { name: "Dati e privacy" }).click();

    // Below 960px the sections are pages again, with a way back to the list.
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(sidebar).toHaveCount(0);
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.getByRole("button", { name: /^Studio/ })).toBeVisible();
    await page.getByRole("button", { name: /^Aspetto/ }).click();
    await expect(page).toHaveURL(/#\/settings\/appearance$/);
    await expect(back).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Studio: one choice is radio rows, on or off a switch, the text size a segmented control, new cards a stepper", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-settings-controls-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => {
      window.location.hash = "#/settings/study";
    });
    const profile = () => page.evaluate(() => window.pyxis.invoke("profile.get", {} as never)) as Promise<{
      tutorMode: string;
      followups: boolean;
      textSize: string;
      dyslexia: boolean;
    }>;

    // How it explains: two radio rows, each with a line on what it does, and a switch for follow-up questions.
    const how = page.getByRole("radiogroup", { name: "Come ti spiega" });
    await expect(how.getByRole("radio")).toHaveCount(2);
    await expect(how.getByRole("radio", { name: /^Passo per passo/ })).toBeChecked();
    await how.getByRole("radio", { name: /^Con domande/ }).check();
    await expect.poll(async () => (await profile()).tutorMode).toBe("socratic");
    const followups = page.getByRole("switch", { name: "Proponi domande per approfondire" });
    await expect(followups).toHaveAttribute("aria-checked", "true");
    await followups.click();
    await expect.poll(async () => (await profile()).followups).toBe(false);

    // Reading: the size is a segmented control that arrows move, and the dyslexia spacing a switch.
    const size = page.getByRole("radiogroup", { name: "Dimensione del testo" });
    await expect(size.getByRole("radio", { name: "Normale" })).toHaveAttribute("aria-checked", "true");
    await size.getByRole("radio", { name: "Normale" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(size.getByRole("radio", { name: "Grande" })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("html")).toHaveAttribute("data-text", "lg");
    await page.getByRole("switch", { name: "Spaziatura per la dislessia" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-dyslexia", "on");
    await expect(page.getByText("Anteprima", { exact: true })).toBeVisible();

    // New cards a day: − and + step by five and save; a number typed in saves when the field is left.
    const cards = page.getByRole("textbox", { name: "Nuove flashcard giornaliere per ogni esame" });
    await expect(cards).toHaveValue("20");
    await page.getByRole("button", { name: "Più" }).click();
    await expect(cards).toHaveValue("25");
    await cards.fill("7");
    await cards.press("Enter");
    await expect.poll(() => page.evaluate(() => window.pyxis.invoke("study.cardSettings", {} as never))).toEqual(
      expect.objectContaining({ newPerDay: 7 }),
    );
    await expect(page.getByText(/^Con 7 e tre esami, ogni giorno ne iniziano fino a 21\./)).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
