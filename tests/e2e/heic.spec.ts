import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPickedSource } from "./picked-source";

test("SRC-04 real HEIC preview runs in a worker and blank OCR is not ready", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-heic-native-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch(process.env.PYXIS_DIST_APP
    ? { executablePath: process.env.PYXIS_DIST_APP, args: ["--use-mock-keychain"], env }
    : { args: [join(process.cwd(), "out/main/index.js")], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await page.evaluate(() => window.pyxis.invoke("sources.list", {}));
    const result = await importPickedSource(page, app, join(process.cwd(), "tests/fixtures/synthetic-note.heic")) as { sourceId: string };
    const preview = await page.evaluate(async () => {
      const picked = await window.pyxis.showOpenDialog({ properties: ["openFile"] });
      try { return { result: await window.pyxis.invoke("sources.preview", { path: picked![0]! }) }; } catch (error) { return { error }; }
    });
    expect(preview.error, JSON.stringify(preview.error)).toBeUndefined();
    expect(preview.result?.duplicate).toBe(true);
    expect(preview.result?.blurry).toBe(true);
    await expect.poll(async () => {
      const rows = await page.evaluate(() => window.pyxis.invoke("sources.list", {}));
      return rows.find((row) => row.id === result.sourceId)?.status;
    }, { timeout: 90000 }).toBe("failed");
    const rows = await page.evaluate(() => window.pyxis.invoke("sources.list", {}));
    expect(rows.find((row) => row.id === result.sourceId)?.kind).toBe("image");
  } finally { await app.close(); rmSync(userData, { recursive: true, force: true }); }
});
