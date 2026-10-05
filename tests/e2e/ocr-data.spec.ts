import AxeBuilder from "@axe-core/playwright";
import {
  _electron as electron,
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
  rmSync,
  truncateSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OCR_DATA_FILES, ocrDataDir } from "../../src/core/sources/ocr-data";

const MAIN = join(
  process.cwd(),
  process.env.PYXIS_OUT ?? "out",
  "main/index.js",
);
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
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    ...extra,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
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
  if (firstRun) await page.getByRole("button", { name: "Salta" }).click();
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

async function noAxeViolations(page: Page) {
  const found = (await new AxeBuilder({ page }).setLegacyMode(true).analyze())
    .violations;
  expect(
    found.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
    ),
  ).toEqual([]);
}

test("OCR data: a refused photo asks first, the app downloads the pinned files on consent, and the choice survives a restart", async () => {
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ocr-data-"));
  let app = await launch(userData);
  try {
    let page = await start(app, "/exams/library", true);
    const first = await invoke<{
      consent: boolean;
      state: string;
      totalBytes: number;
      languages: string[];
    }>(page, "sources.ocrDataState");
    expect(first).toMatchObject({
      consent: false,
      state: "missing",
      totalBytes,
      languages: ["eng", "ita"],
    });

    // A HEIC photo is refused before any row exists, and nothing is fetched until the student agrees.
    await page.getByRole("button", { name: "Aggiungi fonti" }).click();
    const dialog = page.getByRole("dialog");
    await app.evaluate((_, path) => {
      process.env.PYXIS_E2E_FILE = path;
    }, HEIC);
    await dialog.getByRole("button", { name: "Scegli un file" }).click();
    await expect(
      dialog.getByText(/Per leggere questo file Pyxis ha bisogno/),
    ).toBeVisible();
    await expect(dialog.getByText(/raw\.githubusercontent\.com/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: download })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Non ora" })).toBeVisible();
    await noAxeViolations(page);
    expect(await invoke<unknown[]>(page, "sources.list")).toHaveLength(0);
    expect(await ocrJobs(page)).toHaveLength(0);
    expect(existsSync(tessDir(userData))).toBe(false);
    expect(
      (await invoke<{ consent: boolean }>(page, "sources.ocrDataState"))
        .consent,
    ).toBe(false);

    // Agreeing downloads the pinned files. The refused import is not run for the student: they press it again.
    await dialog.getByRole("button", { name: download }).click();
    const again = dialog.getByRole("button", {
      name: "Aggiungi di nuovo il file",
    });
    await expect(again).toBeVisible({ timeout: 120000 });
    await expect(
      dialog.getByText("La lettura delle scansioni è pronta"),
    ).toBeVisible();
    expectPinned(userData);
    // A finished download leaves the jobs list; the disk and the state request are what show it is done.
    expect(await ocrJobs(page)).toHaveLength(0);
    expect(await invoke(page, "sources.ocrDataState")).toMatchObject({
      consent: true,
      state: "ready",
    });
    expect(await invoke<unknown[]>(page, "sources.list")).toHaveLength(0);
    await noAxeViolations(page);

    await again.click();
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

    // The consent and the files outlive a restart.
    await app.close();
    app = await launch(userData);
    page = await start(app, "/settings/data");
    await expect(
      page.getByText("La lettura delle scansioni è pronta"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: download })).toHaveCount(0);
    expect(await invoke(page, "sources.ocrDataState")).toMatchObject({
      consent: true,
      state: "ready",
    });
    await noAxeViolations(page);

    // An altered file is reported as damaged, and downloading again replaces it with the pinned bytes.
    truncateSync(join(tessDir(userData), "eng.traineddata"), 1000);
    await page.reload();
    await expect(page.getByText(/danneggiati o incompleti/)).toBeVisible();
    expect(await invoke(page, "sources.ocrDataState")).toMatchObject({
      state: "integrity",
    });
    await page.getByRole("button", { name: downloadAgain }).click();
    await expect(
      page.getByText("La lettura delle scansioni è pronta"),
    ).toBeVisible({ timeout: 120000 });
    expectPinned(userData);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("OCR data: cancel and a failed connection leave a clear way back, and Try again finishes the download", async () => {
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
  let app = await launch(userData, {
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: url,
    https_proxy: url,
  });
  try {
    let page = await start(app, "/settings/data", true);
    await expect(
      page.getByText("Leggere le scansioni richiede un download una tantum"),
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

    // After a restart with a working connection, Try again fetches the files and clears the failure.
    await app.close();
    app = await launch(userData);
    page = await start(app, "/settings/data");
    await expect(
      page.getByText(
        /Pyxis non è riuscito a raggiungere raw\.githubusercontent\.com/,
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Riprova" }).click();
    await expect(
      page.getByText("La lettura delle scansioni è pronta"),
    ).toBeVisible({ timeout: 120000 });
    expectPinned(userData);
    expect(await ocrJobs(page)).toHaveLength(0);
  } finally {
    await app.close();
    proxy.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
