import { _electron as electron, expect, test } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OCR_DATA_FILES, ocrDataDir } from "../../src/core/sources/ocr-data";
import { importPickedSource } from "./picked-source";

/** The pinned files the runtime task downloaded once, when they are on this machine and match their pins. */
function stagedTessdata(): string | null {
  const dir = process.env.PYXIS_TESSDATA_DIR ?? join(process.cwd(), ".tmp", "tessdata-fast");
  const ok = Object.entries(OCR_DATA_FILES).every(([lang, pinned]) => {
    const file = join(dir, `${lang}.traineddata`);
    if (!existsSync(file)) return false;
    const bytes = readFileSync(file);
    return bytes.length === pinned.size && createHash("sha256").update(bytes).digest("hex") === pinned.sha256;
  });
  return ok ? dir : null;
}

test("SRC-04 real HEIC preview runs in a worker and blank OCR is not ready", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-heic-native-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch(process.env.PYXIS_DIST_APP
    ? { executablePath: process.env.PYXIS_DIST_APP, args: ["--use-mock-keychain"], env }
    : { args: [join(process.cwd(), process.env.PYXIS_OUT ?? "out", "main/index.js")], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await page.evaluate(() => window.pyxis.invoke("sources.list", {}));
    // No OCR data yet: the import is refused up front, with the key the consent card listens for, and nothing is stored.
    await app.evaluate(({ dialog }, selected) => {
      delete process.env.PYXIS_E2E_FILE;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, join(process.cwd(), "tests/fixtures/synthetic-note.heic"));
    const refused = await page.evaluate(async () => {
      const picked = await window.pyxis.showOpenDialog({ properties: ["openFile"] });
      try { return await window.pyxis.invoke("sources.import", { path: picked![0]! }); } catch (error) { return { refused: error }; }
    });
    expect(refused).toMatchObject({ refused: { messageKey: "sources.ocrDataMissing" } });
    expect(await page.evaluate(() => window.pyxis.invoke("sources.list", {}))).toHaveLength(0);
    // Then the data arrives the way a student would get it: staged from the pinned public files when this machine has
    // them, otherwise through the app's own consented download. Either way the real decoder and OCR worker run below.
    const staged = stagedTessdata();
    if (staged) {
      const dir = ocrDataDir(join(userData, "workspace", "runtimes", "tesseract"));
      mkdirSync(dir, { recursive: true });
      for (const lang of Object.keys(OCR_DATA_FILES)) copyFileSync(join(staged, `${lang}.traineddata`), join(dir, `${lang}.traineddata`));
    } else {
      await page.evaluate(() => window.pyxis.invoke("sources.ocrData", { consent: true }));
      await expect
        .poll(async () => (await page.evaluate(() => window.pyxis.invoke("sources.ocrDataState", {}))).state, { timeout: 120000 })
        .toBe("ready");
    }
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
