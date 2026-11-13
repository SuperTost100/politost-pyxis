import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { animationsSettled, atRest } from "./settled";
import { saveShot } from "./shots";

/** Two course folders, Polito › Fisica and Polito › Analisi, with a few notes each. */
function courses() {
  const base = join(mkdtempSync(join(tmpdir(), "pyxis-folders-")), "Polito");
  const put = (folder: string, name: string, text: string) => {
    mkdirSync(join(base, folder), { recursive: true });
    writeFileSync(join(base, folder, name), text);
  };
  put("Fisica", "Campo elettrico.txt", "Il campo elettrico di una carica puntiforme decresce con il quadrato della distanza.");
  put("Fisica", "Legge di Gauss.txt", "Il flusso del campo elettrico attraverso una superficie chiusa dipende dalla carica interna.");
  put("Fisica", "Temi d'esame.txt", "Esercizio 1. Calcola il campo di un filo carico.");
  put("Analisi", "Limiti.txt", "Il limite di sin x su x per x che tende a zero vale uno.");
  put("Analisi", "Derivate.txt", "La derivata di x al quadrato è due x.");
  return { base, fisica: join(base, "Fisica"), analisi: join(base, "Analisi") };
}

/** Every entry under `root` with its size and modification time, to show Pyxis changed nothing there. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const info = statSync(full);
      out.push(`${relative(root, full)} ${info.size} ${info.mtimeMs}`);
      if (info.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

/** Main answers the next folder picker with `paths`, as if the student had chosen them. */
async function answerPicker(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, answer) => {
    delete process.env["PYXIS_E2E_FILE"];
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: answer })) as typeof dialog.showOpenDialog;
  }, paths);
}

/** Links folders the way setup does, one subject each, through a picker that grants them. */
async function link(app: ElectronApplication, page: Page, paths: string[]) {
  await answerPicker(app, paths);
  await page.evaluate(async () => {
    const picked = await window.pyxis.showOpenDialog({ properties: ["openDirectory", "multiSelections"] });
    const linked = await window.pyxis.invoke("sources.linkFolders", { paths: picked ?? [], mode: "subject" });
    await window.pyxis.invoke("sources.confirmFolders", {
      folders: linked.folders.map((folder) => ({ folderId: folder.id, subjects: [] })),
    });
  });
}

type Listed = { id: string; title: string; status: string; linked: { folder: string } | null };
const listed = (page: Page) => page.evaluate(() => window.pyxis.invoke("sources.list", {})) as Promise<Listed[]>;
const allRead = (page: Page, count: number) =>
  expect
    .poll(async () => (await listed(page)).filter((source) => source.status === "ready").length, { timeout: 60000 })
    .toBe(count);

/** A label as the list shows it: the folder's parent and its own name. */
const label = (path: string) => `${basename(dirname(path))} › ${basename(path)}`;
const control = (page: Page) => page.getByRole("button", { name: /^\d+ cartell[ae] collegat[ae]/ });
const list = (page: Page) => page.getByRole("dialog", { name: "Cartelle collegate" });
const row = (page: Page, path: string) => list(page).getByRole("listitem").filter({ hasText: label(path) });
const dots = (page: Page, path: string) =>
  list(page).getByRole("button", { name: `Azioni sulla cartella ${label(path)}`, exact: true });
/** Opens the list from its control, unless it is open already. */
async function openList(page: Page) {
  if ((await control(page).getAttribute("aria-expanded")) !== "true") await control(page).click();
  await expect(list(page)).toBeVisible();
}
const shelf = (page: Page, subject: string) =>
  page.getByRole("region", { name: new RegExp(`^${subject} (\\d+ file|nessun file)$`) });
const status = (page: Page) => page.locator(".px-library-head [role=status]");

async function start(env: Record<string, string | undefined> = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-folders-user-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_FILE: undefined, ...env } });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Salta" }).click();
  return { userData, app, page };
}

test("The Library lists its linked folders, reads one again, finds one that moved, and unlinks one without touching the disk", async () => {
  test.setTimeout(240000);
  const { userData, app, page } = await start();
  const folders = courses();
  try {
    await link(app, page, [folders.fisica, folders.analisi]);
    await allRead(page, 5);
    // An answer cites a file of Fisica.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    const passage = db
      .prepare(
        "SELECT p.id FROM passages p JOIN sources s ON s.id = p.source_id WHERE s.title = 'Legge di Gauss' LIMIT 1",
      )
      .get() as { id: string };
    db.exec(`INSERT INTO chats(id,title,created_at,updated_at) VALUES('c-gauss','Legge di Gauss',1,2);
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('q1','c-gauss','user','Cosa dice la legge di Gauss?',1);`);
    db.prepare(
      "INSERT INTO messages(id,chat_id,role,body,grounding,created_at) VALUES('a1','c-gauss','assistant','Il flusso dipende dalla carica interna [P1].','sources',2)",
    ).run();
    db.prepare("INSERT INTO message_passages(message_id,passage_id,label) VALUES('a1',?,'P1')").run(passage.id);
    db.close();

    await page.evaluate(() => {
      location.hash = "/exams/library";
    });
    // One control in the head, opened from the keyboard: the list takes the focus and shows each folder.
    await expect(control(page)).toHaveText("2 cartelle collegate");
    await expect(page.getByText(/^Pyxis legge .* e non modifica niente\.$/)).toHaveCount(0);
    await control(page).focus();
    await page.keyboard.press("Enter");
    await expect(list(page)).toBeFocused();
    await expect(control(page)).toHaveAttribute("aria-expanded", "true");
    await expect(row(page, folders.fisica)).toContainText("3 file · controllata");
    await expect(row(page, folders.analisi)).toContainText("2 file · controllata");
    await expect(list(page)).toContainText("Pyxis legge i file dove sono e non li modifica.");
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "linked-folders-manage/1-list.png");
    // Escape closes one level at a time: the folder's menu, then the list, and the focus goes back each time.
    await dots(page, folders.fisica).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Rileggi adesso" })).toBeVisible();
    // Where the Escape lands, for a run that fails here.
    const focused = await page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.className ?? "nothing",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem")).toHaveCount(0);
    await expect(list(page), `Escape pressed with the focus on ${focused}`).toBeVisible();
    await expect(dots(page, folders.fisica)).toBeFocused();
    // A slow computer can take the Escape before the menu has taken the focus from the dots: it is the menu's all the same.
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Rileggi adesso" })).toBeVisible();
    await dots(page, folders.fisica).focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem")).toHaveCount(0);
    await expect(list(page)).toBeVisible();
    await expect(dots(page, folders.fisica)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(list(page)).toBeHidden();
    await expect(control(page)).toBeFocused();

    // Rileggi adesso reads a file added since, in this folder only.
    writeFileSync(join(folders.fisica, "Potenziale.txt"), "Il potenziale elettrico è il lavoro per unità di carica.");
    await openList(page);
    await dots(page, folders.fisica).click();
    await page.getByRole("menuitem", { name: "Rileggi adesso" }).click();
    await expect(status(page)).toHaveText(`Rileggo ${label(folders.fisica)}.`);
    await expect(row(page, folders.fisica)).toContainText("4 file · controllata", { timeout: 60000 });
    await expect(shelf(page, "Fisica").locator(".px-cover", { hasText: "Potenziale" })).toBeVisible();

    // Mostra nel Finder opens the folder the list names, through main, by its id. Main opens nothing for an id that is
    // not a linked folder's.
    await app.evaluate(({ shell }) => {
      (globalThis as { opened?: string[] }).opened = [];
      shell.openPath = (async (path: string) => {
        (globalThis as { opened?: string[] }).opened!.push(path);
        return "";
      }) as typeof shell.openPath;
    });
    await dots(page, folders.analisi).click();
    await page.getByRole("menuitem", { name: /^Mostra (nel Finder|in Esplora file|nel gestore dei file)$/ }).click();
    expect(await page.evaluate(() => window.pyxis.revealLinkedFolder("not-a-folder"))).toBe(false);
    // Pyxis keeps a folder by its real path, so a temporary folder behind a link (macOS's /var is /private/var) opens there.
    expect(await app.evaluate(() => (globalThis as { opened?: string[] }).opened)).toEqual([realpathSync(folders.analisi)]);

    // A folder renamed on disk: the list says so, and Trova la cartella… points it at where it went.
    const moved = join(folders.base, "Analisi 1");
    renameSync(folders.analisi, moved);
    await openList(page);
    await dots(page, folders.analisi).click();
    await page.getByRole("menuitem", { name: "Rileggi adesso" }).click();
    await expect(row(page, folders.analisi)).toContainText("Non la trovo più: forse l'hai spostata o rinominata.", {
      timeout: 30000,
    });
    await expect(control(page)).toHaveAccessibleName("2 cartelle collegate, una non si trova");
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "linked-folders-manage/2-missing.png");
    // A folder that holds none of its files is not taken for it.
    const elsewhere = mkdtempSync(join(tmpdir(), "pyxis-folders-elsewhere-"));
    await answerPicker(app, [elsewhere]);
    await row(page, folders.analisi).getByRole("button", { name: "Trova la cartella…" }).click();
    await expect(row(page, folders.analisi)).toContainText("non trovo i file di questa cartella (0 su 2)");
    await expect(row(page, folders.analisi).getByRole("button", { name: "Collegala come nuova" })).toBeVisible();
    rmSync(elsewhere, { recursive: true, force: true });
    await answerPicker(app, [moved]);
    await row(page, folders.analisi).getByRole("button", { name: "Trova la cartella…" }).click();
    await expect(status(page)).toHaveText(`Ho ritrovato ${label(folders.analisi)}: i suoi 2 file sono di nuovo in Libreria.`);
    await expect(row(page, moved)).toContainText("2 file · controllata", { timeout: 30000 });
    expect((await listed(page)).filter((source) => source.linked?.folder === "Analisi 1")).toHaveLength(2);

    // Scollega… from a right-click asks first, with Annulla focused; Annulla changes nothing.
    await atRest(row(page, folders.fisica));
    await row(page, folders.fisica).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Scollega…" }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: `Scollegare «${label(folders.fisica)}»?` });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("I 4 file di questa cartella escono dalla Libreria. Sul computer non cambia niente");
    await expect(confirm).toContainText("Le flashcard, le mappe e le lezioni fatte da questi file restano.");
    await expect(confirm).toContainText("Le risposte che li citano tengono la citazione, ma non possono più aprire il file.");
    await expect(confirm.getByRole("button", { name: "Annulla" })).toBeFocused();
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "linked-folders-manage/3-confirm.png");
    await confirm.getByRole("button", { name: "Annulla" }).click();
    await expect(confirm).toBeHidden();
    await expect(control(page)).toBeFocused();
    expect((await listed(page)).length).toBe(6);

    // Scollega from the dots: the files leave the Library and their shelf, the subject stays, and the disk is as it was.
    const onDisk = snapshot(folders.base);
    await openList(page);
    await dots(page, folders.fisica).click();
    await page.getByRole("menuitem", { name: "Scollega…" }).click();
    await confirm.getByRole("button", { name: "Scollega", exact: true }).click();
    await expect(status(page)).toHaveText(`Ho scollegato ${label(folders.fisica)}: 4 file tolti dalla Libreria.`);
    await expect(control(page)).toHaveText("1 cartella collegata");
    await expect(control(page)).toBeFocused();
    await expect(shelf(page, "Fisica")).toHaveAccessibleName("Fisica nessun file");
    expect((await listed(page)).map((source) => source.title).sort()).toEqual(["Derivate", "Limiti"]);
    expect(snapshot(folders.base)).toEqual(onDisk);
    await animationsSettled(page);
    await saveShot(page, "linked-folders-manage/4-after.png");

    // The answer keeps its citation: it still shows the passage it quotes, and says the file left the Library.
    await page.evaluate(() => {
      location.hash = "/ask/c-gauss";
    });
    const citation = page.locator(".px-msg .px-cite").first();
    await expect(citation).toBeVisible();
    await citation.click();
    const viewer = page.getByRole("complementary", { name: "Legge di Gauss" });
    await expect(viewer.getByText("Questa fonte non è più nella libreria.")).toBeVisible();
    await expect(viewer.getByText("Il flusso del campo elettrico attraverso una superficie chiusa")).toBeVisible();
    await page.keyboard.press("Escape");

    // Linked again, the folder reads as new: its files are back once, and nothing shows twice.
    await link(app, page, [folders.fisica]);
    await allRead(page, 6);
    await page.evaluate(() => {
      location.hash = "/exams/library";
    });
    await expect(control(page)).toHaveText("2 cartelle collegate");
    await expect(shelf(page, "Fisica")).toHaveAccessibleName("Fisica 4 file");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dirname(folders.base), { recursive: true, force: true });
  }
});

test("An unlink that fails changes nothing and says so in the list; one during a reading stops it and leaves nothing in Attività", async () => {
  test.setTimeout(180000);
  const { userData, app, page } = await start();
  const folders = courses();
  try {
    // Only folder: Fisica, with enough files that its reading is still going when it is unlinked.
    for (let index = 0; index < 300; index += 1)
      writeFileSync(join(folders.fisica, `nota ${index}.txt`), `Nota ${index} sul campo elettrico.`);
    await link(app, page, [folders.analisi]);
    await allRead(page, 2);
    await page.evaluate(() => {
      location.hash = "/exams/library";
    });
    await expect(control(page)).toHaveText("1 cartella collegata");

    // The database refuses the unlink: nothing is half done, and the list opens again with the error under the folder.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.exec("CREATE TRIGGER e2e_refuse BEFORE DELETE ON linked_folders BEGIN SELECT RAISE(ABORT, 'e2e'); END");
    await openList(page);
    await dots(page, folders.analisi).click();
    await page.getByRole("menuitem", { name: "Scollega…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Scollega", exact: true }).click();
    await expect(row(page, folders.analisi)).toContainText(
      `Non sono riuscito a scollegare ${label(folders.analisi)}, e non ho cambiato niente. Riprova.`,
    );
    await expect(control(page)).toHaveText("1 cartella collegata");
    expect((await listed(page)).filter((source) => source.status === "ready")).toHaveLength(2);
    db.exec("DROP TRIGGER e2e_refuse");
    db.close();
    await page.keyboard.press("Escape");

    // Unlinking the only folder while another is still being read.
    await link(app, page, [folders.fisica]);
    await openList(page);
    await expect(row(page, folders.fisica)).toContainText(/Leggo (la cartella…|i file · \d+ di \d+)/);
    await dots(page, folders.fisica).click();
    await page.getByRole("menuitem", { name: "Scollega…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Scollega", exact: true }).click();
    await expect(control(page)).toHaveText("1 cartella collegata");
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.pyxis.invoke("jobs.list", {}))).filter(
          (job) => job.kind.startsWith("source-") || job.kind.startsWith("linked-"),
        ),
      )
      .toEqual([]);
    expect((await listed(page)).map((source) => source.title).sort()).toEqual(["Derivate", "Limiti"]);

    // Then the only folder left: the control links one again, as before any folder was linked.
    await openList(page);
    await dots(page, folders.analisi).click();
    await page.getByRole("menuitem", { name: "Scollega…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Scollega", exact: true }).click();
    // The confirmation closed on a control that is gone: the focus goes to the one that took its place.
    await expect(page.getByRole("button", { name: "Collega una cartella", exact: true })).toBeFocused();
    await expect(status(page)).toHaveText(`Ho scollegato ${label(folders.analisi)}: 2 file tolti dalla Libreria.`);
    expect(await listed(page)).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dirname(folders.base), { recursive: true, force: true });
  }
});

test("A folder says how many of its files could not be read, and a list that cannot be read says so with Riprova", async () => {
  test.setTimeout(180000);
  const lose = join(mkdtempSync(join(tmpdir(), "pyxis-folders-lose-")), "lose");
  const { userData, app, page } = await start({ PYXIS_E2E_READ_FAIL: `sources.linkedFolders=${lose}` });
  const base = join(mkdtempSync(join(tmpdir(), "pyxis-folders-bad-")), "Polito");
  const corso = join(base, "Fisica");
  mkdirSync(corso, { recursive: true });
  writeFileSync(join(corso, "Appunti.txt"), "Il campo elettrico di una carica puntiforme decresce con il quadrato della distanza.");
  // Not a PDF at all: its reading fails.
  writeFileSync(join(corso, "Rotto.pdf"), "questo non è un pdf");
  try {
    await link(app, page, [corso]);
    await expect
      .poll(async () => (await listed(page)).map((source) => source.status).sort(), { timeout: 60000 })
      .toEqual(["failed", "ready"]);
    await page.evaluate(() => {
      location.hash = "/exams/library";
    });
    await openList(page);
    // Two files are there, one is read, and the row says the other is not, where to retry it.
    await expect(row(page, corso)).toContainText("2 file · controllata");
    await expect(row(page, corso)).toContainText("1 file non letto: riprova da Attività");
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "linked-folders-manage/5-unreadable.png");
    await page.keyboard.press("Escape");

    // The folders cannot be read the next time the Library opens: the head says so, and Riprova brings the control back.
    writeFileSync(lose, "x");
    await page.reload();
    const failed = page.locator(".px-library-head").getByRole("alert");
    await expect(failed).toHaveText(/Non riesco a leggere le cartelle collegate\./);
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "linked-folders-manage/6-failed.png");
    await failed.getByRole("button", { name: "Riprova" }).click();
    await expect(control(page)).toHaveText("1 cartella collegata");
    await expect(failed).toBeHidden();
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dirname(base), { recursive: true, force: true });
    rmSync(dirname(lose), { recursive: true, force: true });
  }
});

test("The list stays inside a short window, at large text and at 200% and 300% zoom, and its foot is reachable", async () => {
  test.setTimeout(240000);
  const { userData, app, page } = await start();
  const base = mkdtempSync(join(tmpdir(), "pyxis-folders-many-"));
  const paths = Array.from({ length: 10 }, (_, index) => {
    const path = join(base, `Corso ${index + 1}`);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "Note.txt"), `Note del corso ${index + 1} sul campo elettrico.`);
    return path;
  });
  /** The window's content area, in device pixels, at a zoom: the page then sees the size divided by the zoom. */
  const resize = async (width: number, height: number, zoom: number) => {
    await app.evaluate(
      ({ BrowserWindow }, { width, height, zoom }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setContentSize(width, height);
        window.webContents.setZoomFactor(zoom);
      },
      { width, height, zoom },
    );
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([
      Math.round(width / zoom),
      Math.round(height / zoom),
    ]);
  };
  try {
    await link(app, page, paths);
    await allRead(page, 10);
    await page.evaluate(async () => {
      await window.pyxis.invoke("profile.save", { dyslexia: false, textSize: "lg" });
      location.hash = "/exams/library";
    });
    await expect(control(page)).toHaveText("10 cartelle collegate");
    for (const name of ["200% zoom", "300% zoom", "960x600, large text"]) {
      // The app's window does not go below 960x640, so 960x600 is the page's own viewport, as menu-in-window sets it.
      if (name === "200% zoom") await resize(1920, 800, 2);
      // 960x640, the smallest window, at 300%: the page is 320x213, with little room under the control.
      else if (name === "300% zoom") await resize(960, 640, 3);
      else {
        await resize(1280, 800, 1);
        await page.setViewportSize({ width: 960, height: 600 });
      }
      await atRest(control(page));
      await openList(page);
      await animationsSettled(page);
      const place = await list(page).evaluate((panel) => {
        const box = panel.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, scrolls: panel.scrollHeight > panel.clientHeight };
      });
      const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(place.top, name).toBeGreaterThanOrEqual(0);
      expect(place.bottom, name).toBeLessThanOrEqual(view.height);
      expect(place.left, name).toBeGreaterThanOrEqual(0);
      expect(place.right, name).toBeLessThanOrEqual(view.width);
      // Ten folders do not fit a window this short: the list scrolls inside, and its foot comes into view.
      expect(place.scrolls, name).toBe(true);
      const foot = list(page).getByRole("button", { name: "Collega un'altra cartella" });
      await foot.scrollIntoViewIfNeeded();
      const reached = await foot.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= innerHeight;
      });
      expect(reached, name).toBe(true);
      await page.keyboard.press("Escape");
      await expect(list(page)).toBeHidden();
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(base, { recursive: true, force: true });
  }
});
