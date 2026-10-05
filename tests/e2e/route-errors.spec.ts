import { _electron as electron, expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("route failure shows a plain recovery page without stack details", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-route-error-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [join(process.cwd(), "out/main/index.js")], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => { window.location.hash = "/missing-route"; });
    await expect(page.getByRole("heading", { name: "Non è stato possibile aprire questa pagina" })).toBeVisible();
    await expect(page.locator("pre")).toHaveCount(0);
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
    await page.screenshot({ path: ".shots/route-error-it.png" });
    await page.getByRole("link", { name: "Vai agli esami" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(page.getByRole("heading", { name: "Non è stato possibile aprire questa pagina" })).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
