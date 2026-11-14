import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onePagePdf } from "../../src/core/sources/test-pdf";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams, toLibrary } from "./doors";
import { animationsSettled, atRest } from "./settled";
import { saveShot } from "./shots";

/** A second-year student's subjects, one with a name too long for a line and one no symbol fits. */
const SUBJECTS = [
  { id: "ana", name: "Analisi Matematica 1" },
  { id: "fis", name: "Fisica 2" },
  { id: "cin", name: "Linguaggio cinematografico e storia del cinema" },
  { id: "td", name: "Tecnologie Digitali" },
  { id: "soc", name: "Sociologia dei media" },
  { id: "long", name: "Metodi matematici per l'ingegneria dell'informazione e delle telecomunicazioni" },
];

type Row = { id: string; subject: string | null; kind: string; title: string; status?: string; pages?: number };

/**
 * Files as a student's folders name them, with the kind each should get. Analisi holds sixty, the others a few, and
 * Sociologia one. A file in Fisica is being read, one failed, one is missing from its folder and one is locked.
 */
function library(): Array<Row & { expect: string }> {
  const files: Array<Row & { expect: string }> = [
    { id: "a-book", subject: "ana", kind: "pdf", title: "Bramanti Pagani Salsa - Analisi matematica 1", expect: "book" },
    { id: "a-slide", subject: "ana", kind: "pdf", title: "Lezione 06 - slide", expect: "slides" },
    { id: "a-temi", subject: "ana", kind: "pdf", title: "Temi d'esame 2022-2025 con soluzioni", expect: "exam" },
    { id: "a-notes", subject: "ana", kind: "pdf", title: "appunti_analisi1_def(1)", expect: "notes" },
    { id: "a-ex", subject: "ana", kind: "docx", title: "Esercitazione 3 soluzioni", expect: "exercises" },
    { id: "a-photo", subject: "ana", kind: "image", title: "IMG_2041", expect: "photo" },
    { id: "a-handout", subject: "ana", kind: "pdf", title: "Dispense sui limiti", expect: "handout" },
    { id: "a-long", subject: "ana", kind: "pdf", title: "Analisi matematica 1", pages: 412, expect: "book" },
  ];
  for (let n = 1; n <= 26; n++)
    files.push({ id: `a-l${n}`, subject: "ana", kind: "pdf", title: `Lezione ${String(n).padStart(2, "0")}`, expect: "slides" });
  for (let n = 1; n <= 26; n++)
    files.push({ id: `a-s${n}`, subject: "ana", kind: "pdf", title: `Esercizi serie ${n}`, expect: "exercises" });
  files.push(
    { id: "f-book", subject: "fis", kind: "smartbook", title: "Fisica 2", expect: "book" },
    { id: "f-slide", subject: "fis", kind: "pptx", title: "Campo elettrico e legge di Gauss", expect: "slides" },
    { id: "f-read", subject: "fis", kind: "pdf", title: "Slide lezione 7", status: "extracting", expect: "slides" },
    { id: "f-fail", subject: "fis", kind: "pdf", title: "Esercitazione 4, scansione", status: "failed", expect: "exercises" },
    { id: "f-gone", subject: "fis", kind: "pdf", title: "Temi d'esame 2022-2025", expect: "exam" },
    { id: "f-lock", subject: "fis", kind: "pdf", title: "Appunti sul campo elettrico", status: "failed", expect: "notes" },
    { id: "f-photo", subject: "fis", kind: "image", title: "Lavagna, legge di Gauss", expect: "photo" },
    { id: "f-form", subject: "fis", kind: "pdf", title: "Formulario di Fisica 2", expect: "handout" },
    { id: "c-book", subject: "cin", kind: "pdf", title: "Rondolino Tomasi - Manuale del film", expect: "book" },
    { id: "c-slide", subject: "cin", kind: "pdf", title: "Slide lezione 6", expect: "slides" },
    { id: "c-notes", subject: "cin", kind: "text", title: "Appunti lezioni 1-12", expect: "notes" },
    { id: "c-cards", subject: "cin", kind: "pdf", title: "Schede dei film", expect: "handout" },
    { id: "c-photo", subject: "cin", kind: "image", title: "Fotogrammi di Quarto potere", expect: "photo" },
    { id: "t-book", subject: "td", kind: "pdf", title: "Tecnologie digitali per i media, 2a edizione", expect: "book" },
    { id: "t-slide", subject: "td", kind: "pptx", title: "Lezione 9", expect: "slides" },
    { id: "t-ex", subject: "td", kind: "pdf", title: "Esercizi serie 3", expect: "exercises" },
    { id: "t-exam", subject: "td", kind: "pdf", title: "Appello 14 febbraio 2025", expect: "exam" },
    { id: "s-book", subject: "soc", kind: "smartbook", title: "Sociologia dei media", expect: "book" },
    { id: "l-notes", subject: "long", kind: "pdf", title: "Riassunto della trasformata di Fourier e delle sue applicazioni ai segnali", expect: "notes" },
    { id: "l-book", subject: "long", kind: "pdf", title: "Manuale", expect: "book" },
    { id: "u-photo", subject: null, kind: "image", title: "IMG_2077", expect: "photo" },
    { id: "u-ex", subject: null, kind: "pdf", title: "Esercizi misti", expect: "exercises" },
    { id: "u-book", subject: null, kind: "pdf", title: "Probabilità e statistica - manuale", expect: "book" },
  );
  return files;
}

function seed(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  try {
    const subject = db.prepare("INSERT INTO subjects (id, name, position, created_at) VALUES (?, ?, ?, 1)");
    SUBJECTS.forEach((row, index) => subject.run(row.id, row.name, index));
    const source = db.prepare(
      "INSERT INTO sources (id, subject_id, kind, title, status, library, subject_sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1)",
    );
    library().forEach((row, index) =>
      source.run(row.id, row.subject, row.kind, row.title, row.status ?? "ready", row.subject ? null : "unsure", index + 1),
    );
    // A long book with no word that says so: 412 pages.
    db.prepare("INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('d-long', 'a-long', 1, '{}', 1)").run();
    const passage = db.prepare(
      "INSERT INTO passages (id, source_id, document_id, text, locator_json, created_at) VALUES (?, 'a-long', 'd-long', 'Limiti', ?, 1)",
    );
    for (const page of [1, 200, 412]) passage.run(`p-${page}`, JSON.stringify({ page }));
    // A file of a linked folder that is gone from it, and a PDF waiting for its password.
    db.prepare("INSERT INTO linked_folders (id, path, mode, created_at) VALUES ('covers-folder', ?, 'subject', 1)").run(
      join(userData, "nowhere", "Fisica 2"),
    );
    db.prepare(
      "INSERT INTO linked_files (folder_id, rel_path, subfolder, source_id, size, mtime_ms, missing_at) VALUES ('covers-folder', 'Temi.pdf', '', 'f-gone', 10, 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO jobs (id, kind, params_json, state, progress, error, created_at, updated_at) VALUES ('covers-lock', 'source-import', ?, 'failed', 0, 'pdf-password-required', 1, 1)",
    ).run(JSON.stringify({ sourceId: "f-lock" }));
  } finally {
    db.close();
  }
}

async function start(): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-library-covers-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_FILE: undefined } });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  seed(userData);
  await toLibrary(page);
  await page.reload();
  return { app, page, userData };
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const shelf = (page: Page, subject: string) =>
  page.getByRole("region", { name: new RegExp(`^${escaped(subject)} (\\d+ (file|files)|nessun file|no files)$`) });
const cover = (page: Page, title: string) => page.locator(".px-cover", { has: page.getByRole("button", { name: title, exact: true }) });

test("Every file in the Library is drawn by its kind, a book by its subject's symbol, and each state reads on every cover", async () => {
  test.setTimeout(240_000);
  const { app, page, userData } = await start();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await shelf(page, "Analisi Matematica 1").getByRole("button", { name: /^Mostra tutti/ }).click();
    for (const file of library()) {
      const subject = SUBJECTS.find((row) => row.id === file.subject)?.name;
      const item = subject
        ? shelf(page, subject).locator(".px-cover", { has: page.getByRole("button", { name: file.title, exact: true }) })
        : page.locator(`[data-unsorted-id="${file.id}"]`);
      await expect.soft(item.locator(".px-cover-art"), file.title).toHaveAttribute("data-kind", file.expect);
    }
    // A book carries its subject's symbol, or its initials when no symbol fits.
    const symbol = (title: string) => cover(page, title).locator(".px-fc-symbol").getAttribute("data-symbol");
    expect(await symbol("Bramanti Pagani Salsa - Analisi matematica 1")).toBe("integral");
    expect(await symbol("Fisica 2")).toBe("atom");
    expect(await symbol("Rondolino Tomasi - Manuale del film")).toBe("clapperboard");
    expect(await symbol("Tecnologie digitali per i media, 2a edizione")).toBe("chip");
    await expect(cover(page, "Sociologia dei media").locator(".px-fc-initials")).toHaveText("SM");
    // The marks: reading, failed, missing from its folder, waiting for a password.
    await expect(cover(page, "Slide lezione 7").locator("[data-mark]")).toHaveAttribute("data-mark", "reading");
    await expect(cover(page, "Esercitazione 4, scansione").locator("[data-mark]")).toHaveAttribute("data-mark", "failed");
    await expect(cover(page, "Temi d'esame 2022-2025").locator("[data-mark]")).toHaveAttribute("data-mark", "missing");
    await expect(cover(page, "Appunti sul campo elettrico").locator("[data-mark]")).toHaveAttribute("data-mark", "locked");
    // A screen reader hears the title, then the kind and the state.
    const reading = page.getByRole("button", { name: "Slide lezione 7", exact: true });
    await expect(reading).toHaveAccessibleDescription(/^Slide\b.*Lettura/);
    await expect(page.getByRole("button", { name: "IMG_2041", exact: true })).toHaveAccessibleDescription("Foto");
    // "Da sistemare" says the kind first.
    await expect(page.locator('[data-unsorted-id="u-ex"] .px-unsorted-meta').first()).toHaveText(/^Esercizi · PDF/);
    // The type filter offers the kinds.
    const option = (name: string) => page.locator(".ant-select-dropdown:visible .ant-select-item-option", { hasText: name });
    await page.getByRole("combobox", { name: "Tipo" }).click();
    await expect(page.locator(".ant-select-dropdown:visible .ant-select-item-option")).toHaveText([
      "Tutti i tipi", "Libro", "Slide", "Tema d'esame", "Appunti", "Esercizi", "Foto", "Dispensa",
    ]);
    await option("Tema d'esame").click();
    await expect(page.locator(".px-cover")).toHaveCount(3);
    await page.getByRole("combobox", { name: "Tipo" }).click();
    await option("Tutti i tipi").click();

    for (const [language, theme] of [["it", "dark"], ["en", "light"]] as const)
      for (const width of [1280, 960]) {
        await page.evaluate(
          async ({ language, theme }) => {
            localStorage.setItem("pyxis.lang", language);
            await window.pyxis.setAppearance(theme);
          },
          { language, theme },
        );
        await page.setViewportSize({ width, height: 900 });
        await page.reload();
        await expect(page.locator(".px-cover").first()).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await animationsSettled(page);
        await expectNoAxeViolations(page);
        await saveShot(page, `library-covers/shelves-${language}-${theme}-${width}.png`, { fullPage: true });
      }

    // At 200% zoom in the smallest window nothing pushes the page sideways, not even a subject's very long name in the
    // pickers of "Da sistemare".
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setContentSize(960, 800);
      window.webContents.setZoomFactor(2);
    });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(480);
    await expect(page.locator(".px-cover").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(480);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** Opens "Tipo" in a menu that is open and returns the item of `kind`. */
async function kindItem(page: Page, kind: string) {
  await page.getByRole("menuitem", { name: /^(Tipo|Kind)$/ }).hover();
  return page.getByRole("menuitemradio", { name: kind, exact: true });
}

test("The kind is changed from the file's menu by its dots, a right-click or the keyboard, and stays when the file is renamed", async () => {
  test.setTimeout(240_000);
  const { app, page, userData } = await start();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await shelf(page, "Analisi Matematica 1").getByRole("button", { name: /^Mostra tutti/ }).click();
    const temi = cover(page, "Temi d'esame 2022-2025 con soluzioni");

    // By the dots: the current kind is checked, and the choice redraws the cover and gives it back the focus.
    await page.getByRole("button", { name: "Azioni per Temi d'esame 2022-2025 con soluzioni" }).click();
    await expect(await kindItem(page, "Tema d'esame")).toHaveAttribute("aria-checked", "true");
    await expect(await kindItem(page, "Appunti")).toHaveAttribute("aria-checked", "false");
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "library-covers/kind-menu.png");
    await (await kindItem(page, "Appunti")).click();
    await expect(temi.locator(".px-cover-art")).toHaveAttribute("data-kind", "notes");
    await expect(page.getByRole("button", { name: "Temi d'esame 2022-2025 con soluzioni", exact: true })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "ora è Appunti" })).toHaveCount(1);

    // Renamed, the file keeps the student's choice over what its new name says.
    await page.evaluate(() => window.pyxis.invoke("sources.rename", { sourceId: "a-temi", title: "Tema d'esame luglio" }));
    await page.reload();
    await shelf(page, "Analisi Matematica 1").getByRole("button", { name: /^Mostra tutti/ }).click();
    await expect(cover(page, "Tema d'esame luglio").locator(".px-cover-art")).toHaveAttribute("data-kind", "notes");

    // By a right-click on a cover near the window's right edge and bottom: the menu and "Tipo" stay inside the window.
    await page.setViewportSize({ width: 960, height: 700 });
    const lesson = cover(page, "Lezione 06 - slide");
    await lesson.scrollIntoViewIfNeeded();
    await atRest(lesson);
    const box = (await lesson.boundingBox())!;
    await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4, { button: "right" });
    const exercises = await kindItem(page, "Esercizi");
    await expect(exercises).toBeVisible();
    for (const menu of await page.locator(".ant-dropdown-menu:visible").all()) {
      const edge = (await menu.boundingBox())!;
      expect(edge.x + edge.width).toBeLessThanOrEqual(960);
      expect(edge.y + edge.height).toBeLessThanOrEqual(700);
    }
    await exercises.click();
    await expect(lesson.locator(".px-cover-art")).toHaveAttribute("data-kind", "exercises");

    // By the keyboard alone: Shift+F10 on the cover, the arrows to "Tipo" and into it, Enter.
    const photo = page.getByRole("button", { name: "IMG_2041", exact: true });
    await photo.focus();
    // A slow computer can take the first arrow before the menu exists, let alone has the focus: it is the menu's all the
    // same. Both keys go in one task here, so the arrow always comes first.
    await photo.evaluate((cover) => {
      cover.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
      cover.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    await expect(page.getByRole("menuitem", { name: "Dettagli della fonte", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem")).toHaveCount(0);
    await expect(photo).toBeFocused();
    await page.keyboard.press("Shift+F10");
    for (const item of ["Dettagli della fonte", "Rinomina", "Tipo"]) {
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitem", { name: item, exact: true })).toBeFocused();
    }
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("menuitemradio", { name: "Libro" })).toBeFocused();
    for (const kind of ["Slide", "Tema d'esame", "Appunti", "Esercizi", "Foto", "Dispensa"]) {
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitemradio", { name: kind, exact: true })).toBeFocused();
    }
    await expect(page.getByRole("menuitemradio", { name: "Foto" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Enter");
    await expect(cover(page, "IMG_2041").locator(".px-cover-art")).toHaveAttribute("data-kind", "handout");
    // Focus is back on the cover, and the Enter that chose the kind did not also open the file's details.
    await expect(photo).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(
      await page.evaluate(() => window.pyxis.invoke("sources.list", {})).then((rows) =>
        rows.filter((row) => row.kindChosen).map((row) => `${row.id}:${row.fileKind}`).sort(),
      ),
    ).toEqual(["a-photo:handout", "a-slide:exercises", "a-temi:notes"]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** Where the focus is: the accessible name of the focused element, or "body" when nothing in the page holds it. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return !active || active === document.body ? "body" : (active.getAttribute("aria-label") ?? active.textContent ?? "").trim();
  });

test("When a change takes the last file out of a filtered or searched list, the focus goes to the filter that explains why, never to the body", async () => {
  test.setTimeout(240_000);
  const { app, page, userData } = await start();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    // Two photos are left, on two subjects, so the Foto filter shows two covers.
    await page.evaluate(async () => {
      for (const sourceId of ["f-photo", "u-photo"]) await window.pyxis.invoke("sources.setKind", { sourceId, kind: "handout" });
    });
    await page.reload();
    const filter = page.getByRole("combobox", { name: "Tipo" });
    await filter.click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option", { hasText: "Foto" }).click();

    /** Changes a file's kind from the keyboard alone: its menu, "Tipo", the kind below "Foto" in the list. */
    const makeHandout = async (title: string) => {
      await page.getByRole("button", { name: title, exact: true }).focus();
      await page.keyboard.press("Shift+F10");
      for (const item of ["Dettagli della fonte", "Rinomina", "Tipo"]) {
        await page.keyboard.press("ArrowDown");
        await expect(page.getByRole("menuitem", { name: item, exact: true })).toBeFocused();
      }
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("menuitemradio", { name: "Libro" })).toBeFocused();
      for (const kind of ["Slide", "Tema d'esame", "Appunti", "Esercizi", "Foto", "Dispensa"]) {
        await page.keyboard.press("ArrowDown");
        await expect(page.getByRole("menuitemradio", { name: kind, exact: true })).toBeFocused();
      }
      await page.keyboard.press("Enter");
      await expect(page.getByRole("menuitem")).toHaveCount(0);
    };

    // The first leaves the filter and takes its subject's card along, since the card holds no other photo. The focus
    // goes to the page's "Aggiungi file", as it does when the last subject is deleted.
    await expect(page.getByRole("button", { name: "IMG_2041", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Fotogrammi di Quarto potere", exact: true })).toBeVisible();
    await makeHandout("IMG_2041");
    await expect(page.getByRole("button", { name: "IMG_2041", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Azioni sulla materia Analisi Matematica 1" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Aggiungi file" })).toBeFocused();

    // The only one left leaves too, so the list gives way to the message, and the focus goes to the type filter, whose
    // change brings the files back.
    await makeHandout("Fotogrammi di Quarto potere");
    await expect(page.getByText("Nessuna fonte con questo filtro.")).toBeVisible();
    await expect(filter).toBeFocused();
    expect(await focused(page)).not.toBe("body");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("The focus stays in the page when the file that held it is renamed out of a search, removed, or moved off a shelf", async () => {
  test.setTimeout(240_000);
  const { app, page, userData } = await start();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    const search = page.getByRole("textbox", { name: "Cerca una fonte per titolo" });
    /** Opens a file's menu from the keyboard and chooses `item`, the last of `path` being the one that is clicked. */
    const choose = async (title: string, ...path: string[]) => {
      await page.getByRole("button", { name: title, exact: true }).focus();
      await page.keyboard.press("Shift+F10");
      await page.getByRole("menuitem", { name: "Dettagli della fonte", exact: true }).waitFor();
      for (const [index, name] of path.entries()) {
        const item = page.getByRole("menuitem", { name, exact: true });
        if (index < path.length - 1) await item.hover();
        else await item.click();
      }
    };

    /** Deletes a file from its menu and answers the question the menu leads to; the dialog has closed when this returns. */
    const remove = async (title: string) => {
      await choose(title, "Elimina il file…");
      await page.getByRole("dialog").getByRole("button", { name: "Elimina il file", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    };

    // Moved off its shelf while a search shows it: the file is still drawn, on the other subject's shelf.
    await search.fill("Fotogrammi di Quarto");
    await expect(page.getByRole("button", { name: "Fotogrammi di Quarto potere", exact: true })).toBeVisible();
    await choose("Fotogrammi di Quarto potere", "Sposta in", "Fisica 2");
    // The move is done when the file is on the shelf it was sent to and gone from the one it left.
    const moved = { name: "Fotogrammi di Quarto potere", exact: true } as const;
    await expect(shelf(page, "Fisica 2").getByRole("button", moved)).toBeVisible();
    await expect(shelf(page, "Linguaggio cinematografico e storia del cinema").getByRole("button", moved)).toHaveCount(0);
    await expect(page.getByRole("button", moved)).toBeFocused();

    // Removed while it is the last match: the message takes the list's place and the search field has the focus.
    await remove("Fotogrammi di Quarto potere");
    await expect(page.getByText("Nessuna fonte con questo filtro.")).toBeVisible();
    expect(await focused(page)).not.toBe("body");
    await expect(search).toBeFocused();

    // Renamed so that it no longer matches: the panel keeps the focus while it is open, and leaves it on the page's heading.
    await search.fill("IMG_2041");
    await choose("IMG_2041", "Rinomina");
    const field = page.getByRole("textbox", { name: "Nuovo nome della fonte" });
    await field.fill("Lavagna");
    await field.press("Enter");
    await expect(page.getByText("Nessuna fonte con questo filtro.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await focused(page)).not.toBe("body");

    // The last file of a subject's shelf removed, with no filter: the focus goes to the subject's dots.
    await search.fill("");
    await remove("Sociologia dei media");
    await expect(shelf(page, "Sociologia dei media")).toContainText(/nessun file/);
    await expect(shelf(page, "Sociologia dei media").getByRole("button", { name: "Azioni sulla materia Sociologia dei media" })).toBeFocused();

    // A file removed from the middle of a shelf: the focus goes to the next cover.
    await page.getByRole("button", { name: "Azioni sulla materia Sociologia dei media" }).waitFor();
    await remove("Rondolino Tomasi - Manuale del film");
    await expect(page.getByRole("button", { name: "Rondolino Tomasi - Manuale del film", exact: true })).toHaveCount(0);
    expect(await focused(page)).not.toBe("body");

    // A row of "Da sistemare" removed: the focus goes to the next row.
    await remove("IMG_2077");
    await expect(page.getByRole("button", { name: "IMG_2077", exact: true })).toHaveCount(0);
    expect(await focused(page)).not.toBe("body");

    // The Library's last file removed, with no subject left: the page shows its empty state, and the focus is on its "Collega una cartella".
    await page.evaluate(async (keep) => {
      for (const source of await window.pyxis.invoke("sources.list", {}))
        if (source.id !== keep) await window.pyxis.invoke("sources.remove", { sourceId: source.id, confirmed: true });
      for (const subject of await window.pyxis.invoke("subjects.list", {})) await window.pyxis.invoke("subjects.remove", { id: subject.id, onlyEmpty: true });
    }, "u-ex");
    await page.reload();
    await remove("Esercizi misti");
    await expect(page.getByText(/^Qui compariranno i tuoi file/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Collega una cartella", exact: true })).toBeFocused();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("A linked file keeps the kind the student chose when its folder is read again", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-library-covers-linked-"));
  const root = join(mkdtempSync(join(tmpdir(), "pyxis-covers-folder-")), "Fisica 2");
  const file = join(root, "Esercitazioni", "Esercitazione 5.pdf");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, onePagePdf("Esercizio 1. Una carica puntiforme genera un campo elettrico radiale"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_FILE: undefined } });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByLabel("Nome", { exact: true }).fill("Ada");
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await page.getByRole("button", { name: /^(Lo faccio dopo|Continua)$/ }).click();
    await page.getByRole("button", { name: "Una cartella per ogni materia", exact: true }).click();
    await app.evaluate(({ dialog }, answer) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: answer })) as typeof dialog.showOpenDialog;
    }, [root]);
    await page.getByRole("button", { name: "Scegli le cartelle", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ho trovato una materia", { timeout: 60_000 });
    await page.getByRole("button", { name: "Inizia a studiare", exact: true }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await fromChiediToExams(page);
    await toLibrary(page);
    const item = cover(page, "Esercitazione 5");
    await expect(item.locator(".px-cover-art")).toHaveAttribute("data-kind", "exercises", { timeout: 60_000 });

    await page.getByRole("button", { name: "Azioni per Esercitazione 5" }).click();
    await (await kindItem(page, "Tema d'esame")).click();
    await expect(item.locator(".px-cover-art")).toHaveAttribute("data-kind", "exam");

    // The file changes in its folder: Pyxis reads it again as the next version of the same source.
    writeFileSync(file, onePagePdf("Esercizio 1 e 2. Due cariche puntiformi e il principio di sovrapposizione"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000, readOnly: true });
    try {
      await expect
        .poll(
          () =>
            db
              .prepare(
                "SELECT MAX(d.version) AS v FROM source_documents d JOIN sources s ON s.id = d.source_id WHERE s.title = 'Esercitazione 5' AND s.status = 'ready'",
              )
              .get()?.v,
          { timeout: 60_000 },
        )
        .toBe(2);
    } finally {
      db.close();
    }
    await page.reload();
    await expect(item.locator(".px-cover-art")).toHaveAttribute("data-kind", "exam");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dirname(root), { recursive: true, force: true });
  }
});
