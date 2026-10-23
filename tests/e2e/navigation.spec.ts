import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launchPyxis } from "./app-under-test";

test("the window stays on the app page and refuses device permissions", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-navigation-"));
  // A page with a script beside it, as a dropped or linked folder could carry.
  writeFileSync(join(userData, "page.js"), "document.title = 'foreign';");
  writeFileSync(
    join(userData, "page.html"),
    '<html><body><script src="page.js"></script></body></html>',
  );
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    // A workspace without a profile always returns to onboarding, so finish it first.
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    const appPage = page.url().split("#")[0];
    const foreign = pathToFileURL(join(userData, "page.html")).href;
    await page.evaluate((url) => {
      location.href = url;
    }, foreign);
    // Main refuses the navigation without an event the page can see, so give a wrong one a fixed second to happen.
    await page.waitForTimeout(1000);
    expect(page.url().split("#")[0]).toBe(appPage);
    expect(await page.title()).not.toBe("foreign");

    // In-app navigation and reloads still work.
    await page.evaluate(() => {
      location.hash = "#/settings";
    });
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Impostazioni" }),
    ).toBeVisible();
    expect(page.url()).toContain("#/settings");

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

test("a page opened while the start page still redirects to Exams is not lost", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-navigation-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    // The window's start page sends it on to Exams. Settings, opened right after and not loaded yet, must win, as when
    // a plan file or a menu command opens a page while the window starts.
    await page.evaluate(() => {
      location.hash = "#/";
      location.hash = "#/settings";
    });
    await expect(page.getByRole("heading", { name: "Impostazioni" })).toBeVisible();
    await expect(page).toHaveURL(/#\/settings$/);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
