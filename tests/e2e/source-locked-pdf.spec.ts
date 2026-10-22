import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lockedPdf } from "../../src/core/sources/test-pdf";
import { importPickedSource } from "./picked-source";
import { launchPyxis } from "./app-under-test";

const PASSWORD = "Carnot-1824";

function database(userData: string, readOnly = true) {
  return new DatabaseSync(join(userData, "workspace", "pyxis.db"), { readOnly, timeout: 10000 });
}

/** Every value in every ordinary table, so the test can check that a password was never written. */
function everything(userData: string): string {
  const db = database(userData);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'").all() as Array<{ name: string }>;
    return tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join("\n");
  } finally {
    db.close();
  }
}

/** Both themes at the desktop width, and the dark one narrow, saved for review in `.shots/`. */
async function shoot(page: Page, name: string) {
  mkdirSync(".shots", { recursive: true });
  for (const [theme, width] of [
    ["light", 1280],
    ["dark", 1280],
    ["dark", 600],
  ] as const) {
    await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `.shots/${name}-it-${theme}-${width}.png`, animations: "disabled" });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

test("SRC a locked PDF asks for its password, and a link source offers a check for a new version", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-locked-pdf-"));
  const pdf = join(userData, "Dispense.pdf");
  writeFileSync(pdf, lockedPdf("Il rendimento di una macchina termica", PASSWORD));
  const notes = join(userData, "Appunti.txt");
  writeFileSync(notes, "Il primo principio della termodinamica lega calore, lavoro ed energia interna.\n");
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    const list = () =>
      page.evaluate(() => window.pyxis.invoke("sources.list", {})) as Promise<
        Array<{ id: string; status: string; error?: string }>
      >;
    const { sourceId } = (await importPickedSource(page, app, pdf)) as { sourceId: string };
    await expect.poll(async () => (await list()).find((row) => row.id === sourceId)?.error).toBe("pdf-password-required");

    await page.evaluate(() => {
      window.location.hash = "/exams/library";
    });
    await expect(page.getByText("Questo PDF è protetto da password. Inseriscila per leggere il file.")).toBeVisible();
    const enter = page.getByRole("button", { name: "Inserisci la password di Dispense" });
    // The background tasks offer the same answer instead of a Retry that would stop the same way.
    await page.getByRole("button", { name: /attività/i }).first().click();
    await expect(page.getByRole("region", { name: /attività/i }).getByRole("button", { name: "Inserisci la password di Dispense" })).toBeVisible();
    await expect(page.getByRole("region", { name: /attività/i }).getByRole("button", { name: "Riprova" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // A wrong password stops the import again and says so.
    await enter.first().click();
    const dialog = page.getByRole("dialog", { name: "Apri un PDF protetto" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Password di Dispense").fill("sbagliata");
    await shoot(page, "pdf-password-dialog");
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
    await dialog.getByRole("button", { name: "Apri" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Questa password non apre il PDF. Riprova.")).toBeVisible();

    // The right one reads it. Enter in the field submits.
    await enter.first().click();
    await dialog.getByLabel("Password di Dispense").fill(PASSWORD);
    await dialog.getByLabel("Password di Dispense").press("Enter");
    await expect.poll(async () => (await list()).find((row) => row.id === sourceId)?.status).toBe("ready");
    const stored = everything(userData);
    expect(stored).toContain("Il rendimento di una macchina termica");
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain("sbagliata");

    // A source saved from a link. The address cannot resolve, so the check fails by name and nothing changes.
    const link = (await importPickedSource(page, app, notes)) as { sourceId: string };
    await expect.poll(async () => (await list()).find((row) => row.id === link.sourceId)?.status).toBe("ready");
    const seed = database(userData, false);
    seed
      .prepare("UPDATE sources SET kind = 'link', origin_url = 'https://appunti.invalid/fisica', fetched_at = ? WHERE id = ?")
      .run(Date.UTC(2026, 9, 1), link.sourceId);
    seed.close();
    // The Library read the list before the seed. Two quick route changes can leave it mounted with that copy, so the
    // window is reloaded, and the row's type must say Link before its menu is opened.
    await page.reload();
    await page.evaluate(() => {
      window.location.hash = "/exams/library";
    });
    await expect(page.getByRole("listitem").filter({ hasText: "Appunti" }).filter({ hasText: "Link" })).toBeVisible();
    await page.getByRole("button", { name: "Azioni per Dispense" }).click();
    await expect(page.getByRole("menuitem", { name: "Controlla se c'è una nuova versione" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Azioni per Appunti" }).click();
    await expect(page.getByRole("menuitem", { name: "Controlla se c'è una nuova versione" })).toBeVisible();
    await shoot(page, "source-refresh-menu");
    await page.getByRole("menuitem", { name: "Controlla se c'è una nuova versione" }).click();
    // A lookup failure is not yet named as a link failure (see #125), so either message counts as the refusal.
    await expect(page.getByRole("alert").getByText(/^Non riesco a leggere (quel link|questo file)\.$/)).toBeVisible({ timeout: 30000 });
    expect(await page.evaluate(() => window.pyxis.invoke("jobs.list", {}))).toEqual([]);

    await page.getByRole("button", { name: "Appunti", exact: true }).click();
    const details = page.locator(".px-library-details");
    await expect(details.getByText(/Salvata da appunti\.invalid il/)).toBeVisible();
    await expect(details.getByRole("button", { name: "Controlla se c'è una nuova versione" })).toBeVisible();
    await shoot(page, "source-refresh-details");
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
