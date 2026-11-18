import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBytes } from "../../src/shared/format-bytes";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { drawingPinned, pythonPinned, stagePacks } from "./drawing-packs";
import { packServer } from "./pack-server";
import { SHOTS, saveShot } from "./shots";
import { clickSettled } from "./settled";

// Settings › Studio › "Disegni e Python": two rows, one for Python and one for the drawings, each downloaded, updated and
// removed on its own. Every download comes from a local server that stands in for the CDNs (PYXIS_E2E_PACK_BASE), which a
// test makes slow, failing or tampered, so no real network is touched.

const manifest = (pack: "pyodide" | "drawing") =>
  JSON.parse(readFileSync(join(process.cwd(), `resources/${pack}-manifest.json`), "utf8")) as {
    version: string;
    files: Array<{ name: string; size: number }>;
  };
const bytes = (pack: "pyodide" | "drawing") => manifest(pack).files.reduce((sum, file) => sum + file.size, 0);
const sized = (count: number, language = "it") => formatBytes(count, language);

const automaton = "digraph automa { rankdir=LR; q0 -> q1 [label=a]; q1 -> q2 [label=b]; q2 -> q0 [label=c] }";
const graphReply = [
  "Un automa a stati finiti ha stati e transizioni.",
  "",
  ["```pyxis-figure", JSON.stringify({ kind: "graph", caption: "Un automa con tre stati.", code: automaton }), "```"].join("\n"),
  "",
  "Fine della risposta.",
].join("\n");

const pinned = () => drawingPinned() && pythonPinned();

type Setup = { userData: string; app: ElectronApplication; page: Page; server: Awaited<ReturnType<typeof packServer>> };

/** An app with its own profile, a server for the packs, and the Settings page of the packs open. */
async function start(
  options: { stage?: Array<"pyodide" | "drawing">; env?: Record<string, string>; before?: (userData: string) => void } = {},
): Promise<Setup> {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-packs-"));
  let server: Awaited<ReturnType<typeof packServer>> | undefined;
  let app: ElectronApplication | undefined;
  // A setup that fails leaves nothing behind: the caller has not got `finish` yet to clean up with.
  try {
    options.before?.(userData);
    if (options.stage?.length) stagePacks(userData, options.stage);
    server = await packServer();
    app = await launchPyxis({
      userData,
      env: { HOME: userData, PYXIS_E2E_PACK_BASE: server.base, ...options.env },
    });
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await openPacks(page);
    return { userData, app, page, server };
  } catch (error) {
    await app?.close().catch(() => undefined);
    server?.close();
    removeTestFolder(userData);
    throw error;
  }
}
async function openPacks(page: Page) {
  await page.evaluate(() => {
    location.hash = "/settings/packs";
  });
  await expect(page.getByRole("heading", { name: /^(Disegni e Python|Drawings and Python)$/ })).toBeVisible();
}
async function finish({ app, userData, server }: Setup) {
  await app.close();
  server.close();
  removeTestFolder(userData);
}
const row = (page: Page, pack: "pyodide" | "drawing") => page.locator(`li[data-pack="${pack}"]`);
const runtimeStatus = (page: Page) =>
  page.evaluate(() => window.pyxis.invoke("tools.runtime", {})) as Promise<{
    packs: Record<string, string>;
    info: Record<string, { phase: string; bytes: number; outdated: boolean; error?: string }>;
  }>;
const packFolder = (userData: string, pack: "pyodide" | "drawing", version = manifest(pack).version) =>
  join(userData, "workspace/runtimes", pack, version);

test("the two rows offer their downloads with their sizes and where the files come from, and fetch nothing on their own", async () => {
  test.skip(!pinned(), "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.");
  const setup = await start();
  const { page, server } = setup;
  try {
    const python = row(page, "pyodide");
    const drawings = row(page, "drawing");
    await expect(python.getByText("Python", { exact: true })).toBeVisible();
    await expect(python.getByText("Per fare i calcoli nelle risposte, eseguire il tuo codice e disegnare grafici e circuiti.")).toBeVisible();
    await expect(python.getByText("Scaricato una volta sola da jsDelivr, solo quando lo chiedi. Non viene inviato niente di te.")).toBeVisible();
    await expect(python.getByRole("button", { name: `Scarica Python (${sized(bytes("pyodide"))})` })).toBeVisible();
    await expect(drawings.getByText("Disegni", { exact: true })).toBeVisible();
    await expect(drawings.getByText("Grafi, alberi e automi nelle lezioni e nelle risposte.")).toBeVisible();
    // Without Python it says what is left out.
    await expect(drawings.getByText("Senza Python disegna tutto tranne i circuiti.")).toBeVisible();
    await expect(
      drawings.getByText("Scaricati una volta sola da jsDelivr e da PyPI, solo quando lo chiedi. Non viene inviato niente di te."),
    ).toBeVisible();
    await expect(drawings.getByRole("button", { name: `Scarica i disegni (${sized(bytes("drawing"))})` })).toBeVisible();
    // No menu while there is nothing to remove, and nothing asked for from anywhere.
    await expect(page.getByRole("button", { name: /^(Altro su Python|Altro sui disegni)$/ })).toHaveCount(0);
    await page.waitForTimeout(2500);
    expect(server.requests).toEqual([]);
    expect((await runtimeStatus(page)).packs).toEqual({ pyodide: "idle", drawing: "idle" });
    await expectNoAxeViolations(page);
    await saveShot(page, "settings/it-light-nothing.png");

    // The Python page keeps its own offer, and says the same about where the files come from.
    await page.evaluate(() => {
      location.hash = "/tools/python";
    });
    await expect(page.getByText("Python richiede un download una tantum")).toBeVisible();
    await expect(
      page.getByText(
        `Pyxis scarica il runtime di Python e i file dei disegni (${new Intl.NumberFormat("it", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format((bytes("pyodide") + bytes("drawing")) / 1e6)} MB) in questo spazio di lavoro, da jsDelivr e da PyPI, una volta sola. Non scarica nulla finché non lo chiedi e non invia niente di te.`,
      ),
    ).toBeVisible();
    expect(server.requests).toEqual([]);
  } finally {
    await finish(setup);
  }
});

test("the drawings download on their own, show their progress in place and can be stopped, and Python is not touched", async () => {
  test.skip(!pinned(), "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.");
  test.setTimeout(120000);
  const setup = await start();
  const { page, server, userData } = setup;
  try {
    const [wheel, library] = manifest("drawing").files;
    // The wheel arrives and graphviz.js is held back: the pack is part of the way.
    server.hold.add(library!.name);
    const drawings = row(page, "drawing");
    await drawings.getByRole("button", { name: /^Scarica i disegni/ }).click();
    await expect(drawings).toHaveAttribute("data-phase", "downloading");
    const progress = drawings.locator(".px-pack-progress");
    await expect(progress).toBeVisible();
    // In place: where the button was, with its size so far; the text of the row and the other row did not move.
    await expect(progress.locator(".px-pack-stat")).toHaveText(`${sized(wheel!.size)} di ${sized(bytes("drawing"))}`, { timeout: 30000 });
    await expect(drawings.getByRole("button", { name: /^Scarica i disegni/ })).toHaveCount(0);
    await expect(drawings.getByText("Senza Python disegna tutto tranne i circuiti.")).toBeVisible();
    await expect(row(page, "pyodide").getByRole("button", { name: /^Scarica Python/ })).toBeVisible();
    // Said politely, in tens, for a screen reader; the bar has its own name.
    const live = drawings.locator("[role=status]");
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).toHaveText("Scaricamento dei disegni: 10%");
    await expect(drawings.getByRole("progressbar", { name: /^Scaricamento dei disegni: 1\d%$/ })).toBeVisible();
    await saveShot(page, "settings/it-light-downloading.png");

    // Stopped: the button is back where it was, nothing is marked ready and Python is as it was.
    await drawings.getByRole("button", { name: "Annulla", exact: true }).click();
    await expect(drawings.getByRole("button", { name: /^Scarica i disegni/ })).toBeVisible({ timeout: 30000 });
    await expect(drawings).toHaveAttribute("data-phase", "idle");
    expect((await runtimeStatus(page)).packs).toEqual({ pyodide: "idle", drawing: "idle" });
    expect(server.requests.filter((request) => request.startsWith("pyodide/"))).toEqual([]);

    // Again, this time to the end.
    server.hold.clear();
    await drawings.getByRole("button", { name: /^Scarica i disegni/ }).click();
    await expect(drawings).toHaveAttribute("data-phase", "ready", { timeout: 60000 });
    await expect(drawings.getByText(`${sized(bytes("drawing"))} sul disco · versione ${manifest("drawing").version}.`)).toBeVisible();
    await expect(drawings.getByRole("button", { name: "Altro sui disegni" })).toBeVisible();
    await expect(drawings.getByText(/jsDelivr/)).toHaveCount(0);
    expect(existsSync(join(packFolder(userData, "drawing"), library!.name))).toBe(true);
    // Python still has its button, and its row says nothing about the drawings.
    await expect(row(page, "pyodide").getByRole("button", { name: /^Scarica Python/ })).toBeVisible();
    expect((await runtimeStatus(page)).packs).toEqual({ pyodide: "idle", drawing: "ready" });
    await expectNoAxeViolations(page);
    await saveShot(page, "settings/it-light-drawings.png");
  } finally {
    await finish(setup);
  }
});

test("a download that fails says where it stopped and offers Riprova, and a tampered file is refused and not kept", async () => {
  test.skip(!pinned(), "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.");
  test.setTimeout(120000);
  const setup = await start();
  const { page, server, userData } = setup;
  try {
    const [wheel, library] = manifest("drawing").files;
    const drawings = row(page, "drawing");
    // graphviz.js cannot be fetched: the wheel is in, so it stopped part of the way.
    server.fail.add(library!.name);
    await drawings.getByRole("button", { name: /^Scarica i disegni/ }).click();
    const failure = drawings.getByRole("alert");
    await expect(failure).toHaveText(`Lo scaricamento si è fermato a ${sized(wheel!.size)}. Controlla la connessione.`, { timeout: 30000 });
    await expect(drawings).toHaveAttribute("data-phase", "failed");
    await expect(drawings.getByRole("button", { name: "Riprova", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Altro sui disegni" })).toHaveCount(0);
    await expectNoAxeViolations(page);
    await saveShot(page, "settings/it-light-failed.png");

    // The file arrives with another byte in it: refused whole, said as what it is, and not left on the disk.
    server.fail.clear();
    server.tamper.add(library!.name);
    await drawings.getByRole("button", { name: "Riprova", exact: true }).click();
    await expect(drawings.getByRole("alert")).toHaveText("I file arrivati non erano quelli attesi e sono stati scartati. Riprova.", { timeout: 30000 });
    expect(existsSync(join(packFolder(userData, "drawing"), library!.name))).toBe(false);
    expect((await runtimeStatus(page)).info.drawing).toMatchObject({ phase: "failed", error: "runtime-integrity-failed" });
    await saveShot(page, "settings/it-light-tampered.png");

    // A good file ends it: the pack is ready, and the failure is gone.
    server.tamper.clear();
    await drawings.getByRole("button", { name: "Riprova", exact: true }).click();
    await expect(drawings).toHaveAttribute("data-phase", "ready", { timeout: 60000 });
    await expect(drawings.getByRole("alert")).toHaveCount(0);
  } finally {
    await finish(setup);
  }
});

test("a pack older than the app's is offered as an update, nothing is fetched by itself, and updating replaces it", async () => {
  test.skip(!pinned(), "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.");
  test.setTimeout(120000);
  const setup = await start({
    // The drawing pack of an earlier version of the app, which this app's manifest cannot vouch for.
    before: (userData) => {
      const older = join(userData, "workspace/runtimes/drawing/1");
      mkdirSync(older, { recursive: true });
      writeFileSync(join(older, "graphviz.js"), "old");
    },
  });
  const { page, server, userData } = setup;
  try {
    const drawings = row(page, "drawing");
    const version = manifest("drawing").version;
    await expect(
      drawings.getByText(
        `Servono i disegni aggiornati, versione ${version} (${sized(bytes("drawing"))}): quelli sul disco sono di una versione precedente e finché non li aggiorni non si usano.`,
      ),
    ).toBeVisible();
    await expect(drawings.getByRole("button", { name: "Aggiorna", exact: true })).toBeVisible();
    // It can be taken off, and it is not run: the pack is not ready.
    await expect(drawings.getByRole("button", { name: "Altro sui disegni" })).toBeVisible();
    expect((await runtimeStatus(page)).info.drawing).toMatchObject({ phase: "idle", outdated: true });
    // Left alone for a while, nothing is asked of the network, and the old files stay where they are.
    await page.waitForTimeout(2500);
    expect(server.requests).toEqual([]);
    expect(existsSync(join(userData, "workspace/runtimes/drawing/1/graphviz.js"))).toBe(true);
    await expectNoAxeViolations(page);
    await saveShot(page, "settings/it-light-update.png");

    await drawings.getByRole("button", { name: "Aggiorna", exact: true }).click();
    await expect(drawings).toHaveAttribute("data-phase", "ready", { timeout: 60000 });
    await expect(drawings.getByText(`${sized(bytes("drawing"))} sul disco · versione ${version}.`)).toBeVisible();
    // The older version went once the new one was in place.
    expect(existsSync(join(userData, "workspace/runtimes/drawing/1"))).toBe(false);
    expect(existsSync(packFolder(userData, "drawing"))).toBe(true);
  } finally {
    await finish(setup);
  }
});

test("Python downloads on its own, and with it the drawings row says that circuits are drawn too", async () => {
  test.skip(!pinned(), "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.");
  test.setTimeout(180000);
  const setup = await start();
  const { page, server, userData } = setup;
  try {
    const python = row(page, "pyodide");
    await python.getByRole("button", { name: /^Scarica Python/ }).click();
    await expect(python).toHaveAttribute("data-phase", "ready", { timeout: 120000 });
    await expect(python.getByText(`${sized(bytes("pyodide"))} sul disco.`)).toBeVisible();
    await expect(python.getByRole("button", { name: "Altro su Python" })).toBeVisible();
    // Only Python was fetched: the drawings keep their button, and now say they draw circuits as well.
    expect(server.requests.some((request) => request.startsWith("drawing/"))).toBe(false);
    await expect(row(page, "drawing").getByRole("button", { name: /^Scarica i disegni/ })).toBeVisible();
    await expect(row(page, "drawing").getByText("Con Python disegna anche i circuiti.")).toBeVisible();
    await expect(row(page, "drawing").getByText("Senza Python disegna tutto tranne i circuiti.")).toHaveCount(0);
    expect(existsSync(join(packFolder(userData, "pyodide"), manifest("pyodide").files[0]!.name))).toBe(true);
    expect(readdirSync(join(userData, "workspace/runtimes"))).toEqual(["pyodide"]);
    await saveShot(page, "settings/it-light-python.png");
  } finally {
    await finish(setup);
  }
});

test("Annulla on one row stops that pack only, even when the Python page started one download for both", async () => {
  test.skip(!pinned(), "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.");
  test.setTimeout(180000);
  const setup = await start();
  const { page, server } = setup;
  try {
    const python = row(page, "pyodide");
    const drawings = row(page, "drawing");
    // Both packs have one file held back, so both are on their way.
    server.hold.add(manifest("pyodide").files[0]!.name);
    server.hold.add(manifest("drawing").files[1]!.name);
    await page.evaluate(() => {
      location.hash = "/tools/python";
    });
    const all = new Intl.NumberFormat("it", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
      (bytes("pyodide") + bytes("drawing")) / 1e6,
    );
    await page.getByRole("button", { name: `Scarica Python (${all} MB)` }).click();
    await openPacks(page);
    await expect(python).toHaveAttribute("data-phase", "downloading");
    await expect(drawings).toHaveAttribute("data-phase", "downloading");
    // Stopping the drawings leaves Python's download as it was.
    await drawings.getByRole("button", { name: "Annulla", exact: true }).click();
    await expect(drawings).toHaveAttribute("data-phase", "idle", { timeout: 30000 });
    await expect(python).toHaveAttribute("data-phase", "downloading");
    await expect(python.locator(".px-pack-progress")).toBeVisible();
    // Python then arrives, and the drawings are still to be asked for.
    server.hold.clear();
    await expect(python).toHaveAttribute("data-phase", "ready", { timeout: 120000 });
    await expect(drawings.getByRole("button", { name: /^Scarica i disegni/ })).toBeVisible();
    expect((await runtimeStatus(page)).packs).toEqual({ pyodide: "ready", drawing: "idle" });
  } finally {
    await finish(setup);
  }
});

test("the Python page knows a download started from Settings: it still offers Python, and what is running can be cancelled", async () => {
  test.skip(!pinned(), "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.");
  test.setTimeout(180000);
  const setup = await start();
  const { page, server } = setup;
  try {
    const drawings = row(page, "drawing");
    server.hold.add(manifest("drawing").files[1]!.name);
    await drawings.getByRole("button", { name: /^Scarica i disegni/ }).click();
    await expect(drawings).toHaveAttribute("data-phase", "downloading");
    await page.evaluate(() => {
      location.hash = "/tools/python";
    });
    // Only the drawings are downloading, so Python can still be asked for, for its own size, and the download that runs
    // has its progress and its Annulla on this page too.
    const python = new Intl.NumberFormat("it", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes("pyodide") / 1e6);
    await expect(page.getByRole("button", { name: `Scarica Python (${python} MB)` })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /^Scarico · .+ di .+ MB$/ })).toBeVisible();
    await page.getByRole("button", { name: "Annulla", exact: true }).click();
    await openPacks(page);
    await expect(drawings).toHaveAttribute("data-phase", "idle", { timeout: 30000 });
    expect((await runtimeStatus(page)).packs).toEqual({ pyodide: "idle", drawing: "idle" });
  } finally {
    await finish(setup);
  }
});

/** The row's three dots, or a right-click on the row, open the same menu; it holds actions only. */
async function openMenu(page: Page, pack: "pyodide" | "drawing", how: "dots" | "right-click" | "keyboard") {
  const target = row(page, pack);
  const name = pack === "drawing" ? "Altro sui disegni" : "Altro su Python";
  if (how === "dots") await target.getByRole("button", { name }).click();
  else if (how === "right-click") await target.locator(".px-ctl-title").click({ button: "right" });
  else {
    await target.getByRole("button", { name }).focus();
    await page.keyboard.press("Enter");
  }
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("a download that waits in the queue shows as waiting with its Annulla, on the Python page and in Settings, and cancelling it ends it", async () => {
  test.skip(!pinned(), "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.");
  test.setTimeout(120000);
  // No local job may run, so what is asked for waits in the queue and nothing is fetched.
  const setup = await start({ env: { PYXIS_E2E_LOCAL_JOBS: "0" } });
  const { page, server } = setup;
  try {
    const python = row(page, "pyodide");
    const drawings = row(page, "drawing");
    const jobStates = () =>
      page.evaluate(async () => {
        const jobs = (await window.pyxis.invoke("jobs.list", {})) as Array<{ kind: string; state: string }>;
        return jobs.filter((job) => job.kind.endsWith("-download")).map((job) => job.state);
      });
    const all = new Intl.NumberFormat("it", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
      (bytes("pyodide") + bytes("drawing")) / 1e6,
    );
    const openPython = () =>
      page.evaluate(() => {
        location.hash = "/tools/python";
      });
    // The Python page asks for every pack, and the job waits. The page shows it as on its way, with Annulla, and offers
    // no second download.
    await openPython();
    await page.getByRole("button", { name: `Scarica Python (${all} MB)` }).click();
    await expect.poll(jobStates).toEqual(["queued"]);
    await expect(page.getByRole("button", { name: "Annulla", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Scarica/ })).toHaveCount(0);
    await saveShot(page, "settings/it-light-queued-python.png");
    // Settings shows both rows as waiting, each with its Annulla, and offers no download either.
    await openPacks(page);
    await expect(python).toHaveAttribute("data-phase", "downloading");
    await expect(drawings).toHaveAttribute("data-phase", "downloading");
    await expect(python.getByRole("button", { name: /^Scarica/ })).toHaveCount(0);
    await expect(drawings.getByRole("button", { name: "Annulla", exact: true })).toBeVisible();
    await saveShot(page, "settings/it-light-queued.png");
    // Annulla on a row ends the queued job, and both rows offer their downloads again.
    await python.getByRole("button", { name: "Annulla", exact: true }).click();
    await expect.poll(jobStates).toEqual(["cancelled"]);
    await expect(python).toHaveAttribute("data-phase", "idle");
    await expect(drawings).toHaveAttribute("data-phase", "idle");
    // The Python page ends one the same way.
    await openPython();
    await page.getByRole("button", { name: `Scarica Python (${all} MB)` }).click();
    await expect.poll(jobStates).toEqual(["queued"]);
    await page.getByRole("button", { name: "Annulla", exact: true }).click();
    await expect.poll(jobStates).toEqual(["cancelled"]);
    await expect(page.getByRole("button", { name: `Scarica Python (${all} MB)` })).toBeVisible();
    // A row's own download waits and is stopped the same way.
    await openPacks(page);
    await drawings.getByRole("button", { name: /^Scarica i disegni/ }).click();
    await expect(drawings).toHaveAttribute("data-phase", "downloading");
    await drawings.getByRole("button", { name: "Annulla", exact: true }).click();
    await expect(drawings).toHaveAttribute("data-phase", "idle");
    expect(server.requests).toEqual([]);
    expect((await runtimeStatus(page)).packs).toEqual({ pyodide: "idle", drawing: "idle" });
  } finally {
    await finish(setup);
  }
});

test("each row's menu opens on the dots, on a right-click and from the keyboard, holds only its removal, and removal asks first", async () => {
  test.skip(!pinned(), "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.");
  test.setTimeout(120000);
  const setup = await start({ stage: ["pyodide", "drawing"] });
  const { page, userData } = setup;
  try {
    await expect(row(page, "pyodide").getByText(`${sized(bytes("pyodide"))} sul disco.`)).toBeVisible();
    for (const how of ["dots", "right-click", "keyboard"] as const) {
      const menu = await openMenu(page, "drawing", how);
      await expect(menu.getByRole("menuitem")).toHaveText(["Rimuovi i disegni"]);
      if (how === "dots") await saveShot(page, "settings/it-light-menu.png");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
    // One dialog asks, and Annulla leaves everything as it was.
    let menu = await openMenu(page, "drawing", "dots");
    await clickSettled(page, menu.getByRole("menuitem", { name: "Rimuovi i disegni" }));
    const dialog = page.getByRole("dialog", { name: "Rimuovere i disegni?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("e con loro i circuiti");
    await saveShot(page, "settings/it-light-remove.png");
    await clickSettled(page, dialog.getByRole("button", { name: "Annulla" }));
    await expect(dialog).toHaveCount(0);
    expect(existsSync(packFolder(userData, "drawing"))).toBe(true);
    await expect(row(page, "drawing")).toHaveAttribute("data-phase", "ready");

    // Confirmed: the files go and the row offers the download again, at once; Python is not touched.
    menu = await openMenu(page, "drawing", "right-click");
    await clickSettled(page, menu.getByRole("menuitem", { name: "Rimuovi i disegni" }));
    await clickSettled(
      page,
      page.getByRole("dialog", { name: "Rimuovere i disegni?" }).getByRole("button", { name: "Rimuovi", exact: true }),
    );
    await expect(row(page, "drawing").getByRole("button", { name: /^Scarica i disegni/ })).toBeVisible({ timeout: 30000 });
    expect(existsSync(join(userData, "workspace/runtimes/drawing"))).toBe(false);
    expect(existsSync(packFolder(userData, "pyodide"))).toBe(true);
    expect((await runtimeStatus(page)).packs).toEqual({ pyodide: "ready", drawing: "idle" });
    await expect(row(page, "drawing").getByText("Con Python disegna anche i circuiti.")).toBeVisible();

    // Python the same way, and it says what stops working.
    menu = await openMenu(page, "pyodide", "dots");
    await clickSettled(page, menu.getByRole("menuitem", { name: "Rimuovi Python" }));
    const python = page.getByRole("dialog", { name: "Rimuovere Python?" });
    await expect(python).toContainText("non si disegnano grafici e circuiti");
    await python.getByRole("button", { name: "Rimuovi", exact: true }).click();
    await expect(row(page, "pyodide").getByRole("button", { name: /^Scarica Python/ })).toBeVisible({ timeout: 30000 });
    expect(existsSync(join(userData, "workspace/runtimes/pyodide"))).toBe(false);
    await expect(row(page, "drawing").getByText("Senza Python disegna tutto tranne i circuiti.")).toBeVisible();
  } finally {
    await finish(setup);
  }
});

async function askFromPage(page: Page, text: string) {
  await page.evaluate(() => {
    location.hash = "/ask";
  });
  // The new chat's page, not the one that was open: a message typed before it replaces the page is lost.
  await expect(page).toHaveURL(/#\/ask$/);
  await expect(page.locator(".px-msg")).toHaveCount(0);
  const box = page.getByRole("textbox", { name: "Messaggio" });
  // The composer restores its own draft as the page settles, which can empty what was typed a moment before.
  await expect(async () => {
    await box.fill(text);
    expect(await box.innerText()).toContain(text);
  }).toPass();
  await box.press("Enter");
}

test("a graph is drawn with the drawings' pack alone after it is downloaded from Settings, and removing the pack stops new ones, not the ones made", async () => {
  test.skip(!pinned(), "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.");
  test.setTimeout(240000);
  const setup = await start({ env: { PYXIS_E2E_REPLY: graphReply } });
  const { page, userData } = setup;
  try {
    // Before the download an answer with a graph has no picture: the kind is not offered, and the block is dropped.
    const figures = page.locator(".px-msg figure.px-figure");
    await askFromPage(page, "Com'è fatto un automa?");
    await expect(page.getByText("Fine della risposta.")).toBeVisible({ timeout: 60000 });
    await expect(figures).toHaveCount(0);
    await expect(page.getByText("pyxis-")).toHaveCount(0);

    // Downloaded from Settings, with no Python at all.
    await openPacks(page);
    await row(page, "drawing").getByRole("button", { name: /^Scarica i disegni/ }).click();
    await expect(row(page, "drawing")).toHaveAttribute("data-phase", "ready", { timeout: 60000 });
    expect(existsSync(join(userData, "workspace/runtimes/pyodide"))).toBe(false);
    await askFromPage(page, "E se ne disegni un altro?");
    await expect(figures).toHaveCount(1, { timeout: 120000 });
    await expect(figures.getByRole("img")).toHaveAttribute("alt", /automa con tre stati/);
    await expect
      .poll(() => figures.getByRole("img").evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThanOrEqual(150);
    const chats = (await page.evaluate(() => window.pyxis.invoke("chats.list", {}))) as Array<{ id: string }>;
    const chatId = chats[0]!.id;

    // Removed: the picture already made stays with its answer, and a new answer has none.
    await openPacks(page);
    await row(page, "drawing").getByRole("button", { name: "Altro sui disegni" }).click();
    await clickSettled(page, page.getByRole("menuitem", { name: "Rimuovi i disegni" }));
    await clickSettled(page, page.getByRole("dialog").getByRole("button", { name: "Rimuovi", exact: true }));
    await expect(row(page, "drawing").getByRole("button", { name: /^Scarica i disegni/ })).toBeVisible({ timeout: 30000 });
    // A new answer has none, as before the download.
    await askFromPage(page, "Ancora uno?");
    await expect(page.getByText("Fine della risposta.")).toBeVisible({ timeout: 60000 });
    await expect(figures).toHaveCount(0);
    // And the answer that had one still shows it: the picture is stored with the text.
    await page.evaluate((id) => {
      location.hash = `/ask/${id}`;
    }, chatId);
    await expect(figures).toHaveCount(1);
    await expect(figures.getByRole("img")).toHaveAttribute("alt", /automa con tre stati/);
  } finally {
    await finish(setup);
  }
});

test("the rows are in English with the same states, and Settings keeps its column at 960 px with large text", async () => {
  test.skip(!pinned(), "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.");
  const setup = await start({ stage: ["drawing"] });
  const { page } = setup;
  try {
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    await page.setViewportSize({ width: 960, height: 900 });
    await page.evaluate(() =>
      window.pyxis.invoke("profile.save", { dyslexia: false, textSize: "lg" }),
    );
    await page.reload();
    await expect(page.getByRole("heading", { name: "Drawings and Python" })).toBeVisible();
    const python = row(page, "pyodide");
    const drawings = row(page, "drawing");
    await expect(python.getByText("To do the calculations in answers, run your own code and draw plots and circuits.")).toBeVisible();
    await expect(python.getByRole("button", { name: `Download Python (${sized(bytes("pyodide"), "en")})` })).toBeVisible();
    await expect(python.getByText("Downloaded once from jsDelivr, only when you ask. Nothing about you is sent.")).toBeVisible();
    await expect(drawings.getByText("Without Python it draws everything except circuits.")).toBeVisible();
    await expect(drawings.getByText(`${sized(bytes("drawing"), "en")} on disk · version ${manifest("drawing").version}.`)).toBeVisible();
    await expect(drawings.getByRole("button", { name: "More about the drawings" })).toBeVisible();
    // Nothing leaves the window sideways, and the rows keep to the card.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    for (const target of [python, drawings]) {
      const box = (await target.boundingBox())!;
      for (const inner of await target.locator("button, .px-ctl-text").all()) {
        const rect = (await inner.boundingBox())!;
        expect(rect.x + rect.width, "inside the row").toBeLessThanOrEqual(box.x + box.width + 1);
      }
    }
    await expectNoAxeViolations(page);
  } finally {
    await finish(setup);
  }
});

/**
 * For the screenshots only: the page in each theme, language and width, which are read against the drawing. `after` runs
 * once the page is there, to open what the picture shows (a menu, a dialog).
 */
async function shoot(page: Page, name: string, after?: () => Promise<void>) {
  for (const [language, width] of [
    ["it", 1280],
    ["en", 1280],
    ["it", 960],
    ["en", 960],
  ] as const)
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(
        async ({ language, theme }) => {
          localStorage.setItem("pyxis.lang", language);
          await window.pyxis.setAppearance(theme);
        },
        { language, theme },
      );
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await expect(page.getByRole("heading", { name: /^(Disegni e Python|Drawings and Python)$/ })).toBeVisible();
      await page.waitForTimeout(400);
      await after?.();
      await saveShot(page, `settings/${name}-${language}-${theme}-${width}.png`);
      if (after) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
      }
    }
}

test("pictures of every state of the rows", async () => {
  test.skip(!SHOTS, "Pictures are kept only when PYXIS_SHOTS names a folder.");
  test.skip(!pinned(), "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.");
  test.setTimeout(900000);
  const setup = await start();
  const { page, server, userData } = setup;
  const drawings = row(page, "drawing");
  const python = row(page, "pyodide");
  const [, library] = manifest("drawing").files;
  const menuOf = (pack: "pyodide" | "drawing") => async () => {
    await row(page, pack)
      .getByRole("button", { name: /^(Altro su Python|Altro sui disegni|More about Python|More about the drawings)$/ })
      .click();
    await expect(page.getByRole("menu")).toBeVisible();
  };
  const startDownload = (target: typeof drawings) =>
    target.getByRole("button", { name: /^(Scarica|Download)/ }).click();
  try {
    await shoot(page, "nothing");

    // The drawings part of the way, held; Annulla puts it back.
    server.hold.add(library!.name);
    await startDownload(drawings);
    await expect(drawings.locator(".px-pack-stat")).toBeVisible({ timeout: 30000 });
    await shoot(page, "downloading");
    await drawings.getByRole("button", { name: /^(Annulla|Cancel)$/ }).click();
    await expect(drawings).toHaveAttribute("data-phase", "idle", { timeout: 30000 });
    server.hold.clear();

    // Stopped by a failing server.
    server.fail.add(library!.name);
    await openPacks(page);
    await startDownload(drawings);
    await expect(drawings).toHaveAttribute("data-phase", "failed", { timeout: 30000 });
    await shoot(page, "failed");
    server.fail.clear();

    // The drawings alone, then with the menu open.
    await openPacks(page);
    await drawings.getByRole("button", { name: /^(Riprova|Try again)$/ }).click();
    await expect(drawings).toHaveAttribute("data-phase", "ready", { timeout: 60000 });
    await shoot(page, "drawings");
    await shoot(page, "menu", menuOf("drawing"));
    await shoot(page, "remove", async () => {
      await menuOf("drawing")();
      await clickSettled(page, page.getByRole("menuitem"));
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(400);
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Both.
    await openPacks(page);
    await startDownload(python);
    await expect(python).toHaveAttribute("data-phase", "ready", { timeout: 120000 });
    await shoot(page, "both");

    // Python alone.
    await openPacks(page);
    await row(page, "drawing").getByRole("button", { name: /^(Altro sui disegni|More about the drawings)$/ }).click();
    await clickSettled(page, page.getByRole("menuitem"));
    await clickSettled(page, page.getByRole("dialog").getByRole("button", { name: /^(Rimuovi|Remove)$/ }));
    await expect(drawings).toHaveAttribute("data-phase", "idle", { timeout: 30000 });
    await shoot(page, "python");

    // An older pack of the drawings, offered as an update.
    for (const pack of ["pyodide", "drawing"] as const)
      await page.evaluate((pack) => window.pyxis.invoke("tools.runtimeRemove", { pack }), pack);
    const older = join(userData, "workspace/runtimes/drawing/1");
    mkdirSync(older, { recursive: true });
    writeFileSync(join(older, "graphviz.js"), "old");
    await openPacks(page);
    await shoot(page, "update");
    await shoot(page, "update-menu", menuOf("drawing"));
  } finally {
    await finish(setup);
  }
});
