import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis, setUp } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { clickSettled } from "./settled";

/*
 * Taking a file off while it is still being read stops the reading and removes what it made. The local job queue is held
 * at zero (a test seam), so the file stays in the queue, reading, for as long as the spec looks at it.
 */
test("removing a file while it is read stops the reading and leaves nothing of it", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-remove-"));
  const dir = mkdtempSync(join(tmpdir(), "pyxis-chat-remove-files-"));
  const note = join(dir, "appunti.txt");
  writeFileSync(note, "Il calore si trasmette per conduzione.");
  const app = await launchPyxis({
    userData,
    env: { PYXIS_E2E_LOCAL_JOBS: "0", PYXIS_E2E_REPLY: "Ecco la risposta.", PYXIS_E2E_FILE: note },
  });
  try {
    const page = await setUp(app, userData, async () => {
      const window = await app.firstWindow();
      await window.getByRole("button", { name: "Salta" }).click();
      await fromChiediToExams(window);
      return window;
    });
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.getByRole("button", { name: "Aggiungi un file o una formula" }).click();
    await clickSettled(page, page.getByRole("menuitem", { name: "Allega file o immagine" }));
    const chip = page.locator(".ask-attachments li").filter({ hasText: "appunti.txt" });
    await expect(chip).toContainText("Lettura in corso…");
    const db = () => new DatabaseSync(join(userData, "workspace", "pyxis.db"), { readOnly: true, timeout: 10000 });
    const count = (sql: string) => {
      const handle = db();
      try {
        return Number(Object.values(handle.prepare(sql).get() as Record<string, unknown>)[0]);
      } finally {
        handle.close();
      }
    };
    // The file is stored and its import waits in the queue.
    expect(count("SELECT COUNT(*) FROM sources")).toBe(1);
    // The jobs list does not show the reading: only the chip does.
    expect(await page.evaluate(() => window.pyxis.invoke("jobs.list", {}))).toEqual([]);

    await chip.getByRole("button", { name: "Rimuovi appunti.txt" }).click();
    await expect(chip).toHaveCount(0);
    await expect.poll(() => count("SELECT COUNT(*) FROM sources")).toBe(0);
    await expect.poll(() => count("SELECT COUNT(*) FROM jobs WHERE state = 'cancelled'")).toBe(1);
    expect(count("SELECT COUNT(*) FROM passages")).toBe(0);
    // Coming back finds no file waiting, and no banner.
    await page.reload();
    await expect(page.locator(".ask-attachments")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});
