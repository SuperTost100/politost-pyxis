import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

    // The header spans the window: logo at the left edge, actions at the right, doors centred on the window.
    await page.evaluate(() => {
      window.location.hash = "#/exams";
    });
    const header = (await page.locator("header .ant-pro-top-nav-header").boundingBox())!;
    const logo = (await page.locator("header").getByRole("img", { name: "Pyxis" }).boundingBox())!;
    const doorsBox = (await doors.boundingBox())!;
    const settings = (await page.getByRole("button", { name: "Impostazioni", exact: true }).boundingBox())!;
    expect(logo.x).toBeLessThan(40);
    expect(Math.abs(doorsBox.x + doorsBox.width / 2 - (header.x + header.width / 2))).toBeLessThanOrEqual(2);
    expect(header.x + header.width - (settings.x + settings.width)).toBeLessThan(40);

    // A click on the door that is already active goes to that door's root.
    await page.evaluate(() => {
      window.location.hash = "#/exams/library";
    });
    await expect(page).toHaveURL(/#\/exams\/library$/);
    await doors.getByText("Esami", { exact: true }).click();
    await expect(page).toHaveURL(/#\/exams$/);

    // A plan page offers a way back to the exams.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    db.exec(`
      INSERT INTO plans(id,title,status,content_language,target,created_at,updated_at) VALUES('p-1','Fisica 1','ready','it',0.75,1,1);
    `);
    db.close();
    await page.evaluate(() => {
      window.location.hash = "#/plans/p-1";
    });
    await page.getByRole("link", { name: "Esami", exact: true }).click();
    await expect(page).toHaveURL(/#\/exams$/);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
