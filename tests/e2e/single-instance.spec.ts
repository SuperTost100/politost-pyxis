import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(process.cwd(), "out/main/index.js");

test("a second launch on the same profile quits and leaves the first one running", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-single-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/exams/);

    // The second copy would open the same database. It must exit on its own, without opening a window.
    const second = await electron
      .launch({ args: [MAIN], env, timeout: 30000 })
      .catch(() => null);
    if (second) {
      const child = second.process();
      if (child.exitCode === null)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("second instance kept running")),
            30000,
          );
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      expect(child.exitCode).toBe(0);
      expect(second.windows()).toHaveLength(0);
    }
    expect(app.windows()).toHaveLength(1);
    await expect(
      page.getByRole("heading", { name: "Esami", level: 1 }),
    ).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("answers outside a plan follow the interface language", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-language-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
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
    rmSync(userData, { recursive: true, force: true });
  }
});
