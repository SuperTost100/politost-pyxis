import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("ASK-01 subjects can be added, selected, reordered by keyboard and removed", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-subject-check-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [join(process.cwd(), "out/main/index.js")], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await page.getByText("Chiedi", { exact: true }).click();
    await page.getByRole("button", { name: /^Materia:/ }).click();
    await page.getByRole("button", { name: "Gestisci materie" }).click();
    for (const name of ["Fisica", "Analisi"]) {
      await page.getByRole("textbox", { name: "Nuova materia" }).fill(name);
      await page.getByRole("button", { name: "Aggiungi", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Nuova materia" })).toHaveValue("");
    }
    const handle = page.getByRole("button", { name: "Riordina Analisi" });
    await expect(handle).toBeEnabled();
    await handle.focus();
    await page.keyboard.press("Space");
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    // The keyboard sensor measures droppable positions on the next frame.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.keyboard.press("ArrowUp");
    await expect(page.getByText("Analisi, posizione 1 di 2.", { exact: true })).toBeAttached();
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
    await page.getByRole("button", { name: /^Materia:/ }).click();
    await page.getByRole("button", { name: "Fisica", exact: true }).click();
    await expect(page.getByRole("button", { name: "Materia: Fisica" })).toHaveText("Fisica");
  } finally { await app.close(); rmSync(userData, { recursive: true, force: true }); }
});
