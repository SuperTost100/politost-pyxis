import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";

test("settings show a sidebar from 960px and drill down below it", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-settings-layout-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping setup opens Exams; a route set before that lands is replaced by it.
    await expect(page).toHaveURL(/#\/exams$/);
    const sidebar = page.getByRole("navigation", { name: "Impostazioni" });
    const back = page.getByRole("button", { name: "Torna alle impostazioni" });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      window.location.hash = "#/settings";
    });
    // Two panes: every section is in the sidebar, and one is already open beside it.
    await expect(sidebar.getByRole("button")).toHaveCount(13);
    await expect(sidebar.getByRole("button", { name: "Profilo e interessi" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("heading", { level: 2, name: "Profilo e interessi" })).toBeVisible();
    await expect(back).toHaveCount(0);

    await sidebar.getByRole("button", { name: "Lingua" }).click();
    await expect(page).toHaveURL(/#\/settings\/language$/);
    await expect(sidebar.getByRole("button", { name: "Lingua" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("button", { name: "Italiano" })).toBeVisible();
    await expect(back).toHaveCount(0);

    // The two Data buttons have the standard 12px gap between them.
    await sidebar.getByRole("button", { name: "Dati" }).click();
    const backup = (await page.getByRole("button", { name: "Copia di sicurezza", exact: true }).boundingBox())!;
    const restore = (await page.getByRole("button", { name: "Ripristina", exact: true }).boundingBox())!;
    expect(Math.round(restore.x - (backup.x + backup.width))).toBe(12);

    // Crossing 960px re-lays the page out without remounting the open section, so an open drawer stays open.
    await page.evaluate(() =>
      window.pyxis.invoke("engines.acknowledge", {
        providers: ["claude", "codex", "agent", "antigravity"],
      }),
    );
    await sidebar.getByRole("button", { name: "Motori AI" }).click();
    await page.getByRole("switch", { name: "Opzioni avanzate" }).click();
    await page.getByRole("button", { name: "Dettagli di Claude Code" }).click();
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
    await sidebar.getByRole("button", { name: "Dati" }).click();

    // Below 960px the sections are pages again, with a way back to the list.
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(sidebar).toHaveCount(0);
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.getByRole("button", { name: /^Tutor/ })).toBeVisible();
    await page.getByRole("button", { name: /^Aspetto/ }).click();
    await expect(page).toHaveURL(/#\/settings\/appearance$/);
    await expect(back).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
