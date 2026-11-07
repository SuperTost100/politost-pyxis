import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  truncateSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OCR_DATA_FILES, ocrDataDir } from "../../src/core/sources/ocr-data";
import { launchPyxis } from "./app-under-test";
import { animationsSettled } from "./settled";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

const HEIC = join(process.cwd(), "tests/fixtures/synthetic-note.heic");
const totalBytes = Object.values(OCR_DATA_FILES).reduce(
  (sum, file) => sum + file.size,
  0,
);
const tessDir = (userData: string) =>
  ocrDataDir(join(userData, "workspace", "runtimes", "tesseract"));
const download = /^Scarica [\d.,]+ MB$/;
const downloadAgain = /^Scarica di nuovo, [\d.,]+ MB$/;

async function launch(
  userData: string,
  extra: Record<string, string> = {},
): Promise<ElectronApplication> {
  const app = await launchPyxis({ userData, env: extra });
  // Keep core failure and port diagnostics in the recorded run log.
  app.process().stderr?.on("data", (chunk) => {
    console.error(String(chunk));
  });
  return app;
}

async function start(
  app: ElectronApplication,
  route: string,
  firstRun = false,
): Promise<Page> {
  const page = await app.firstWindow();
  if (firstRun) {
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Chiedi; wait so a reload or route change cannot land on setup.
    await fromChiediToExams(page);
  }
  await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
  await page.evaluate((hash) => {
    location.hash = hash;
  }, route);
  await page.reload();
  await expect(page.locator("h1:visible").first()).toBeVisible();
  return page;
}

const invoke = <T>(page: Page, channel: string, input: object = {}) =>
  page.evaluate(([c, i]) => window.pyxis.invoke(c as never, i as never), [
    channel,
    input,
  ] as const) as Promise<T>;

type Job = { id: string; kind: string; state: string; error: string | null };
const ocrJobs = async (page: Page) =>
  (await invoke<Job[]>(page, "jobs.list")).filter(
    (job) => job.kind === "ocr-data-download",
  );

function expectPinned(userData: string) {
  for (const [lang, pinned] of Object.entries(OCR_DATA_FILES)) {
    const bytes = readFileSync(join(tessDir(userData), `${lang}.traineddata`));
    expect(bytes.length).toBe(pinned.size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      pinned.sha256,
    );
  }
}

/**
 * A local server standing in for GitHub, so no test downloads from it: it serves the pinned files the fixtures task
 * downloaded once (`npm run test:fixtures`) and records each request.
 */
async function tessdataServer() {
  const dir = process.env.PYXIS_TESSDATA_DIR ?? join(process.cwd(), ".tmp", "tessdata-fast");
  const requests: string[] = [];
  const server = createHttpServer((request, response) => {
    const path = request.url ?? "";
    requests.push(path);
    const name = /^\/(eng|ita)\.traineddata$/.exec(path)?.[0].slice(1);
    if (!name || !existsSync(join(dir, name))) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(join(dir, name)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    requests,
    close: () => server.close(),
  };
}

async function noAxeViolations(page: Page) {
  // A dialog that is still fading in has translucent text, which axe reports as low contrast.
  await animationsSettled(page);
  await expectNoAxeViolations(page);
}

test("OCR data: once setup is done Pyxis downloads the pinned files by itself, reads a photo with them, and repairs an altered file", async () => {
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ocr-data-"));
  const files = await tessdataServer();
  let app = await launch(userData, { PYXIS_E2E_OCR_BASE: files.base });
  try {
    // Setup downloads nothing.
    let page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "Salta" })).toBeVisible();
    expect(await invoke(page, "sources.ocrDataState")).toMatchObject({
      consent: true,
      state: "missing",
      totalBytes,
      languages: ["eng", "ita"],
    });
    expect(await ocrJobs(page)).toHaveLength(0);
    expect(files.requests).toEqual([]);
    page = await start(app, "/exams/library", true);
    // Once it ends, the download runs on its own as a job in Attività, with nothing to press.
    await expect
      .poll(async () => (await invoke<{ state: string }>(page, "sources.ocrDataState")).state, { timeout: 120000 })
      .toBe("ready");
    expectPinned(userData);
    expect(files.requests).toEqual(["/eng.traineddata", "/ita.traineddata"]);
    expect(await invoke(page, "sources.ocrDataState")).toMatchObject({ consent: true, state: "ready" });
    // A finished download leaves the jobs list for the finished ones.
    expect(await ocrJobs(page)).toHaveLength(0);
    expect(
      (await invoke<Job[]>(page, "jobs.finished")).filter((job) => job.kind === "ocr-data-download"),
    ).toMatchObject([{ state: "succeeded" }]);

    // A HEIC photo is read with the data straight away, with no question first.
    await page.getByRole("button", { name: "Aggiungi fonti" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await animationsSettled(page);
    await app.evaluate((_, path) => {
      process.env.PYXIS_E2E_FILE = path;
    }, HEIC);
    await dialog.getByRole("button", { name: "Scegli i file" }).click();
    await expect
      .poll(
        async () =>
          (await invoke<Array<{ kind: string }>>(page, "sources.list")).length,
        { timeout: 30000 },
      )
      .toBe(1);
    // The real HEIC decoder and worker run now; the synthetic note has no text, so the reading ends as failed.
    await expect
      .poll(
        async () =>
          (await invoke<Array<{ status: string }>>(page, "sources.list"))[0]
            ?.status,
        { timeout: 90000 },
      )
      .toBe("failed");

    // The files outlive a restart, and nothing is downloaded again.
    await app.close();
    app = await launch(userData, { PYXIS_E2E_OCR_BASE: files.base });
    page = await start(app, "/settings/data");
    await expect(
      page.getByText("La lettura delle scansioni è pronta"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: download })).toHaveCount(0);
    expect(await invoke(page, "sources.ocrDataState")).toMatchObject({
      consent: true,
      state: "ready",
    });
    expect(files.requests).toHaveLength(2);
    expect(await ocrJobs(page)).toHaveLength(0);
    await noAxeViolations(page);

    // An altered file is replaced with the pinned bytes by itself, and only that file is fetched.
    truncateSync(join(tessDir(userData), "eng.traineddata"), 1000);
    await page.reload();
    await expect(
      page.getByText("La lettura delle scansioni è pronta"),
    ).toBeVisible({ timeout: 120000 });
    expectPinned(userData);
    expect(files.requests.slice(2)).toEqual(["/eng.traineddata"]);
  } finally {
    await app.close();
    files.close();
    removeTestFolder(userData);
  }
});

test("OCR data: cancel and a failed connection leave a clear way back, and the next start finishes the download", async () => {
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ocr-data-"));
  // A local proxy stands in for the network: it holds the connection open, then drops it. Nothing reaches GitHub.
  let mode: "hold" | "drop" = "hold";
  let connections = 0;
  const proxy: Server = createServer((socket) => {
    connections += 1;
    socket.on("error", () => undefined);
    if (mode === "drop") socket.destroy();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const files = await tessdataServer();
  let app = await launch(userData, {
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: url,
    https_proxy: url,
  });
  try {
    let page = await start(app, "/settings/data", true);
    // End-to-end runs never download from GitHub on their own, so the card offers the download.
    await expect(
      page.getByText("I dati per leggere le scansioni non sono ancora su questo computer"),
    ).toBeVisible();
    await page.getByRole("button", { name: download }).click();
    const progress = page.getByRole("progressbar", {
      name: "Scarico i dati di lettura delle scansioni",
    });
    await expect(progress).toBeVisible();
    await noAxeViolations(page);
    await expect.poll(() => connections).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Annulla il download" }).click();
    await expect(page.getByText(/Il download è stato annullato/)).toBeVisible();
    expect(await ocrJobs(page)).toMatchObject([{ state: "cancelled" }]);
    expect(existsSync(tessDir(userData))).toBe(false);

    mode = "drop";
    await page.getByRole("button", { name: downloadAgain }).click();
    await expect(
      page.getByText(
        /Pyxis non è riuscito a raggiungere raw\.githubusercontent\.com/,
      ),
    ).toBeVisible({ timeout: 60000 });
    await expect(page.getByRole("button", { name: "Riprova" })).toBeVisible();
    // The new attempt replaced the cancelled one in the jobs list.
    expect(await ocrJobs(page)).toMatchObject([
      { state: "failed", error: "ocr-data-offline" },
    ]);
    await noAxeViolations(page);

    // After a restart with a working connection, Pyxis replaces the failed download with a new one by itself.
    await app.close();
    app = await launch(userData, { PYXIS_E2E_OCR_BASE: files.base });
    page = await start(app, "/settings/data");
    await expect(
      page.getByText("La lettura delle scansioni è pronta"),
    ).toBeVisible({ timeout: 120000 });
    expectPinned(userData);
    expect(await ocrJobs(page)).toHaveLength(0);
  } finally {
    await app.close();
    proxy.close();
    files.close();
    removeTestFolder(userData);
  }
});
