import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis, setUp } from "./app-under-test";
import { animationsSettled } from "./settled";
import { SHOTS, saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { putBlob } from "../../src/core/blobs";
import { seedSource } from "./seed";


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
  const app = await launchPyxis({ userData, args });
  return setUp(app, userData, async () => {
    const page = await app.firstWindow();
    return { app, page, userData };
  });
}

async function skipSetup(page: Page) {
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
}

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1280, 640])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((source) => window.pyxis.setAppearance(source), theme);
      await animationsSettled(page);
      await saveShot(page, `${name}-${width}-${theme}.png`, { fullPage: true });
    }
}

test("a plan file named on the command line opens the import review once setup is done", async () => {
  test.setTimeout(120000);
  const dir = mkdtempSync(join(tmpdir(), "pyxis-open-plan-file-"));
  const file = join(dir, "Fisica prestata.pyxis");
  writeFileSync(file, plan("Fisica prestata"));
  const { app, page, userData } = await start([file]);
  try {
    // Onboarding blocks the jump; the file waits. Setup ends on Chiedi and the file opens from there, so the window is not
    // sent to Esami in between: a click on the sidebar that lands after the file's jump would leave the review.
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams\/get$/);
    await expect(page.locator(".px-import-review")).toContainText("Fisica prestata");
    await page.getByRole("button", { name: "Aggiungi ai miei esami", exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\//);

    // Open With on macOS, and a second launch elsewhere, hand the same file over again.
    await app.evaluate(({ app: electron }, path) => {
      electron.emit("open-file", { preventDefault() {} }, path);
    }, file);
    await expect(page.locator(".px-import-review")).toContainText("Fisica prestata");
    // The same file imported before: the date and the choice to import a copy anyway.
    await expect(page.locator(".px-import-review .px-notice")).toContainText("Già importato il");
    await expect(page.getByRole("button", { name: "Aggiungi una copia lo stesso" })).toBeVisible();
    await shoot(page, "duplicate");
    await page.getByRole("button", { name: "Aggiungi una copia lo stesso" }).click();
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
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an import still under way when the student goes back finishes without taking them to the imported exam", async () => {
  test.setTimeout(120000);
  const dir = mkdtempSync(join(tmpdir(), "pyxis-open-plan-file-"));
  const file = join(dir, "Fisica prestata.pyxis");
  writeFileSync(file, plan("Fisica prestata"));
  const userData = mkdtempSync(join(tmpdir(), "pyxis-open-plan-"));
  // The core holds the import back, so the student can go back while it is under way.
  const app = await launchPyxis({ userData, args: [file], env: { PYXIS_E2E_READ_DELAY: "plans.import=2500" } });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams\/get$/);
    await page.getByRole("button", { name: "Aggiungi ai miei esami", exact: true }).click();
    await page.getByRole("button", { name: /^Torna a / }).click();
    await expect(page).toHaveURL(/#\/(exams|ask)$/);
    const where = await page.evaluate(() => location.hash);
    // The import ends while the student is elsewhere: the exam is made, and the window stays where they went.
    await expect
      .poll(() => page.evaluate(() => window.pyxis.invoke("plans.list", {}).then((plans) => plans.length)))
      .toBe(1);
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    expect(await page.evaluate(() => location.hash)).toBe(where);
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    await expect(page.locator("a.px-exams-row", { hasText: "Fisica prestata" })).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
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
    await expect(page.getByText("Quel file non è un esame di Pyxis.")).toBeVisible();
    await expect(page.locator(".px-import-review")).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
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
    await expect(page.getByText("Questo file non è un esame di Pyxis.")).toBeVisible();
    await drop("Newer.pyxis", JSON.stringify({ version: 9, title: "x", topics: [], nodes: [], cards: [] }));
    await expect(page.getByText(/versione più recente di Pyxis/)).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a plan with broken exercises names the problem and imports the rest", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await start([]);
  try {
    await skipSetup(page);
    await page.goto(page.url().replace(/#.*$/, "#/exams/get"));
    // The page loads on its first visit; until then the previous page and its own file input are still there.
    await expect(page.getByRole("heading", { level: 1, name: "Apri un esame condiviso" })).toBeVisible();
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
    await page.getByRole("button", { name: "Aggiungi ai miei esami", exact: true }).click();
    const notice = page.locator(".px-import-review .px-notice");
    await expect(notice).toContainText("Nel file manca un brano citato dall'esame.");
    await expect(notice).toContainText("Il problema è solo negli esercizi");
    expect(await page.evaluate(() => window.pyxis.invoke("plans.list", {}))).toHaveLength(0);
    await shoot(page, "partial");
    await page.getByRole("button", { name: "Importa il resto" }).click();
    await expect(page).toHaveURL(/#\/plans\//);
    const plans = await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    expect(plans.map((p: { title: string }) => p.title)).toEqual(["Con esercizi rotti"]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a plan broken outside the exercises and maps offers nothing to leave out", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await start([]);
  try {
    await skipSetup(page);
    await page.goto(page.url().replace(/#.*$/, "#/exams/get"));
    // The page loads on its first visit; until then the previous page and its own file input are still there.
    await expect(page.getByRole("heading", { level: 1, name: "Apri un esame condiviso" })).toBeVisible();
    const broken = plan("Senza argomento", {
      nodes: [{ title: "Passo", kind: "learn", position: 0, topic: 7 }],
    });
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "rotto.pyxis",
      mimeType: "application/json",
      buffer: Buffer.from(broken),
    });
    await page.getByRole("button", { name: "Aggiungi ai miei esami", exact: true }).click();
    const notice = page.locator(".px-import-review .px-notice");
    await expect(notice).toContainText("rimanda a un argomento che non c'è nel file");
    await expect(page.getByRole("button", { name: "Importa il resto" })).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

const HELLO_SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const OTHER_SHA = "a".repeat(64);
const day = Date.UTC(2027, 1, 2, 12);
const lesson = (id: string, topic: number) => ({
  id,
  topic,
  kind: "lesson",
  body: { markdown: "Testo" },
  passageIds: [],
  grounding: null,
  provider: null,
  model: null,
});

/** An exam as a student would share it: a path, what comes with it, an exam day, one original inside and one not. */
const shared = (title: string, extra: object = {}) =>
  plan(title, {
    author: "Marco Bianchi",
    topics: [
      { id: "t0", title: "Successioni e serie di funzioni", position: 0 },
      { id: "t1", title: "Funzioni di più variabili", position: 1 },
      { id: "t2", title: "Formula di Taylor", position: 2 },
    ],
    cards: [
      { front: "a", back: "b", topic: 0 },
      { front: "c", back: "d", topic: 0 },
      { front: "e", back: "f", topic: 1 },
    ],
    items: [
      lesson("l0", 0),
      lesson("l1", 0),
      { ...lesson("q0", 0), kind: "quiz", body: { questions: [] } },
      lesson("l2", 1),
    ],
    sessions: [{ date: day, time: "09:00", label: "Scritto" }],
    sources: [
      { id: "s1", title: "Dispensa del corso, 2026", sha: HELLO_SHA, bytes: 5, data: Buffer.from("hello").toString("base64") },
      { id: "s2", title: "Bramanti, Pagani, Salsa", sha: OTHER_SHA, bytes: 9 },
    ],
    ...extra,
  });

async function openReview(page: Page, name: string, text: string) {
  await page.goto(page.url().replace(/#.*$/, "#/exams/get"));
  await expect(page.getByRole("heading", { level: 1, name: /^(Apri un esame condiviso|Open a shared exam)$/ })).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(text),
  });
  await expect(page.locator(".px-import-review")).toBeVisible();
}

test("the review page shows the exam as it will be, holds it still while it is added, and ends on the exam", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-open-plan-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_READ_DELAY: "plans.import=3000" } });
  try {
    const page = await app.firstWindow();
    await skipSetup(page);
    const text = shared("Analisi Matematica 2");
    await openReview(page, "Analisi Matematica 2.pyxis", text);
    const review = page.locator(".px-import-review");
    // The page opens on its title, so a screen reader starts there.
    await expect(page.getByRole("heading", { level: 1, name: "Analisi Matematica 2" })).toBeFocused();
    // The file's name and size, who shared it, the exam day.
    await expect(review.locator(".px-import-file")).toContainText("Analisi Matematica 2.pyxis · ");
    await expect(review.locator(".px-import-file")).toContainText(/\d+(,\d+)? (B|kB|MB)/);
    await expect(review.locator(".px-exam-date")).toContainText("Scritto martedì 2 febbraio 2027, ore 09:00");
    await expect(review.locator(".px-exam-date")).toContainText("condiviso da Marco Bianchi, il");
    // The path, with what the file holds for each topic, and the exam as its last step.
    const rows = review.getByRole("list", { name: "Percorso" }).getByRole("listitem");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("Successioni e serie di funzioni");
    await expect(rows.nth(0)).toContainText("2 lezioni · quiz · 2 flashcard");
    await expect(rows.nth(1)).toContainText("1 lezione · 1 flashcard");
    await expect(rows.nth(2)).not.toContainText("lezion");
    await expect(rows.nth(3)).toContainText("Scritto");
    // What comes with the file, and the material: one inside the file, one that is nowhere.
    const arrive = review.getByRole("region", { name: "Con il file arrivano" });
    await expect(arrive).toContainText("3 lezioni");
    await expect(arrive).toContainText("3 flashcard");
    await expect(arrive).toContainText("Senza i progressi di Marco Bianchi: parti da zero.");
    const material = review.getByRole("region", { name: /^Materiale/ });
    await expect(material).toContainText("2 fonti");
    await expect(material.getByRole("group", { name: "Dispensa del corso, 2026" })).toContainText("Nel file · 5 byte · resta con l'esame");
    const missing = material.getByRole("group", { name: "Bramanti, Pagani, Salsa" });
    await expect(missing).toContainText("Non è nel file");
    await expect(missing.getByRole("combobox", { name: "Che cosa fare con Bramanti, Pagani, Salsa" })).toBeVisible();
    // The footer says what adding does, and its action is a named region the keyboard reaches.
    const footer = page.getByRole("region", { name: "Aggiungere l'esame" });
    await expect(footer).toContainText("Nasce un esame nuovo. Quelli che hai già non cambiano.");
    await expect(footer.getByRole("button", { name: "Annulla" })).toBeEnabled();
    const add = footer.getByRole("button", { name: "Aggiungi ai miei esami", exact: true });
    await add.focus();
    await page.keyboard.press("Enter");
    // While it is added: the work shows in the footer, the path is held still and nothing else can be started.
    await expect(footer.getByRole("status")).toContainText("Aggiungo l'esame…");
    await expect(footer.getByRole("button", { name: "Annulla" })).toBeDisabled();
    await expect(review.locator(".px-xpath-list")).toHaveClass(/is-adding/);
    await expect(missing.getByRole("combobox")).toBeDisabled();
    // Afterwards the page is the exam itself, marked as imported.
    await expect(page).toHaveURL(/#\/plans\//);
    await expect(page.getByRole("heading", { level: 1, name: "Analisi Matematica 2" })).toBeVisible();
    await expect(page.getByText("Esame importato")).toBeVisible();
    const plans = await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    expect(plans).toHaveLength(1);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("an original that is not in the file waits for a choice, and a library copy is offered when there is one", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await start([]);
  try {
    await skipSetup(page);
    // The Library holds a copy of "hello", as a student who added the file themselves would have it.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seedSource(db, { id: "lib-dispensa", title: "Dispensa del corso, 2026", kind: "pdf" });
    db.prepare("UPDATE sources SET blob_sha = ?, mime = 'application/pdf' WHERE id = 'lib-dispensa'").run(
      putBlob(join(userData, "workspace"), Buffer.from("hello"), "application/pdf", "pdf"),
    );
    db.close();
    await page.reload();
    const second = shared("Seconda", {
      id: "plan-seconda",
      sources: [{ id: "s1", title: "Dispensa del corso, 2026", sha: HELLO_SHA, bytes: 5 }],
    });
    await openReview(page, "Seconda.pyxis", second);
    const review = page.locator(".px-import-review");
    const source = review.getByRole("group", { name: "Dispensa del corso, 2026" });
    await expect(source).toContainText("Non è nel file, ma ce l'hai in Libreria");
    await expect(source.locator(".ant-select")).toContainText("Usa la copia nella mia Libreria");
    await expect(review.getByRole("button", { name: "Aggiungi ai miei esami", exact: true })).toBeEnabled();
    // Choosing the file on the computer blocks adding until a matching file is given.
    await source.getByRole("combobox").click();
    await page.getByTitle("Cerca il file su questo computer").click();
    const add = review.getByRole("button", { name: "Aggiungi ai miei esami", exact: true });
    await expect(add).toBeDisabled();
    const pick = async (content: string) => {
      const chooser = page.waitForEvent("filechooser");
      await source.getByRole("button", { name: "Scegli il file" }).click();
      await (await chooser).setFiles({ name: "dispensa.pdf", mimeType: "application/pdf", buffer: Buffer.from(content) });
    };
    await pick("hellp");
    await expect(source.getByText("Questo file non è quello atteso dall'esame")).toBeVisible();
    await expect(add).toBeDisabled();
    await pick("hello");
    await expect(source.getByText("Il file corrisponde.")).toBeVisible();
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page).toHaveURL(/#\/plans\//);
    expect(await page.evaluate(() => window.pyxis.invoke("plans.list", {}))).toHaveLength(1);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a damaged file, a file from a newer version and a file that is no plan each say so on the page that opens them", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await start([]);
  try {
    await skipSetup(page);
    const drop = (name: string, content: string) =>
      page.evaluate(
        ({ name, content }) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([content], name));
          document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
        },
        { name, content },
      );
    await drop("Rotto.pyxis", JSON.stringify({ version: 2, title: 4, topics: [], nodes: [], cards: [] }));
    await expect(page.getByText("Il file è danneggiato o incompleto")).toBeVisible();
    await expect(page.locator(".px-import-review")).toHaveCount(0);
    await drop("Nuovo.pyxis", JSON.stringify({ version: 9, title: "x", topics: [], nodes: [], cards: [] }));
    await expect(page.getByText(/versione più recente di Pyxis/)).toBeVisible();
    await drop("Niente.pyxis", "not json");
    await expect(page.getByText("Questo file non è un esame di Pyxis.")).toBeVisible();
    // A good file after them opens the page, and the notices of the opener are gone.
    await drop("Buono.pyxis", shared("Buono"));
    await expect(page.locator(".px-import-review")).toContainText("Buono");
    // Annulla goes back to where the file was opened from, and nothing was added.
    await page.getByRole("button", { name: "Annulla" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    expect(await page.evaluate(() => window.pyxis.invoke("plans.list", {}))).toHaveLength(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("text in a file is shown as text, and very long values wrap inside the page", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await start([]);
  try {
    await skipSetup(page);
    const markup = '<img src="x" onerror="window.pwned=1"><script>window.pwned=2</script>';
    const long = "W".repeat(480);
    const text = shared(long, {
      id: "plan-hostile",
      author: markup + "A".repeat(100),
      topics: [
        { id: "t0", title: markup, position: 0 },
        { id: "t1", title: long, position: 1 },
        { id: "t2", title: "U".repeat(300) + " " + "V".repeat(180), position: 2 },
      ],
      sessions: [{ date: day, time: "09:00", label: "S".repeat(80), place: "P".repeat(100) }],
      sources: [
        { id: "s1", title: markup, sha: HELLO_SHA, bytes: 5, data: Buffer.from("hello").toString("base64") },
        { id: "s2", title: long, sha: OTHER_SHA, bytes: 9 },
      ],
    });
    await openReview(page, `${markup}${"N".repeat(150)}.pyxis`, text);
    const review = page.locator(".px-import-review");
    await expect(review.getByRole("heading", { level: 1 })).toHaveText(long);
    // The markup is on the page as characters, and nothing in it ran or was made into an element.
    await expect(review.locator(".px-exam-date")).toContainText("<img");
    await expect(review.locator(".px-import-file")).toContainText("<script>");
    await expect(review.locator("img, script")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    // Nothing is wider than the window, and the action is on screen without scrolling sideways.
    for (const width of [1280, 960, 640]) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await page.evaluate(() => {
        const wide = [...document.querySelectorAll<HTMLElement>(".px-import-review *")].filter(
          (el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1,
        );
        return {
          scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          wide: wide.map((el) => el.className || el.tagName).slice(0, 5),
        };
      });
      expect(overflow, `${width}px`).toEqual({ scroll: 0, wide: [] });
      await expect(page.getByRole("button", { name: "Aggiungi ai miei esami", exact: true })).toBeInViewport();
    }
    await shoot(page, "import-hostile");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("pictures of the import page in both languages, for the folder PYXIS_SHOTS names", async () => {
  test.skip(!SHOTS, "pictures are saved only when PYXIS_SHOTS names a folder");
  test.setTimeout(240000);
  const sizes = [1280, 960];
  for (const language of ["it", "en"] as const) {
    const userData = mkdtempSync(join(tmpdir(), "pyxis-open-plan-"));
    const app = await launchPyxis({ userData, env: { PYXIS_E2E_READ_DELAY: "plans.import=20000" } });
    try {
      const page = await app.firstWindow();
      await skipSetup(page);
      await page.evaluate((lang) => localStorage.setItem("pyxis.lang", lang), language);
      await page.reload();
      const picture = async (state: string) => {
        for (const width of sizes)
          for (const theme of ["light", "dark"] as const) {
            await page.setViewportSize({ width, height: 800 });
            await page.evaluate((source) => window.pyxis.setAppearance(source), theme);
            await animationsSettled(page);
            await saveShot(page, `import-${state}-${language}-${theme}-${width}.png`, { fullPage: true });
          }
      };
      await openReview(page, "Analisi Matematica 2.pyxis", shared("Analisi Matematica 2"));
      await picture("1-before");
      await page.locator(".px-import-foot .ant-btn-primary").click();
      await expect(page.locator(".px-import-foot [role=status]")).toBeVisible();
      await picture("2-working");
      await expect(page).toHaveURL(/#\/plans\//, { timeout: 60000 });
      await expect(page.locator(".px-exam-origin")).toBeVisible();
      await picture("3-after");
    } finally {
      await app.close();
      removeTestFolder(userData);
    }
  }
});

/** The ways back besides the control: Vai > Indietro (which ⌘[ and Alt+Left run), and the mouse's back button. */
const ways = {
  control: (page: Page) => page.getByRole("button", { name: /^Torna a / }).click(),
  menu: (page: Page, app: ElectronApplication) =>
    app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("back")?.click()),
  mouse: (page: Page) =>
    page.evaluate(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 3, bubbles: true, cancelable: true }))),
};
const forwards = {
  control: (page: Page) => page.goForward(),
  menu: (page: Page, app: ElectronApplication) =>
    app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("forward")?.click()),
  mouse: (page: Page) =>
    page.evaluate(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 4, bubbles: true, cancelable: true }))),
};
const add = (page: Page) => page.getByRole("button", { name: /^Aggiungi (ai miei esami|una copia lo stesso)$/ }).click();

test("after an import the exam's back control reads Esami and every way back leads there, and going forward does not reopen the review", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await start([]);
  try {
    await skipSetup(page);
    for (const way of ["control", "menu", "mouse"] as const) {
      // Opened from Esami's menu, the way a link or a chosen file is: the opener page, then the review, then the exam.
      await page.getByRole("button", { name: /^(Altro su Esami|More for Exams)$/ }).click();
      await page.getByRole("menuitem", { name: "Importa da un link" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Apri un esame condiviso" })).toBeVisible();
      await page.locator('input[type="file"]').first().setInputFiles({
        name: "Analisi.pyxis",
        mimeType: "application/json",
        buffer: Buffer.from(shared("Analisi")),
      });
      await expect(page.locator(".px-import-review")).toBeVisible();
      await add(page);
      await expect(page).toHaveURL(/#\/plans\/[^/]+$/);
      const exam = page.url();
      // The import page is a finished step: the control names Esami, not the page that made the exam.
      await expect(page.getByRole("button", { name: /^Torna a / })).toHaveText("Esami");
      await expect(page.getByRole("button", { name: "Torna a Esami" })).toBeVisible();
      await ways[way](page, app);
      await expect(page).toHaveURL(/#\/exams$/);
      // Forward returns to the exam, and the review is not behind or ahead of anything.
      await forwards[way](page, app);
      await expect(page).toHaveURL(exam);
      await expect(page.locator(".px-import-review")).toHaveCount(0);
      await ways[way](page, app);
      await expect(page).toHaveURL(/#\/exams$/);
      // One more step back from Esami goes to where Esami was opened (Chiedi), never to the review; Esami again is the
      // sidebar's row, as it was for the first round.
      await page.goBack();
      await expect(page).toHaveURL(/#\/ask$/);
      await fromChiediToExams(page);
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a file opened from outside leaves Esami as the way back from the exam it made, however the student goes back", async () => {
  test.setTimeout(180000);
  const dir = mkdtempSync(join(tmpdir(), "pyxis-open-plan-file-"));
  const file = join(dir, "Analisi.pyxis");
  writeFileSync(file, shared("Analisi"));
  const { app, page, userData } = await start([file]);
  try {
    await page.getByRole("button", { name: "Salta" }).click();
    for (const way of ["control", "menu", "mouse"] as const) {
      await expect(page).toHaveURL(/#\/exams\/get$/);
      await expect(page.locator(".px-import-review")).toBeVisible();
      await add(page);
      await expect(page).toHaveURL(/#\/plans\/[^/]+$/);
      await expect(page.getByRole("button", { name: /^Torna a / })).toHaveText("Esami");
      await ways[way](page, app);
      await expect(page).toHaveURL(/#\/exams$/);
      await expect(page.locator(".px-import-review")).toHaveCount(0);
      // The same file again, as a second launch or a drop would hand it over.
      await app.evaluate(({ app: electron }, path) => {
        electron.emit("second-instance", {}, ["/usr/bin/pyxis", path], "/");
      }, file);
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file picked in the dialog on Esami adds the exam and leaves the window on Esami, with no new entry in its history", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await start([]);
  try {
    await skipSetup(page);
    const entries = await page.evaluate(() => history.length);
    await page.getByRole("button", { name: /^(Altro su Esami|More for Exams)$/ }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Importa da un file .pyxis" }).click();
    await (await chooser).setFiles({ name: "Analisi.pyxis", mimeType: "application/json", buffer: Buffer.from(shared("Analisi")) });
    const dialog = page.getByRole("dialog", { name: "Importa un esame" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Aggiungi ai miei esami", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/#\/exams$/);
    expect(await page.evaluate(() => history.length)).toBe(entries);
    await expect(page.getByRole("button", { name: /^Torna a / })).toHaveCount(0);
    await expect(page.locator("a.px-exams-row", { hasText: "Analisi" })).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
