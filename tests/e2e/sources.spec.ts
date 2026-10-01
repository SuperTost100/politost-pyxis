import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { manyPagePdf } from "../../src/core/sources/documents";

test("M4 chapter drawer, highlight and responsive 600-page import", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-source-check-"));
  const file = join(userData, "source.ptsb");
  writeFileSync(file, zipSync({
    "smartbook.json": strToU8(JSON.stringify({ id: "physics", title: "Fisica", access: "public", chapters: [
      { id: "c1", number: 1, title: "Moti", file: "01.md" },
      { id: "c2", number: 2, title: "Energia", file: "02.md" },
    ] })),
    "chapters/01.md": strToU8("## p1 | Velocità\nLa velocità descrive lo spostamento nel tempo.\n"),
    "chapters/02.md": strToU8("## p1 | Lavoro\nIl lavoro è il prodotto di forza e spostamento.\n\n## p2 | Energia\nL'energia cinetica vale $E = m v^2 / 2$.\n"),
  }));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1", PYXIS_E2E_FILE: file };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [join(process.cwd(), "out/main/index.js")], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await page.getByText("Fonti", { exact: true }).click();
    await page.getByRole("button", { name: "Aggiungi fonti" }).click();
    await expect(page.getByRole("button", { name: "Fisica", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Fisica", exact: true }).click();
    await page.getByRole("textbox", { name: "Cerca nei brani" }).fill("energia cinetica");
    await page.getByRole("button", { name: "Cerca", exact: true }).click();
    const hit = page.getByRole("button", { name: /2\. Energia.*energia cinetica/i }).first();
    await hit.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText(/Il lavoro è il prodotto di forza e spostamento/)).toBeVisible();
    await expect(drawer.locator(".is-current")).toContainText("energia cinetica");
    mkdirSync(".shots", { recursive: true });
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
      for (const width of [1280, 960]) {
        await page.setViewportSize({ width, height: width === 960 ? 640 : 832 });
        await expect(drawer).toBeVisible();
        await page.waitForTimeout(250);
        await page.screenshot({ path: `.shots/m4-viewer-it-${theme}-${width}.png`, animations: "disabled" });
        const results = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
        expect(results.violations).toEqual([]);
      }
    }
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await expect(hit).toBeFocused();
    const pdf = join(userData, "long.pdf");
    writeFileSync(pdf, manyPagePdf(600, "Energy E = m v 2 and conservation of momentum"));
    const imported = await page.evaluate((path) => window.pyxis.invoke("sources.import", { path }), pdf) as { sourceId: string };
    // IPC remains available while pdfjs reads hundreds of pages in a worker.
    const start = Date.now();
    const sources = await page.evaluate(() => window.pyxis.invoke("sources.list", {})) as Array<{ id: string; status: string }>;
    expect(Date.now() - start).toBeLessThan(1000);
    expect(sources.some((source) => source.id === imported.sourceId)).toBe(true);
    await expect.poll(async () => {
      const rows = await page.evaluate(() => window.pyxis.invoke("sources.list", {})) as Array<{ id: string; status: string }>;
      return rows.find((source) => source.id === imported.sourceId)?.status;
    }, { timeout: 30000 }).toBe("ready");
    await page.getByRole("textbox", { name: "Cerca nei brani" }).fill("Energy");
    await page.getByRole("button", { name: "Cerca", exact: true }).click();
    await page.getByRole("button", { name: /p\. \d+ Energy/ }).first().click();
    await expect(page.locator(".source-pdf-text .is-cited").first()).toBeVisible();
    const result = await page.evaluate(() => window.pyxis.invoke("sources.search", { query: "Energy" })) as Array<{ id: string; text: string }>;
    const snapshot = await page.evaluate((passageId) => window.pyxis.invoke("sources.viewerDocument", { passageId }), result[0]!.id) as { excerpt: string };
    expect(snapshot.excerpt).toBe(result[0]!.text);
    await page.getByRole("button", { name: "Successiva", exact: true }).click();
    await expect(page.getByText("Pagina 2 di 600", { exact: true })).toBeVisible();
    await page.screenshot({ path: ".shots/m4-pdf-it-light-960.png", animations: "disabled" });
  } finally { await app.close(); rmSync(userData, { recursive: true, force: true }); }
});

test("SRC-21 actual e5 inference indexes passages and survives app restart", async () => {
  const model = process.env.PYXIS_TEST_E5;
  test.skip(!model, "Set PYXIS_TEST_E5 to the pinned local model directory for the real inference check.");
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-e5-check-"));
  const modelDir = join(userData, "workspace", "models", "e5");
  cpSync(resolve(model!), modelDir, { recursive: true });
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: [join(process.cwd(), "out/main/index.js")], env });
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    const source = await page.evaluate(() => window.pyxis.invoke("sources.paste", {
      title: "Dinamica", text: ("La velocità è la variazione della posizione nel tempo. L'accelerazione è la variazione della velocità nel tempo.\n\n").repeat(20),
    })) as { sourceId: string };
    await expect.poll(async () => {
      const rows = await page.evaluate(() => window.pyxis.invoke("sources.list", {})) as Array<{ id: string; status: string }>;
      return rows.find((row) => row.id === source.sourceId)?.status;
    }).toBe("ready");
    const query = "How fast does an object move?";
    const before = await page.evaluate((query) => window.pyxis.invoke("sources.search", { query }), query);
    expect(before).toEqual([]);
    await page.evaluate(() => window.pyxis.invoke("sources.embed", { consent: true }));
    await expect.poll(async () => page.evaluate(() => window.pyxis.invoke("jobs.list", {})), { timeout: 60000 }).toEqual([]);
    const hits = await page.evaluate((query) => window.pyxis.invoke("sources.search", { query }), query) as Array<{ sourceId: string }>;
    expect(hits.some((hit) => hit.sourceId === source.sourceId)).toBe(true);
    await app.close();
    app = await electron.launch({ args: [join(process.cwd(), "out/main/index.js")], env });
    page = await app.firstWindow();
    const restored = await page.evaluate((query) => window.pyxis.invoke("sources.search", { query }), query) as Array<{ sourceId: string }>;
    expect(restored.some((hit) => hit.sourceId === source.sourceId)).toBe(true);
  } finally { await app.close(); rmSync(userData, { recursive: true, force: true }); }
});
