import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("SET-05 deleting all data removes saved engine keys across a restart", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-wipe-keys-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [join(process.cwd(), "out/main/index.js")];
  let app = await electron.launch({ args, env });
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect.poll(() => page.evaluate(() => window.pyxis.invoke("profile.get", {}))).not.toBeNull();
    const status = await page.evaluate(() => window.pyxis.keys.status());
    test.skip(!status.canSave, "This platform has no secure key store.");
    // A synthetic credential is stored locally; this test makes no provider request.
    await page.evaluate(() => window.pyxis.keys.set("anthropic", "fixture-only-never-a-real-key"));
    expect((await page.evaluate(() => window.pyxis.keys.status())).configured).toContain("anthropic");
    expect(await page.evaluate(() => window.pyxis.wipeWorkspace())).toBe("wiped");
    expect(JSON.parse(readFileSync(join(userData, "keys.json"), "utf8"))).toEqual({});
    expect((await page.evaluate(() => window.pyxis.keys.status())).configured).toEqual([]);
    await expect.poll(() => page.evaluate(() => window.pyxis.invoke("profile.get", {}))).toBeNull();
    await app.close();
    app = await electron.launch({ args, env });
    page = await app.firstWindow();
    expect((await page.evaluate(() => window.pyxis.keys.status())).configured).toEqual([]);
    await expect(page.getByRole("button", { name: "Salta" })).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
