import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";

test("SET-05 deleting all data removes saved engine keys across a restart", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-wipe-keys-"));
  let app = await launchPyxis({ userData });
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Exams; wait so a reload or route change cannot land on setup.
    await expect(page).toHaveURL(/#\/exams$/);
    await expect.poll(() => page.evaluate(() => window.pyxis.invoke("profile.get", {}))).not.toBeNull();
    const status = await page.evaluate(() => window.pyxis.keys.status());
    test.skip(!status.canSave, "This platform has no secure key store.");
    // A synthetic credential is stored locally; this test makes no provider request.
    await page.evaluate(() => window.pyxis.keys.set("anthropic", "fixture-only-never-a-real-key"));
    expect((await page.evaluate(() => window.pyxis.keys.status())).configured).toContain("anthropic");
    expect(await page.evaluate(() => window.pyxis.wipeWorkspace({ backups: false }))).toBe("wiped");
    expect(JSON.parse(readFileSync(join(userData, "keys.json"), "utf8"))).toEqual({});
    expect((await page.evaluate(() => window.pyxis.keys.status())).configured).toEqual([]);
    await expect.poll(() => page.evaluate(() => window.pyxis.invoke("profile.get", {}))).toBeNull();
    await app.close();
    app = await launchPyxis({ userData });
    page = await app.firstWindow();
    expect((await page.evaluate(() => window.pyxis.keys.status())).configured).toEqual([]);
    await expect(page.getByRole("button", { name: "Salta" })).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
