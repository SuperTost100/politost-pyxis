import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a fresh window opens on onboarding", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-e2e-"));
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env: { ...process.env, PYXIS_USER_DATA: userData },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("main h1")).toHaveText("Iniziamo");
    await expect(page.locator("header h1:visible")).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
