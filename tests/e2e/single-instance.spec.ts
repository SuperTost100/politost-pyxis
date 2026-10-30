import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";

test("the running copy holds the single-instance lock for its profile", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-single-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/exams/);

    // The running copy holds Electron's single-instance lock, so a second launch on this profile gets none and quits.
    // A second copy is not started here: Playwright's connection to an app that exits at once breaks unpredictably.
    expect(
      await app.evaluate(({ app: electronApp }) =>
        electronApp.hasSingleInstanceLock(),
      ),
    ).toBe(true);
    expect(app.windows()).toHaveLength(1);
    await expect(
      page.getByRole("heading", { name: "Esami", level: 1 }),
    ).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("answers outside a plan follow the interface language", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-language-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/exams/);
    const language = () =>
      page.evaluate(
        async () =>
          (
            (await window.pyxis.invoke("profile.get", {})) as {
              contentLanguage: string;
            } | null
          )?.contentLanguage,
      );
    await expect.poll(language).toBe("Italian");
    await page.evaluate(() => {
      location.hash = "/settings/language";
    });
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expect.poll(language).toBe("English");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
