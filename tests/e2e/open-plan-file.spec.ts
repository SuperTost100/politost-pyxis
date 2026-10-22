import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(process.cwd(), "out/main/index.js");
// Set PYXIS_SHOTS to a folder to keep screenshots of the import review in both themes.
const SHOTS = process.env["PYXIS_SHOTS"];

const plan = (title: string, extra: object = {}) =>
  JSON.stringify({
    version: 2,
    id: `plan-${title}`,
    createdAt: 1_760_000_000_000,
    title,
    topics: [{ id: "t", title: "Moti", position: 0 }],
    nodes: [],
    cards: [{ front: "$v$", back: "Velocità", topic: 0 }],
    ...extra,
  });

async function start(args: string[]) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-open-plan-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN, ...args], env });
  const page = await app.firstWindow();
  return { app, page, userData };
}

async function skipSetup(page: Page) {
  await page.getByRole("button", { name: "Salta" }).click();
  await expect(page).toHaveURL(/#\/exams/);
}

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const width of [1280, 640])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((source) => window.pyxis.setAppearance(source), theme);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `${name}-${width}-${theme}.png`), fullPage: true });
    }
}

test("a plan file named on the command line opens the import review once setup is done", async () => {
  test.setTimeout(120000);
  const dir = mkdtempSync(join(tmpdir(), "pyxis-open-plan-file-"));
  const file = join(dir, "Fisica prestata.pyxis");
  writeFileSync(file, plan("Fisica prestata"));
  const { app, page, userData } = await start([file]);
  try {
    // Onboarding blocks the jump; the file waits.
    await skipSetup(page);
    await expect(page).toHaveURL(/#\/exams\/get$/);
    await expect(page.locator(".px-import-review")).toContainText("Fisica prestata");
    await page.getByRole("button", { name: "Importa", exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\//);

    // Open With on macOS, and a second launch elsewhere, hand the same file over again.
    await app.evaluate(({ app: electron }, path) => {
      electron.emit("open-file", { preventDefault() {} }, path);
    }, file);
    await expect(page.locator(".px-import-review")).toContainText("Fisica prestata");
    // The same file imported before: the date and the choice to import a copy anyway.
    await expect(page.locator(".px-import-review .px-notice")).toContainText("Già importato il");
    await expect(page.getByRole("button", { name: "Importa una copia lo stesso" })).toBeVisible();
    await shoot(page, "duplicate");
    await page.getByRole("button", { name: "Importa una copia lo stesso" }).click();
    await expect(page).toHaveURL(/#\/plans\//);
    const plans = await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    expect(plans.filter((p: { title: string }) => p.title === "Fisica prestata")).toHaveLength(2);

    const second = join(dir, "Analisi.pyxis");
    writeFileSync(second, plan("Analisi"));
    await app.evaluate(({ app: electron }, path) => {
      electron.emit("second-instance", {}, ["/usr/bin/pyxis", path], "/");
    }, second);
    await expect(page.locator(".px-import-review")).toContainText("Analisi");
    await expect(page.locator(".px-import-review .px-notice")).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main refuses a name or type that is not a plan file, and the renderer cannot choose a path", async () => {
  test.setTimeout(120000);
  const dir = mkdtempSync(join(tmpdir(), "pyxis-open-plan-file-"));
  const { app, page, userData } = await start([]);
  try {
    await skipSetup(page);
    // The bridge takes no argument: there is no way to ask main for a path.
    expect(await page.evaluate(() => window.pyxis.openedPlan.take.length)).toBe(0);
    expect(await page.evaluate(() => window.pyxis.openedPlan.take())).toBeNull();
    const text = join(dir, "notes.txt");
    writeFileSync(text, "{}");
    await app.evaluate(({ app: electron }, path) => {
      electron.emit("open-file", { preventDefault() {} }, path);
    }, text);
    expect(await page.evaluate(() => window.pyxis.openedPlan.take())).toBeNull();
    const folder = join(dir, "folder.pyxis");
    mkdirSync(folder);
    await app.evaluate(({ app: electron }, path) => {
      electron.emit("open-file", { preventDefault() {} }, path);
    }, folder);
    await expect(page.getByText("Quel file non è un piano di Pyxis.")).toBeVisible();
    await expect(page.locator(".px-import-review")).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .pyxis file dropped on the window opens the import review, and other drops do nothing", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await start([]);
  try {
    await skipSetup(page);
    const drop = (name: string, content: string) =>
      page.evaluate(
        ({ name, content }) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([content], name));
          const over = new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true });
          document.body.dispatchEvent(over);
          document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
          return over.defaultPrevented;
        },
        { name, content },
      );
    await drop("notes.txt", "{}");
    await expect(page).toHaveURL(/#\/exams$/);
    expect(await drop("Dropped.pyxis", plan("Dropped"))).toBe(true);
    await expect(page).toHaveURL(/#\/exams\/get$/);
    await expect(page.locator(".px-import-review")).toContainText("Dropped");
    // A file that is not a plan says why instead of failing silently.
    await drop("Broken.pyxis", "not json");
    await expect(page.getByText("Questo file non è un piano di Pyxis.")).toBeVisible();
    await drop("Newer.pyxis", JSON.stringify({ version: 9, title: "x", topics: [], nodes: [], cards: [] }));
    await expect(page.getByText(/versione più recente di Pyxis/)).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a plan with broken exercises names the problem and imports the rest", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await start([]);
  try {
    await skipSetup(page);
    await page.goto(page.url().replace(/#.*$/, "#/exams/get"));
    // The page loads on its first visit; until then the previous page and its own file input are still there.
    await expect(page.getByRole("heading", { level: 1, name: "Apri un piano condiviso" })).toBeVisible();
    const broken = plan("Con esercizi rotti", {
      exercises: [
        {
          id: "e1",
          sourceId: null,
          passageId: "nowhere",
          prompt: "Quanto vale?",
          answer: "2",
          locator: { kind: "generated", topicId: "t" },
          grounding: "general",
        },
      ],
    });
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "rotto.pyxis",
      mimeType: "application/json",
      buffer: Buffer.from(broken),
    });
    await expect(page.locator(".px-import-review")).toBeVisible();
    await page.getByRole("button", { name: "Importa", exact: true }).click();
    const notice = page.locator(".px-import-review .px-notice");
    await expect(notice).toContainText("Nel file manca un brano citato dal piano.");
    await expect(notice).toContainText("Il problema è solo negli esercizi");
    expect(await page.evaluate(() => window.pyxis.invoke("plans.list", {}))).toHaveLength(0);
    await shoot(page, "partial");
    await page.getByRole("button", { name: "Importa il resto" }).click();
    await expect(page).toHaveURL(/#\/plans\//);
    const plans = await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    expect(plans.map((p: { title: string }) => p.title)).toEqual(["Con esercizi rotti"]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a plan broken outside the exercises and maps offers nothing to leave out", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await start([]);
  try {
    await skipSetup(page);
    await page.goto(page.url().replace(/#.*$/, "#/exams/get"));
    // The page loads on its first visit; until then the previous page and its own file input are still there.
    await expect(page.getByRole("heading", { level: 1, name: "Apri un piano condiviso" })).toBeVisible();
    const broken = plan("Senza argomento", {
      nodes: [{ title: "Passo", kind: "learn", position: 0, topic: 7 }],
    });
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "rotto.pyxis",
      mimeType: "application/json",
      buffer: Buffer.from(broken),
    });
    await page.getByRole("button", { name: "Importa", exact: true }).click();
    const notice = page.locator(".px-import-review .px-notice");
    await expect(notice).toContainText("rimanda a un argomento che non c'è nel file");
    await expect(page.getByRole("button", { name: "Importa il resto" })).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
