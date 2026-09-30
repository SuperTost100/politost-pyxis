import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const book = "/Users/tost1/Documents/Personal/Vibecode/PoliTost/books/ptt-fisica1.ptsb";

async function launchFresh(extra: Record<string, string> = {}): Promise<{
  app: ElectronApplication;
  page: Page;
  userData: string;
}> {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-e2e-"));
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env: { ...process.env, PYXIS_USER_DATA: userData, ...extra },
  });
  const page = await app.firstWindow();
  return { app, page, userData };
}

test("a fresh window opens on onboarding", async () => {
  const { app, page, userData } = await launchFresh();
  try {
    await expect(page.locator("main h1")).toHaveText("Iniziamo");
    await expect(page.locator("header h1:visible")).toHaveCount(0);
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page.locator("main h2")).toHaveText("Nessun piano ancora");
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a smartbook becomes a plan without a model", async () => {
  test.skip(!existsSync(book), "ptt-fisica1.ptsb is not on this machine");
  const { app, page, userData } = await launchFresh({ PYXIS_E2E_FILE: book });
  try {
    await page.getByRole("button", { name: "Salta" }).click();
    await page.getByText("Fonti", { exact: true }).click();
    await page.getByRole("button", { name: "Aggiungi fonti" }).click();
    await expect(page.getByRole("button", { name: "POLITO: Fisica 1" })).toBeVisible();
    await page.getByText("Piani", { exact: true }).click();
    await page.getByRole("button", { name: "Nuovo piano" }).click();
    await page.locator("#plan-title").fill("Fisica");
    await page.getByRole("button", { name: "POLITO: Fisica 1" }).click();
    await page.getByRole("button", { name: "Crea il piano" }).click();
    await page.getByRole("button", { name: "Apri il piano" }).click();
    await expect(page.locator("h1", { hasText: "Fisica" })).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
