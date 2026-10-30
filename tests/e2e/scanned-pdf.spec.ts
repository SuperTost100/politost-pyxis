import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { importPickedSource } from "./picked-source";
import {
  drawScanPages,
  installTessdata,
  SCAN_PAGES,
  stagedTessdata,
  writeScanPdf,
} from "./scanned-pdf-fixture";
import { removeTestFolder } from "./cleanup";

/*
 * A generated image-only PDF goes through the real path: core's job draws each page with pdf.js and reads it with the
 * pinned Tesseract files, a batch of pages at a time, while the window only watches. Nothing is mocked in the IPC, and no
 * network or model is called. The window leaving, reloading, the student stopping and the app quitting must each keep
 * the pages read, and none but Stop may end the reading.
 */

/** Enough pages for three batches, so a test can act after the first and still find the scan reading. */
const PAGE_COUNT = 20;
/** Pages core reads per batch (`OCR_BATCH` in `src/core/sources/ocr-job.ts`). */
const BATCH = 8;

const scanButton = (page: Page) =>
  page.getByRole("button", { name: /^(Leggi la scansione|Read the scan)$/ });
const staged = stagedTessdata();

type Run = {
  app: ElectronApplication;
  page: Page;
  userData: string;
  sourceId: string;
};

/**
 * Launches a fresh workspace and imports the generated scanned PDF through the native picker. With `data`, the OCR
 * language files are there before the import, as after an earlier download.
 */
async function openScan({ data = false } = {}): Promise<Run> {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-scanned-pdf-"));
  if (data) installTessdata(userData, staged!);
  const app = await launchPyxis({ userData });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  // Skipping saves the profile, then moves to Exams; wait so a reload or route change cannot land on setup.
  await expect(page).toHaveURL(/#\/exams$/);
  if (data) {
    // Consent was given with that download.
    await page.evaluate(() => window.pyxis.invoke("sources.ocrData", { consent: true }));
  }
  const drawn = await drawScanPages(page);
  const pdf = join(userData, "scan.pdf");
  writeScanPdf(pdf, Array.from({ length: PAGE_COUNT }, (_, index) => drawn[index % drawn.length]!));
  const { sourceId } = (await importPickedSource(page, app, pdf)) as {
    sourceId: string;
  };
  const run = { app, page, userData, sourceId };
  // The import extracts in the background; an image-only PDF has no text layer, so it waits for OCR.
  await expect
    .poll(() => status(run), { timeout: 60000 })
    .toMatch(data ? /^(ocr-queued|ready)$/ : /^needs-ocr$/);
  await page.evaluate(() => {
    location.hash = "/exams/library";
  });
  await page.reload();
  await expect(page.locator("h1:visible").first()).toBeVisible();
  return run;
}

async function close(run: Run) {
  await run.app.close();
  removeTestFolder(run.userData);
}

const status = async ({ page, sourceId }: Pick<Run, "page" | "sourceId">) =>
  (await page.evaluate(() => window.pyxis.invoke("sources.list", {}))).find(
    (row) => row.id === sourceId,
  )?.status;

function passages({
  userData,
  sourceId,
}: Pick<Run, "userData" | "sourceId">): { page: number; text: string }[] {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
    readOnly: true,
    timeout: 10000,
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

const pagesRead = (run: Pick<Run, "userData" | "sourceId">) => new Set(passages(run).map((row) => row.page)).size;

/** Every page is stored exactly once, each with its own words. */
function expectEveryPageOnce(run: Run) {
  const rows = passages(run);
  expect(rows.map((row) => row.page)).toEqual(
    Array.from({ length: PAGE_COUNT }, (_, index) => index + 1),
  );
  rows.forEach((row, index) => {
    const [, word] = SCAN_PAGES[index % SCAN_PAGES.length]!;
    const [, other] = SCAN_PAGES[(index + 1) % SCAN_PAGES.length]!;
    expect(row.text.toUpperCase()).toContain(word);
    expect(row.text.toUpperCase()).not.toContain(other);
  });
}

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
    // Core refused before queuing, so the row never shows the scan reading.
    await expect.poll(() => status(run)).toBe("needs-ocr");
    // Later keeps the scan startable.
    await run.page.getByRole("button", { name: /^(Non ora|Not now)$/ }).click();
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
    const db = new DatabaseSync(join(run.userData, "workspace", "pyxis.db"), {
      timeout: 10000,
    });
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

  test("an imported scan starts reading by itself, and leaving the Library or reloading the window does not stop it", async () => {
    test.setTimeout(300000);
    const run = await openScan({ data: true });
    try {
      // No button to find: the reading shows with its progress and a way to stop it.
      await expect(
        run.page.getByText(/Lettura delle pagine scansionate|Reading the scanned pages/).first(),
      ).toBeVisible();
      await expect(run.page.getByRole("progressbar").first()).toBeVisible();
      await expect(
        run.page.getByRole("button", { name: /^(Interrompi la lettura|Stop reading)$/ }),
      ).toBeVisible();
      await expect.poll(() => pagesRead(run), { timeout: 120000 }).toBeGreaterThanOrEqual(BATCH);
      // The old window-driven scan stopped on both of these.
      await run.page.evaluate(() => {
        location.hash = "/exams";
      });
      await run.page.reload();
      await expect(run.page.locator("h1:visible").first()).toBeVisible();
      await expect.poll(() => status(run), { timeout: 240000 }).toBe("ready");
      expectEveryPageOnce(run);
    } finally {
      await close(run);
    }
  });

  test("a quit mid-scan resumes at the next start and reads only the pages left", async () => {
    test.setTimeout(300000);
    const run = await openScan({ data: true });
    try {
      await expect.poll(() => pagesRead(run), { timeout: 120000 }).toBeGreaterThanOrEqual(BATCH);
      await run.app.close();
      const kept = pagesRead(run);
      expect(kept).toBeLessThan(PAGE_COUNT);
      const reopened = await launchPyxis({ userData: run.userData });
      const page = await reopened.firstWindow();
      const again = { ...run, app: reopened, page };
      try {
        await expect.poll(() => status(again), { timeout: 240000 }).toBe("ready");
        expectEveryPageOnce(again);
      } finally {
        await reopened.close();
      }
    } finally {
      removeTestFolder(run.userData);
    }
  });

  test("Stop keeps the pages read and returns the scan to Read the scan, which finishes it", async () => {
    test.setTimeout(300000);
    // The data arrives after the import, so this scan waits for the student's press.
    const run = await openScan();
    try {
      installTessdata(run.userData, staged!);
      await scanButton(run.page).click();
      await expect.poll(() => pagesRead(run), { timeout: 120000 }).toBeGreaterThanOrEqual(BATCH);
      await run.page
        .getByRole("button", { name: /^(Interrompi la lettura|Stop reading)$/ })
        .click();
      await expect.poll(() => status(run), { timeout: 60000 }).toBe("needs-ocr");
      const kept = pagesRead(run);
      expect(kept).toBeGreaterThanOrEqual(BATCH);
      expect(kept).toBeLessThan(PAGE_COUNT);
      await scanButton(run.page).first().click();
      await expect.poll(() => status(run), { timeout: 240000 }).toBe("ready");
      expectEveryPageOnce(run);
      await expect(scanButton(run.page)).toHaveCount(0);
    } finally {
      await close(run);
    }
  });
});
