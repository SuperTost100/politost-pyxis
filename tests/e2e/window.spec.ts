import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function launchApp(env: Record<string, string>) {
  const shared = { env: { ...process.env, PYXIS_E2E: "1", ...env } };
  const packaged = process.env["PYXIS_DIST_APP"];
  if (packaged) {
    // ponytail: ad-hoc signing stalls the macOS Keychain, and the DevTools server then never replies. The switch is test-only. A real signing identity is the upgrade.
    return electron.launch({
      executablePath: packaged,
      args: ["--use-mock-keychain"],
      ...shared,
    });
  }
  return electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    ...shared,
  });
}

async function expectClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
  expect(results.violations).toEqual([]);
}

async function launchFresh(extra: Record<string, string> = {}): Promise<{
  app: ElectronApplication;
  page: Page;
  userData: string;
}> {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-e2e-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp({ PYXIS_USER_DATA: userData, ...extra });
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
    await expectClean(page);
    await page.getByRole("button", { name: "Salta" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("main h2")).toHaveText("Nessun piano ancora");
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a smartbook becomes a plan without a model", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-e2e-"));
  const book = writeBook(userData);
  const backupZip = join(userData, "pyxis-backup.zip");
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp({
      PYXIS_USER_DATA: userData,
      PYXIS_E2E_FILE: book,
      PYXIS_E2E_SAVE: backupZip,
      PYXIS_E2E_ZIP: backupZip,
      PYXIS_E2E_REPLY: "Il vettore descrive il punto [P1].",
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).focus();
    await page.keyboard.press("Enter");
    await page.getByText("Fonti", { exact: true }).click();
    await page.getByRole("button", { name: "Aggiungi fonti" }).click();
    await expect(page.getByRole("button", { name: "Demo" })).toBeVisible();
    await expectClean(page);
    await page.getByText("Piani", { exact: true }).click();
    await page.getByRole("button", { name: "Nuovo piano" }).click();
    await page.locator("#plan-title").fill("Fisica");
    await page.getByRole("button", { name: "Demo" }).click();
    await page.getByRole("button", { name: "Crea il piano" }).click();
    await page.getByRole("button", { name: "Apri il piano" }).click();
    await expect(page.locator("h1", { hasText: "Fisica" })).toBeVisible();
    await expectClean(page);
    await page.getByRole("button", { name: /Introduzione/ }).click();
    const diagnosis = page.getByRole("button", { name: /Diagnosi/ });
    await expect(diagnosis).toBeEnabled();
    await diagnosis.click();
    await page.getByRole("button", { name: "Inizia" }).click();
    await page.getByRole("textbox", { name: "Correggi" }).fill("W = F s.");
    await page.getByRole("button", { name: "Correggi" }).click();
    await expect(page.getByText("100 su 100")).toBeVisible();
    await page.getByRole("button", { name: "Indietro" }).click();
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
    await page.getByRole("button", { name: "Quiz dal libro" }).click();
    await page.getByRole("button", { name: "Inizia" }).click();
    await page.getByRole("textbox", { name: "Correggi" }).fill("W = F s.");
    await page.getByRole("button", { name: "Correggi" }).click();
    await expect(page.getByText("100 su 100")).toBeVisible();
    await expectClean(page);
    await page.getByRole("button", { name: "Indietro" }).click();
    await page.getByRole("button", { name: /Esercizi/ }).click();
    await page.getByRole("button", { name: "Ho letto" }).click();
    const cards = page.getByRole("button", { name: /Carte/ });
    await expect(cards).toBeEnabled();
    await cards.click();
    await expect(page.getByText("1. Moti · 1")).toBeVisible();
    await page.getByRole("button", { name: "Gira" }).click();
    await page.getByRole("button", { name: "Bene" }).click();
    await page.getByRole("button", { name: "Indietro" }).click();
    await page.getByRole("button", { name: /Carte/ }).click();
    await expect(page.getByText("Quanto vale il lavoro?")).toBeVisible();
    await expect(page.getByText("1. Moti · 1")).toHaveCount(0);
    await page.getByRole("button", { name: "Indietro" }).click();
    await expect(page.getByRole("heading", { name: "Progressi" })).toBeVisible();
    const dest = join(userData, "Fisica.pyxis.json");
    expect(
      await app.evaluate(({ BrowserWindow }, file) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) throw new Error("no-window");
        const pending = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no-download")), 8000);
          win.webContents.session.once("will-download", (_event, item) => {
            item.setSavePath(file);
            item.once("done", (_done, state) => {
              clearTimeout(timer);
              if (state === "completed") resolve(item.getFilename());
              else reject(new Error(String(state)));
            });
          });
        });
        pending.catch(() => undefined);
        (globalThis as { pyxisDownload?: Promise<unknown> }).pyxisDownload = pending;
        return "listening";
      }, dest),
    ).toBe("listening");
    await page.getByRole("button", { name: "Esporta" }).click();
    expect(
      await app.evaluate(
        () => (globalThis as { pyxisDownload: Promise<string> }).pyxisDownload,
      ),
    ).toBe("Fisica.pyxis.json");
    const file = JSON.parse(readFileSync(dest, "utf8")) as {
      title: string;
      topics: Array<{ title: string }>;
    };
    expect(file.title).toBe("Fisica");
    expect(file.topics.some((topic) => topic.title.includes("Moti"))).toBe(true);
    await page.getByRole("button", { name: /Carte/ }).click();
    await page.getByRole("button", { name: "Ho letto" }).click();
    const gaps = page.getByRole("button", { name: /Lacune/ });
    await expect(gaps).toBeEnabled();
    await gaps.click();
    const simulation = page.getByRole("button", { name: /Simulazione/ });
    await expect(simulation).toBeEnabled();
    await simulation.click();
    await page.getByRole("button", { name: "Inizia i 30 minuti" }).click();
    await page.getByRole("textbox", { name: "Correggi" }).fill("W = F s.");
    await page.getByRole("button", { name: "Correggi" }).click();
    await expect(page.getByText("1. Moti · 100")).toBeVisible();
    await expectClean(page);
    await page.getByRole("button", { name: "Indietro" }).click();
    await page.getByRole("button", { name: "Indietro" }).click();
    await page.getByRole("button", { name: "Impostazioni" }).click();
    await page.getByRole("button", { name: "Copia di sicurezza" }).click();
    await expect(page.getByText("La copia è pronta.")).toBeVisible();
    await expectClean(page);
    expect(existsSync(backupZip) && statSync(backupZip).size > 0).toBe(true);
    await expect(page.getByText("La copia non è riuscita.")).toHaveCount(0);
    await page.getByText("Esami", { exact: true }).click();
    await page.getByRole("button", { name: "Fisica" }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Elimina il piano" }).click();
    await expect(page.locator("main h2")).toHaveText("Nessun piano ancora");
    await page.getByRole("button", { name: "Impostazioni" }).click();
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Ripristina" }).click(),
    ]);
    await page.getByText("Esami", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Fisica" })).toBeVisible();
    await page.getByText("Chiedi", { exact: true }).click();
    await page.getByRole("button", { name: "Demo" }).click();
    await page.getByRole("textbox", { name: "Messaggio" }).fill("Che cos'è il vettore?");
    await page.getByRole("button", { name: "Invia" }).click();
    await expect(page.getByText("Il vettore descrive il punto")).toBeVisible();
    await expectClean(page);
    await page.getByRole("button", { name: "1. Moti" }).click();
    await expect(page.getByText("Il vettore posizione descrive il punto.")).toBeVisible();
  } finally {
    await app?.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
