import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("ASK-01 subjects are managed from the Exams home: add, rename, reorder by keyboard, remove", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-subject-check-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [join(process.cwd(), "out/main/index.js")], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping setup navigates to Exams on its own; wait for it so it cannot override the next route.
    await expect(page).toHaveURL(/#\/exams$/);
    // Settings no longer lists subjects, and the old address lands on the Exams home.
    await page.evaluate(() => { window.location.hash = "#/settings"; });
    await expect(page.getByRole("heading", { name: "Impostazioni" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Materia/ })).toHaveCount(0);
    await page.evaluate(() => { window.location.hash = "#/settings/subjects"; });
    await expect(page).toHaveURL(/#\/exams$/);
    await page.getByRole("button", { name: "Gestisci materie" }).click();
    for (const name of ["Fisica", "Analisi"]) {
      await page.getByRole("textbox", { name: "Nuova materia" }).fill(name);
      await page.getByRole("button", { name: "Aggiungi", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Nuova materia" })).toHaveValue("");
    }
    // Renaming keeps the row and refuses a name already in use.
    await page.getByRole("button", { name: "Rinomina Analisi" }).click();
    await page.getByRole("textbox", { name: "Nome della materia" }).fill("fisica");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Esiste già una materia con questo nome.")).toBeVisible();
    await page.getByRole("textbox", { name: "Nome della materia" }).fill("Analisi 1");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Riordina Analisi 1" })).toBeVisible();
    await page.getByRole("button", { name: "Rinomina Analisi 1" }).click();
    await page.getByRole("textbox", { name: "Nome della materia" }).fill("Analisi");
    await page.getByRole("button", { name: "Salva", exact: true }).click();
    // Exact: "Riordina Analisi 1" also matches the plain name until the rename has landed.
    const handle = page.getByRole("button", { name: "Riordina Analisi", exact: true });
    await expect(handle).toBeEnabled();
    await handle.focus();
    await page.keyboard.press("Space");
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    // The keyboard sensor measures droppable positions on the next frame.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    // The sensor listens for keys a tick after the press; on a slow runner the first arrow can come too early.
    // Another arrow at the top leaves the row where it is, so it is safe to repeat.
    await expect(async () => {
      await page.keyboard.press("ArrowUp");
      await expect(page.getByText("Analisi, posizione 1 di 2.", { exact: true })).toBeAttached({ timeout: 1000 });
    }).toPass({ timeout: 15000 });
    await page.keyboard.press("Space");
    await expect.poll(async () => (await page.evaluate(() => window.pyxis.invoke("subjects.list", {})) as Array<{ name: string }>).map((row) => row.name)).toEqual(["Analisi", "Fisica"]);
    mkdirSync(".shots", { recursive: true });
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
      for (const width of [1280, 960]) {
        await page.setViewportSize({ width, height: width === 960 ? 640 : 832 });
        await page.screenshot({ path: `.shots/m5-subjects-it-${theme}-${width}.png`, animations: "disabled" });
      }
    }
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Rimuovi Analisi", exact: true }).click();
    await page.getByRole("button", { name: "Rimuovi", exact: true }).last().click();
    await expect(page.getByRole("button", { name: "Riordina Analisi" })).not.toBeVisible();
    await expect.poll(async () => (await page.evaluate(() => window.pyxis.invoke("subjects.list", {})) as Array<{ name: string }>).map((row) => row.name)).toEqual(["Fisica"]);
    await page.keyboard.press("Escape");
    await page.getByText("Chiedi", { exact: true }).click();
    await page.getByRole("button", { name: /^Materia:/ }).click();
    await page.getByRole("button", { name: "Fisica", exact: true }).click();
    await expect(page.getByRole("button", { name: "Materia: Fisica" })).toHaveText("Fisica");
  } finally { await app.close(); rmSync(userData, { recursive: true, force: true }); }
});
