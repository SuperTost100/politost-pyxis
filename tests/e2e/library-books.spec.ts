import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis, setUp } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { makeBook } from "./book";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams, toLibrary } from "./doors";
import { animationsSettled } from "./settled";
import { saveShot } from "./shots";

const MARKUP = '<script>window.__injected = true</script> e <b>grassetto</b>';

/** A folder laid out like books.politost.it: Fisica 1 (about a subject the student has) and Chimica (about none). */
function booksSite() {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-library-books-site-"));
  mkdirSync(join(dir, "books"));
  const entry = (id: string, title: string, subject: string, chapters: Array<{ title: string; text: string }>) => {
    const bytes = makeBook({ id, title, version: "1.0.0", chapters });
    writeFileSync(join(dir, "books", `${id}@1.0.0.ptsb`), bytes);
    return {
      id,
      title,
      subject,
      authors: ["PoliTost"],
      version: "1.0.0",
      chapters: chapters.length,
      package: `books/${id}@1.0.0.ptsb`,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const books = [
    entry("fisica-1", "Fisica 1", "Fisica 1", [
      { title: "Moti", text: `## p1 | Velocità\nLa velocità media è lo spazio percorso diviso il tempo impiegato.\n\n## p2 | Altro\n${MARKUP}\n` },
      { title: "Forze", text: "## p1 | Dinamica\nLa forza risultante è massa per accelerazione.\n" },
    ]),
    entry("chimica", "Chimica di base", "Chimica", [{ title: "Atomi", text: "## p1 | Atomo\nL'atomo ha un nucleo.\n" }]),
  ];
  writeFileSync(join(dir, "catalog.json"), JSON.stringify({ catalogVersion: 1, books }));
  return dir;
}

function seed(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  try {
    const subject = db.prepare("INSERT INTO subjects (id, name, position, created_at) VALUES (?, ?, ?, 1)");
    subject.run("fis", "Fisica 1", 0);
    subject.run("ana", "Analisi 2", 1);
    subject.run("vuota", "Chimica", 2);
    const source = db.prepare(
      "INSERT INTO sources (id, subject_id, kind, title, status, library, created_at, updated_at) VALUES (?, ?, 'pdf', ?, 'ready', 1, ?, 1)",
    );
    source.run("fis-notes", "fis", "Appunti di fisica", 1);
    source.run("ana-notes", "ana", "Appunti di analisi", 2);
  } finally {
    db.close();
  }
}

type Started = { app: ElectronApplication; page: Page; userData: string; site: string };

async function start(env: Record<string, string | undefined> = {}, withSite = true): Promise<Started> {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-library-books-"));
  const site = booksSite();
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_BOOKS: withSite ? site : undefined, ...env } });
  return setUp(app, userData, async () => {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    seed(userData);
    await toLibrary(page);
    await page.reload();
    return { app, page, userData, site };
  });
}
async function finish({ app, userData, site }: Started) {
  await app.close();
  removeTestFolder(userData);
  rmSync(site, { recursive: true, force: true });
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const shelf = (page: Page, subject: string) =>
  page.getByRole("region", { name: new RegExp(`^${escaped(subject)} (\\d+ (file|files)|nessun file|no files)$`) });
const offer = (page: Page, subject = "Fisica 1") =>
  shelf(page, subject).getByRole("group", { name: "C'è un libro PoliTost per questa materia" });
const reader = (page: Page, title: string) => page.getByRole("complementary", { name: title });
const books = (page: Page) =>
  page.evaluate(() => window.pyxis.invoke("sources.list", {})) as Promise<Array<{ id: string; title: string; kind: string; status: string; subject: string | null }>>;

/** Every file under the workspace with its size, so a spec can tell that a read left nothing behind. */
function workspaceFiles(userData: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!/pyxis\.db(-wal|-shm)?$/.test(name)) out.push(`${path}:${statSync(path).size}`);
    }
  };
  walk(join(userData, "workspace"));
  return out.sort();
}

test("A book about a subject is offered once on its shelf, read before it is added without leaving anything, and a dismissed row stays away", async () => {
  test.setTimeout(180_000);
  const run = await start();
  const { page, userData } = run;
  try {
    // A shelf has the row when a book is named like its subject, empty shelf or not, and no other shelf has it.
    await expect(offer(page)).toBeVisible();
    await expect(offer(page, "Chimica")).toBeVisible();
    await expect(page.getByRole("group", { name: "C'è un libro PoliTost per questa materia" })).toHaveCount(2);
    await expect(shelf(page, "Analisi 2").getByRole("group")).toHaveCount(0);
    await expect(offer(page)).toContainText("Fisica 1, gratuito e scritto per il corso: 2 capitoli");
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "library-books/row-it-light-1280.png", { fullPage: true });
    // Showing the offer downloaded nothing and stored nothing.
    expect((await books(page)).filter((row) => row.kind === "smartbook")).toEqual([]);
    const before = workspaceFiles(userData);

    await offer(page).getByRole("button", { name: "Apri il libro Fisica 1" }).click();
    const panel = reader(page, "Fisica 1");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Non è ancora nella tua Libreria.")).toBeVisible();
    await expect(panel.getByText("Libro PoliTost · 2 capitoli · gratuito")).toBeVisible();
    await expect(panel.getByText("La velocità media è lo spazio percorso")).toBeVisible({ timeout: 30_000 });
    // The book's text is text: no script runs, and no tag of the book's becomes an element.
    await expect(panel.getByText("e grassetto", { exact: false })).toHaveCount(0);
    expect(await panel.locator("script, b").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected)).toBeUndefined();
    // Chapters turn with the arrows, as in a book from the Library.
    await panel.getByRole("button", { name: /Capitolo successivo|Prossimo capitolo|Next chapter/ }).click();
    await expect(panel.getByText("La forza risultante è massa per accelerazione.")).toBeVisible();
    await expectNoAxeViolations(page);
    await animationsSettled(page);
    await saveShot(page, "library-books/reader-it-light-1280.png", { fullPage: true });

    // Closed without adding, nothing is left: no source, no file in the workspace.
    await panel.getByRole("button", { name: "Chiudi" }).click();
    await expect(panel).toHaveCount(0);
    expect((await books(page)).filter((row) => row.kind === "smartbook")).toEqual([]);
    expect(workspaceFiles(userData)).toEqual(before);
    await expect(offer(page)).toBeVisible();

    // The row is dismissed for this subject, and stays dismissed when the window reloads.
    await offer(page).getByRole("button", { name: /^Nascondi il libro Fisica 1/ }).click();
    await expect(offer(page)).toHaveCount(0);
    await page.reload();
    await expect(shelf(page, "Fisica 1")).toBeVisible();
    await expect(offer(page)).toHaveCount(0);
    // The subject's menu still has the book, so the dismissal costs nothing.
    await shelf(page, "Fisica 1").getByRole("button", { name: /^Azioni sulla materia Fisica 1/ }).click();
    await page.getByRole("menuitem", { name: "Apri il libro PoliTost" }).click();
    await expect(reader(page, "Fisica 1")).toBeVisible();
  } finally {
    await finish(run);
  }
});

test("Adding from the row shows the download in place and the book lands on the shelf as a PoliTost book", async () => {
  test.setTimeout(180_000);
  const run = await start({ PYXIS_E2E_BOOKS_DELAY: "2500" });
  const { page } = run;
  try {
    await offer(page).getByRole("button", { name: "Aggiungi Fisica 1" }).click();
    // The row says it is working, and the cover is already on the shelf, still downloading.
    await expect(offer(page).getByText("Scarico il libro…")).toBeVisible();
    const pending = shelf(page, "Fisica 1").locator("[data-pending-book]");
    await expect(pending).toBeVisible();
    await expect(pending.getByText("Libro PoliTost")).toBeVisible();
    await saveShot(page, "library-books/adding-it-light-1280.png", { fullPage: true });
    // Then the real cover takes its place, marked as a PoliTost book, and the row is gone.
    const cover = shelf(page, "Fisica 1").locator(".px-cover", { has: page.getByRole("button", { name: "Fisica 1", exact: true }) });
    await expect(cover).toBeVisible({ timeout: 30_000 });
    await expect(cover.getByText("Libro PoliTost")).toBeVisible();
    await expect(pending).toHaveCount(0);
    await expect(offer(page)).toHaveCount(0);
    const added = (await books(page)).filter((row) => row.kind === "smartbook");
    expect(added).toEqual([expect.objectContaining({ title: "Fisica 1", subject: "Fisica 1" })]);
    await expect(page.getByRole("status").filter({ hasText: "è nella Libreria, sullo scaffale di Fisica 1" })).toHaveCount(1);
    await saveShot(page, "library-books/added-it-light-1280.png", { fullPage: true });
  } finally {
    await finish(run);
  }
});

test("Adding from the reader keeps it open and says where the book went, without downloading it a second time", async () => {
  test.setTimeout(180_000);
  const run = await start();
  const { page, site } = run;
  try {
    await offer(page).getByRole("button", { name: "Apri il libro Fisica 1" }).click();
    const panel = reader(page, "Fisica 1");
    await expect(panel.getByText("La velocità media è lo spazio percorso")).toBeVisible({ timeout: 30_000 });
    // The package leaves the site: an add that had to download it again would fail.
    rmSync(join(site, "books"), { recursive: true, force: true });
    await panel.getByRole("button", { name: "Aggiungi alla Libreria" }).click();
    await expect(panel.getByText("È nella tua Libreria, sullo scaffale di Fisica 1.")).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("button", { name: "Aggiungi alla Libreria" })).toHaveCount(0);
    await expect(panel.getByText("La velocità media è lo spazio percorso")).toBeVisible();
    await expect(offer(page)).toHaveCount(0);
    await expect(shelf(page, "Fisica 1").getByRole("button", { name: "Fisica 1", exact: true })).toBeVisible();
    await saveShot(page, "library-books/reader-added-it-light-1280.png", { fullPage: true });
  } finally {
    await finish(run);
  }
});

test("The full list opens any book it does not have in the reader and adds it, and the offer is gone when offline", async () => {
  test.setTimeout(180_000);
  const run = await start();
  const { page } = run;
  try {
    await page.getByRole("button", { name: "Altro sulla Libreria" }).click();
    await page.getByRole("menuitem", { name: "Libri PoliTost gratuiti", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Libri PoliTost gratuiti" });
    await expect(dialog.getByText("Chimica di base")).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole("button", { name: "Apri Chimica di base" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Aggiungi Chimica di base" })).toBeVisible();
    await saveShot(page, "library-books/list-it-light-1280.png", { fullPage: true });
    await dialog.getByRole("button", { name: "Apri Chimica di base" }).click();
    await expect(dialog).toHaveCount(0);
    const panel = reader(page, "Chimica di base");
    await expect(panel.getByText("L'atomo ha un nucleo.")).toBeVisible({ timeout: 30_000 });
    // Its subject is Chimica, which the student has an empty shelf for: the add goes there.
    await panel.getByRole("button", { name: "Aggiungi alla Libreria" }).click();
    await expect(panel.getByText("È nella tua Libreria, sullo scaffale di Chimica.")).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: "Chiudi" }).click();
    // The list closed when the book opened; it says the book is in the Library when it opens again.
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Altro sulla Libreria" }).click();
    await page.getByRole("menuitem", { name: "Libri PoliTost gratuiti", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Libri PoliTost gratuiti" }).getByText("Nella tua libreria", { exact: true })).toBeVisible();
  } finally {
    await finish(run);
  }
});

test("Offline, no offer shows and nothing looks broken; the list says it could not be read", async () => {
  test.setTimeout(120_000);
  const run = await start({}, false);
  const { page } = run;
  try {
    await expect(shelf(page, "Fisica 1")).toBeVisible();
    await expect(offer(page)).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "Altro sulla Libreria" }).click();
    await page.getByRole("menuitem", { name: "Libri PoliTost gratuiti", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Libri PoliTost gratuiti" });
    await expect(dialog.getByText("Non riesco a raggiungere books.politost.it")).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole("button", { name: "Riprova" })).toBeVisible();
  } finally {
    await finish(run);
  }
});
