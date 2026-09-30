import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeBook(dir: string): string {
  const path = join(dir, "demo.ptsb");
  writeFileSync(
    path,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "demo",
          title: "Demo",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
      ),
      "chapters/01.md": strToU8("## p1 | Energia\nIl vettore posizione descrive il punto.\n"),
      "esercizi.md": strToU8(
        ':::exercise{id="e1" chapter="1"}\nQuanto vale il lavoro?\n:::solution\nW = F s.\n:::\n:::\n',
      ),
    }),
  );
  return path;
}

async function launchFresh(extra: Record<string, string> = {}): Promise<{
  app: ElectronApplication;
  page: Page;
  userData: string;
}> {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-e2e-"));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [join(process.cwd(), "out/main/index.js")],
      env: { ...process.env, PYXIS_USER_DATA: userData, ...extra },
    });
    const page = await app.firstWindow();
    return { app, page, userData };
  } catch (error) {
    await app?.close();
    rmSync(userData, { recursive: true, force: true });
    throw error;
  }
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
  const userData = mkdtempSync(join(tmpdir(), "pyxis-e2e-"));
  const book = writeBook(userData);
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [join(process.cwd(), "out/main/index.js")],
      env: { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E_FILE: book },
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await page.getByText("Fonti", { exact: true }).click();
    await page.getByRole("button", { name: "Aggiungi fonti" }).click();
    await expect(page.getByRole("button", { name: "Demo" })).toBeVisible();
    await page.getByText("Piani", { exact: true }).click();
    await page.getByRole("button", { name: "Nuovo piano" }).click();
    await page.locator("#plan-title").fill("Fisica");
    await page.getByRole("button", { name: "Demo" }).click();
    await page.getByRole("button", { name: "Crea il piano" }).click();
    await page.getByRole("button", { name: "Apri il piano" }).click();
    await expect(page.locator("h1", { hasText: "Fisica" })).toBeVisible();
    await page.getByRole("button", { name: /Introduzione/ }).click();
    const diagnosis = page.getByRole("button", { name: /Diagnosi/ });
    await expect(diagnosis).toBeEnabled();
    await diagnosis.click();
    const study = page.getByRole("button", { name: /Studio/ });
    await expect(study).toBeEnabled();
    await study.click();
    await expect(page.getByText("vettore posizione")).toBeVisible();
    await page.getByRole("button", { name: "Ho letto" }).click();
    const practice = page.getByRole("button", { name: /Esercizi/ });
    await expect(practice).toBeEnabled();
    await practice.click();
    await expect(page.getByText("Quanto vale il lavoro?")).toBeVisible();
    await page.getByRole("button", { name: "Mostra la soluzione" }).click();
    await expect(page.getByText("W = F s.")).toBeVisible();
  } finally {
    await app?.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
