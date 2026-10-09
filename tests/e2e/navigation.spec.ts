import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("the window stays on the app page and refuses device permissions", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-navigation-"));
  // A page with a script beside it, as a dropped or linked folder could carry.
  writeFileSync(join(userData, "page.js"), "document.title = 'foreign';");
  writeFileSync(
    join(userData, "page.html"),
    '<html><body><script src="page.js"></script></body></html>',
  );
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("load");
    const appPage = page.url().split("#")[0];
    const foreign = pathToFileURL(join(userData, "page.html")).href;
    await page.evaluate((url) => {
      location.href = url;
    }, foreign);
    await page.waitForTimeout(1000);
    expect(page.url().split("#")[0]).toBe(appPage);
    expect(await page.title()).not.toBe("foreign");

    // In-app navigation and reloads still work.
    await page.evaluate(() => {
      location.hash = "#/settings";
    });
    await page.reload();
    await expect.poll(() => page.url()).toContain("#/settings");

    const permissions = await page.evaluate(async () => {
      const state = async (name: string) =>
        (await navigator.permissions.query({ name } as PermissionDescriptor))
          .state;
      return {
        camera: await state("camera"),
        geolocation: await state("geolocation"),
      };
    });
    expect(permissions).toEqual({ camera: "denied", geolocation: "denied" });
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
