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
    await expect(page.getByRole("button", { name: "Italiano" })).toBeVisible();
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
