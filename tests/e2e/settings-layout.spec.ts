import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("settings show a sidebar from 960px and drill down below it", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-settings-layout-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    const sidebar = page.getByRole("navigation", { name: "Impostazioni" });
    const back = page.getByRole("button", { name: "Torna alle impostazioni" });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      window.location.hash = "#/settings";
    });
    // Two panes: every section is in the sidebar, and one is already open beside it.
    await expect(sidebar.getByRole("button")).toHaveCount(11);
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
