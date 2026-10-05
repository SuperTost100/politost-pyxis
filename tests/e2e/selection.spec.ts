import { _electron as electron, expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { importPickedSource } from "./picked-source";

test("selected source text opens a scoped tutor context and Escape dismisses its actions", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-selection-"));
  const file = join(userData, "notes.ptsb");
  const excerpt = "La forza è il prodotto di massa e accelerazione.";
  writeFileSync(file, zipSync({
    "smartbook.json": strToU8(JSON.stringify({ id: "sel", title: "Fisica", access: "public", chapters: [{ id: "c1", number: 1, title: "Forze", file: "01.md" }] })),
    "chapters/01.md": strToU8(`## p1 | Forza\n${excerpt}\n`),
  }));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [join(process.cwd(), "out/main/index.js")], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    const { sourceId } = await importPickedSource(page, app, file) as { sourceId: string };
    await expect.poll(async () => (await page.evaluate(() => window.pyxis.invoke("sources.list", {})) as Array<{ id: string; status: string }>).find((row) => row.id === sourceId)?.status).toBe("ready");
    await page.evaluate((sourceId) => window.dispatchEvent(new CustomEvent("pyxis:source-viewer", { detail: { sourceId, chapter: 1 } })), sourceId);
    const paragraph = page.locator(".source-viewer-paragraph p");
    await expect(paragraph).toHaveText(excerpt);
    const select = () => paragraph.evaluate((node) => {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await select();
    const menu = page.getByRole("group", { name: "Chiedi al tutor" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await select();
    await expect(menu).toBeVisible();
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
    await page.screenshot({ path: ".shots/selection-menu-it.png" });
    await menu.getByRole("button", { name: "Chiedi al tutor" }).click();
    await expect(page).toHaveURL(/#\/ask\//);
    const scope = await page.evaluate(() => window.pyxis.invoke("chats.read", { chatId: window.location.hash.split("/").at(-1)! })) as { sourceIds: string[]; context: { body: string } };
    expect(scope.sourceIds).toEqual([sourceId]);
    expect(scope.context.body).toBe(excerpt);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
