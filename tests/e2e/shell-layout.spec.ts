import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("doors navigate from settings and every shell page uses the full column", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-shell-layout-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);

    const doors = page.locator("header .px-doors");
    const selected = doors.locator(".ant-segmented-item-selected-text");
    await expect(selected).toHaveText(/Esami/);

    await doors.getByText("Chiedi", { exact: true }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(selected).toHaveText(/Chiedi/);

    // Settings belongs to no door: neither is highlighted and both navigate.
    await page.getByRole("button", { name: "Impostazioni", exact: true }).click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(selected).toHaveCount(0);
    await doors.getByText("Chiedi", { exact: true }).click();
    await expect(page).toHaveURL(/#\/ask$/);

    await page.getByRole("button", { name: "Impostazioni", exact: true }).click();
    await expect(selected).toHaveCount(0);
    await doors.getByText("Esami", { exact: true }).click();
    await expect(page).toHaveURL(/#\/exams$/);

    // Settings, its subpages, Exams and Ask share one column width, and the logo stays put.
    const widths: number[] = [];
    const logoX: number[] = [];
    for (const hash of [
      "#/exams",
      "#/ask",
      "#/settings",
      "#/settings/appearance",
      "#/exams/get",
    ]) {
      await page.evaluate((next) => {
        window.location.hash = next;
      }, hash);
      const container = page.locator(".px-shell-container");
      await expect(container).toBeVisible();
      widths.push(Math.round((await container.boundingBox())!.width));
      logoX.push(
        Math.round((await page.getByRole("img", { name: "Pyxis" }).boundingBox())!.x),
      );
    }
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(768);
    expect(new Set(logoX).size).toBe(1);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
