import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importPickedSource } from "./picked-source";
import {
  drawScanPages,
  installTessdata,
  SCAN_PAGES,
  stagedTessdata,
  writeScanPdf,
} from "./scanned-pdf-fixture";

/*
 * A generated two-page image-only PDF goes through the real path: the renderer's pdf.js draws each page on a canvas, sends
 * the PNG with sources.ocrImage, and core's worker reads it with the pinned Tesseract files. Nothing is mocked in the IPC,
 * and no network or model is called. Failures are made in the page itself (the canvas export), in core's worker (a bad
 * PNG) and by reloading the window, and each must leave the scan startable with its finished pages kept.
 */

const MAIN = join(
  process.cwd(),
  process.env.PYXIS_OUT ?? "out",
  "main/index.js",
);
const scanButton = (page: Page) =>
  page.getByRole("button", { name: /^(Leggi la scansione|Read the scan)$/ });
const staged = stagedTessdata();

type Run = {
  app: ElectronApplication;
  page: Page;
  userData: string;
  sourceId: string;
  pngs: Buffer[];
};

/** Launches a fresh workspace and imports the generated scanned PDF through the native picker. */
async function openScan(): Promise<Run> {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-scanned-pdf-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
  const pngs = await drawScanPages(page);
  const pdf = join(userData, "scan.pdf");
  writeScanPdf(pdf, pngs);
  const { sourceId } = (await importPickedSource(page, app, pdf)) as {
    sourceId: string;
  };
  const run = { app, page, userData, sourceId, pngs };
  // The import extracts in the background; an image-only PDF has no text layer, so it ends as needs-ocr.
  await expect.poll(() => status(run), { timeout: 60000 }).toBe("needs-ocr");
  await page.evaluate(() => {
    location.hash = "/exams/library";
  });
  await page.reload();
  await expect(page.locator("h1:visible").first()).toBeVisible();
  return run;
}

async function close(run: Run) {
  await run.app.close();
  rmSync(run.userData, { recursive: true, force: true });
}

const status = async ({ page, sourceId }: Pick<Run, "page" | "sourceId">) =>
  (await page.evaluate(() => window.pyxis.invoke("sources.list", {}))).find(
    (row) => row.id === sourceId,
  )?.status;

function passages({
  userData,
  sourceId,
}: Run): { page: number; text: string }[] {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
    readOnly: true,
  });
  try {
    return db
      .prepare(
        "SELECT json_extract(locator_json, '$.page') AS page, text FROM passages WHERE source_id = ? ORDER BY page",
      )
      .all(sourceId) as { page: number; text: string }[];
  } finally {
    db.close();
  }
}

/** Both pages are stored exactly once, each with its own words. */
function expectBothPagesOnce(run: Run) {
  const rows = passages(run);
  expect(rows.map((row) => row.page)).toEqual([1, 2]);
  SCAN_PAGES.forEach(([, word], index) => {
    expect(rows[index]!.text.toUpperCase()).toContain(word);
    expect(rows[1 - index]!.text.toUpperCase()).not.toContain(word);
  });
}

/** Makes the canvas export of page 2 fail or hang, the way a renderer that cannot finish a page does. */
const breakSecondPage = (page: Page, how: "fail" | "hang") =>
  page.evaluate((mode) => {
    const original = HTMLCanvasElement.prototype.toBlob;
    let calls = 0;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
      calls += 1;
      if (calls !== 2) return original.call(this, callback, ...rest);
      if (mode === "fail") callback(null);
    };
  }, how);

test("a scanned PDF without OCR data is refused with the consent card, stays startable, and stores nothing", async () => {
  test.setTimeout(120000);
  const run = await openScan();
  try {
    expect(await status(run)).toBe("needs-ocr");
    await scanButton(run.page).click();
    await expect(run.page.locator(".px-ocr")).toBeVisible();
    await expect(
      run.page.getByRole("button", { name: /^Scarica [\d.,]+ MB$/ }),
    ).toBeVisible();
    // The refusal is the first page's, so core stopped the scan and the row never stays on "OCR queued".
    await expect.poll(() => status(run)).toBe("needs-ocr");
    await expect(scanButton(run.page).first()).toBeVisible();
    expect(passages(run)).toEqual([]);
  } finally {
    await close(run);
  }
});

test("a scan with no stored file offers Replace, not a read that cannot run, and core refuses it before queuing", async () => {
  test.setTimeout(120000);
  const run = await openScan();
  try {
    const db = new DatabaseSync(join(run.userData, "workspace", "pyxis.db"));
    try {
      db.prepare("UPDATE sources SET blob_sha = NULL WHERE id = ?").run(
        run.sourceId,
      );
    } finally {
      db.close();
    }
    await run.page.reload();
    await expect(
      run.page.getByText(
        /non ha più il file da leggere|no longer has the file to read/,
      ),
    ).toBeVisible();
    await expect(scanButton(run.page)).toHaveCount(0);
    await expect(
      run.page
        .getByRole("button", { name: /^(Sostituisci il file|Replace file)$/ })
        .first(),
    ).toBeVisible();
    const refusal = await run.page.evaluate(
      (sourceId) =>
        window.pyxis.invoke("sources.ocr", { sourceId }).then(
          () => "queued",
          (error: { messageKey?: string }) => error.messageKey ?? "error",
        ),
      run.sourceId,
    );
    expect(refusal).toBe("sources.fileMissing");
    expect(await status(run)).toBe("needs-ocr");
  } finally {
    await close(run);
  }
});

test.describe("with the pinned OCR data", () => {
  test.skip(
    !staged,
    "the pinned tessdata (.tmp/tessdata-fast, hash-checked) is not on this machine and no test downloads it",
  );

  test("pdf.js renders both pages, core reads them in order, and the source becomes ready after a refusal", async () => {
    test.setTimeout(240000);
    const run = await openScan();
    try {
      // Refused first, then the data is installed the way the consented download would leave it, and the student presses Read again.
      await scanButton(run.page).click();
      await expect(run.page.locator(".px-ocr")).toBeVisible();
      await expect.poll(() => status(run)).toBe("needs-ocr");
      installTessdata(run.userData, staged!);
      await scanButton(run.page).first().click();
      await expect.poll(() => status(run), { timeout: 180000 }).toBe("ready");
      expectBothPagesOnce(run);
      await expect(scanButton(run.page)).toHaveCount(0);
    } finally {
      await close(run);
    }
  });

  test("a page that cannot be rendered stops the scan with page 1 kept, and Read again adds page 2 only", async () => {
    test.setTimeout(240000);
    const run = await openScan();
    try {
      installTessdata(run.userData, staged!);
      await breakSecondPage(run.page, "fail");
      await scanButton(run.page).click();
      await expect(scanButton(run.page).first()).toBeVisible({
        timeout: 120000,
      });
      await expect.poll(() => status(run)).toBe("needs-ocr");
      expect(passages(run).map((row) => row.page)).toEqual([1]);
      const first = passages(run)[0]!;
      // No reload: the row has to show needs-ocr again by itself, not the stale "OCR queued".
      await scanButton(run.page).first().click();
      await expect.poll(() => status(run), { timeout: 180000 }).toBe("ready");
      expectBothPagesOnce(run);
      expect(passages(run)[0]).toEqual(first);
    } finally {
      await close(run);
    }
  });

  /** Page 2 takes five seconds to export, a window in which the student can cancel or leave. */
  const slowSecondPage = (page: Page) =>
    page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.toBlob;
      let calls = 0;
      HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
        calls += 1;
        if (calls !== 2) return original.call(this, callback, ...rest);
        setTimeout(() => original.call(this, callback, ...rest), 5000);
      };
    });

  test("Cancel stops a running scan between pages with page 1 kept, and Read again finishes it", async () => {
    test.setTimeout(240000);
    const run = await openScan();
    try {
      installTessdata(run.userData, staged!);
      await slowSecondPage(run.page);
      await scanButton(run.page).click();
      await expect
        .poll(() => passages(run).map((row) => row.page), { timeout: 120000 })
        .toEqual([1]);
      const cancel = run.page.getByRole("button", {
        name: /^(Annulla la lettura|Cancel the scan)$/,
      });
      await cancel.click();
      await expect(scanButton(run.page).first()).toBeVisible({
        timeout: 30000,
      });
      await expect.poll(() => status(run)).toBe("needs-ocr");
      // Page 2 was never sent, and a stopped scan shows no error.
      expect(passages(run).map((row) => row.page)).toEqual([1]);
      await expect(run.page.getByRole("alert")).toHaveCount(0);
      await scanButton(run.page).first().click();
      await expect.poll(() => status(run), { timeout: 180000 }).toBe("ready");
      expectBothPagesOnce(run);
      await expect(scanButton(run.page)).toHaveCount(0);
      await expect(cancel).toHaveCount(0);
    } finally {
      await close(run);
    }
  });

  test("leaving the Library mid-scan stops it with page 1 kept", async () => {
    test.setTimeout(240000);
    const run = await openScan();
    try {
      installTessdata(run.userData, staged!);
      await slowSecondPage(run.page);
      await scanButton(run.page).click();
      await expect
        .poll(() => passages(run).map((row) => row.page), { timeout: 120000 })
        .toEqual([1]);
      expect(await status(run)).toBe("ocr-queued");
      await run.page.evaluate(() => {
        location.hash = "/exams";
      });
      await expect
        .poll(() => status(run), { timeout: 30000 })
        .toBe("needs-ocr");
      expect(passages(run).map((row) => row.page)).toEqual([1]);
      await run.page.evaluate(() => {
        location.hash = "/exams/library";
      });
      await scanButton(run.page).first().click();
      await expect.poll(() => status(run), { timeout: 180000 }).toBe("ready");
      expectBothPagesOnce(run);
    } finally {
      await close(run);
    }
  });

  test("a window reloaded between pages returns the scan to needs-ocr, and Read again does not duplicate page 1", async () => {
    test.setTimeout(240000);
    const run = await openScan();
    try {
      installTessdata(run.userData, staged!);
      await breakSecondPage(run.page, "hang");
      await scanButton(run.page).click();
      await expect
        .poll(() => passages(run).map((row) => row.page), { timeout: 120000 })
        .toEqual([1]);
      expect(await status(run)).toBe("ocr-queued");
      await run.page.reload();
      await expect
        .poll(() => status(run), { timeout: 30000 })
        .toBe("needs-ocr");
      expect(passages(run).map((row) => row.page)).toEqual([1]);
      await expect(scanButton(run.page).first()).toBeVisible();
      await scanButton(run.page).first().click();
      await expect.poll(() => status(run), { timeout: 180000 }).toBe("ready");
      expectBothPagesOnce(run);
    } finally {
      await close(run);
    }
  });

  test("a page core's worker cannot read stops the scan with page 1 kept, and the real render finishes it", async () => {
    test.setTimeout(240000);
    const run = await openScan();
    try {
      installTessdata(run.userData, staged!);
      const send = (pageNumber: number, bytes: Buffer, last: boolean) =>
        run.page.evaluate(
          ([sourceId, base64, number, end]) =>
            window.pyxis
              .invoke("sources.ocrImage", {
                sourceId: sourceId as string,
                pngBase64: base64 as string,
                page: number as number,
                last: end as boolean,
              })
              .then(
                () => "ok",
                (error: { messageKey?: string }) => error.messageKey ?? "error",
              ),
          [run.sourceId, bytes.toString("base64"), pageNumber, last] as const,
        );
      expect(await send(1, run.pngs[0]!, false)).toBe("ok");
      // A PNG signature followed by a cut-off body passes core's format check and fails inside the worker's decode.
      expect(await send(2, run.pngs[1]!.subarray(0, 200), true)).not.toBe("ok");
      expect(await status(run)).toBe("needs-ocr");
      expect(passages(run).map((row) => row.page)).toEqual([1]);
      await run.page.reload();
      await scanButton(run.page).first().click();
      await expect.poll(() => status(run), { timeout: 180000 }).toBe("ready");
      expectBothPagesOnce(run);
    } finally {
      await close(run);
    }
  });
});
