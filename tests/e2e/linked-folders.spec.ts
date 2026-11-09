import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { onePagePdf } from "../../src/core/sources/test-pdf";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { animationsSettled } from "./settled";
import { saveShot } from "./shots";

/** A Word file with one paragraph: the parts mammoth needs and nothing else. */
function docx(text: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });
}

/** A student's Documenti › Università: three subjects, exam papers in a subfolder, and holiday paperwork. */
function studyFolder() {
  const root = join(mkdtempSync(join(tmpdir(), "pyxis-linked-")), "Documenti", "Università");
  const put = (rel: string, bytes: Uint8Array) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), bytes);
  };
  put("Fisica 1/Mazzoldi cap 2.pdf", onePagePdf("La velocita e la derivata della posizione rispetto al tempo"));
  put("Fisica 1/Temi d'esame/Febbraio 2025.pdf", onePagePdf("Esercizio 1. Un punto si muove con velocita costante"));
  put("Analisi 2/Appunti integrali.docx", docx("Un integrale doppio si calcola per fili, integrando prima in y."));
  put("GAL/Dispense matrici.pdf", onePagePdf("Una matrice quadrata e invertibile se il determinante non e nullo"));
  put("Erasmus/Learning agreement.pdf", onePagePdf("Learning agreement for the exchange semester"));
  return root;
}

/** Every entry under `root` with its size and modification time, to show Pyxis wrote nothing there. */
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

/** Recorded subject names, as the AI tool would answer for this folder. */
const replies = JSON.stringify({
  folders: {
    folders: [
      { folder: "Fisica 1", subject: "Fisica I", study: true, kinds: ["book", "exams"] },
      { folder: "Analisi 2", subject: "Analisi matematica II", study: true, kinds: ["notes"] },
      { folder: "GAL", subject: "Geometria e algebra lineare", study: true, kinds: ["handouts"] },
      { folder: "Erasmus", subject: "Erasmus", study: false, kinds: [] },
    ],
  },
});

/** Main answers the next folder picker with `paths`, as if the student had chosen them. */
async function answerPicker(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, answer) => {
    delete process.env["PYXIS_E2E_FILE"];
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: answer })) as typeof dialog.showOpenDialog;
  }, paths);
}

const button = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });
const title = (page: Page) => page.getByRole("heading", { level: 1 });

type Listed = {
  title: string;
  status: string;
  subject: string | null;
  linked: { folder: string; missing: boolean } | null;
};
const listed = (page: Page) => page.evaluate(() => window.pyxis.invoke("sources.list", {})) as Promise<Listed[]>;

/** Setup up to its material step, with the profile saved. */
async function toMaterial(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByLabel("Nome", { exact: true }).fill("Ada");
  await button(page, "Continua").click();
  await button(page, /^(Lo faccio dopo|Continua)$/).click();
  await expect(title(page)).toHaveText("Come tieni il materiale per studiare?");
}

test("Setup links the study folder in place, finds its subjects, and the Library keeps in step with the folder", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-linked-user-"));
  const root = studyFolder();
  const before = snapshot(root);
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_PLAN_REPLIES: replies } });
  try {
    const page = await app.firstWindow();
    await toMaterial(page);
    await button(page, "Una cartella con tutto lo studio").click();
    await expect(title(page)).toHaveText("Dov'è la cartella con tutto lo studio?");
    await expect(title(page)).toBeFocused();
    await expect(page.getByText("Trascinala qui")).toBeVisible();
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "linked-folders/2-folder.png");

    await answerPicker(app, [root]);
    await button(page, "Scegli la cartella").click();
    await expect(title(page)).toHaveText("Ho trovato 3 materie", { timeout: 60000 });
    await expect(page.getByText("Documenti › Università", { exact: true })).toBeVisible();
    const found = page.getByRole("list", { name: "Materie trovate" });
    const name = (folder: string) =>
      found.getByRole("textbox", { name: `Nome della materia della cartella ${folder}` });
    await expect(name("Fisica 1")).toHaveValue("Fisica I");
    await expect(name("Analisi 2")).toHaveValue("Analisi matematica II");
    await expect(name("GAL")).toHaveValue("Geometria e algebra lineare");
    await expect(found.getByText("dalla cartella Fisica 1")).toBeVisible();
    await expect(found.getByText("libro, temi d'esame")).toBeVisible();
    await expect(
      found.getByText("La cartella Erasmus non sembra materiale di studio, quindi la salto."),
    ).toBeVisible();
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "linked-folders/3-subjects.png");

    // A name left empty is asked for, next to its field, before setup ends.
    await name("GAL").fill("");
    await button(page, "Inizia a studiare").click();
    await expect(name("GAL")).toHaveAttribute("aria-invalid", "true");
    await expect(found.getByText("Scrivi il nome della materia.")).toBeVisible();
    await name("GAL").fill("Geometria e algebra lineare");
    await name("Fisica 1").fill("Fisica");
    // The student says Erasmus is a subject after all.
    await button(page, "Erasmus è una materia").click();
    await expect(name("Erasmus")).toHaveValue("Erasmus");
    await expect(title(page)).toHaveText("Ho trovato 4 materie");
    // Another folder can be added, and Back keeps what was corrected.
    await button(page, "Aggiungi un'altra cartella").click();
    await expect(title(page)).toHaveText("Dov'è la cartella con tutto lo studio?");
    await button(page, "Indietro").click();
    await expect(name("Fisica 1")).toHaveValue("Fisica");
    await button(page, "Inizia a studiare").click();
    await expect(page).toHaveURL(/#\/ask$/);

    // The subjects exist, and every file is read in place under its subject. Nothing is copied.
    const subjects = (await page.evaluate(() => window.pyxis.invoke("subjects.list", {}))).map((row) => row.name);
    expect(subjects.sort()).toEqual(["Analisi matematica II", "Erasmus", "Fisica", "Geometria e algebra lineare"]);
    await expect
      .poll(async () => (await listed(page)).map((row) => `${row.title}|${row.subject}|${row.status}`).sort(), {
        timeout: 90000,
      })
      .toEqual([
        "Appunti integrali|Analisi matematica II|ready",
        "Dispense matrici|Geometria e algebra lineare|ready",
        "Febbraio 2025|Fisica|ready",
        "Learning agreement|Erasmus|ready",
        "Mazzoldi cap 2|Fisica|ready",
      ]);
    expect((await listed(page)).every((row) => row.linked?.folder === "Università")).toBe(true);
    // Reading the folder wrote nothing in it.
    expect(snapshot(root)).toEqual(before);

    // The Library shows the subject on each row.
    await page.evaluate(() => {
      location.hash = "/exams/library";
    });
    const row = (titleText: string) =>
      page.locator(".px-source-row").filter({ has: page.getByText(titleText, { exact: true }) });
    await expect(row("Mazzoldi cap 2").locator(".px-source-row-meta")).toContainText("Fisica");

    // A file added while Pyxis runs is read by itself, under its folder's subject.
    writeFileSync(join(root, "Fisica 1", "Lezione 5.pdf"), onePagePdf("Il moto circolare uniforme ha accelerazione centripeta"));
    await expect
      .poll(async () => (await listed(page)).find((source) => source.title === "Lezione 5")?.status, {
        timeout: 60000,
      })
      .toBe("ready");
    expect((await listed(page)).find((source) => source.title === "Lezione 5")?.subject).toBe("Fisica");
    // A file deleted from the folder keeps its text, and the Library says it was moved or deleted.
    rmSync(join(root, "GAL", "Dispense matrici.pdf"));
    await expect
      .poll(async () => (await listed(page)).find((source) => source.title === "Dispense matrici")?.linked?.missing, {
        timeout: 60000,
      })
      .toBe(true);
    await expect(row("Dispense matrici")).toContainText("Spostato o cancellato dalla cartella Università");
    // A scan read from the folder whose file is then deleted has nothing to read, and offers no Replace: a linked
    // file is replaced in its folder.
    writeFileSync(join(root, "GAL", "Lavagna.pdf"), onePagePdf("Lavagna"));
    await expect
      .poll(async () => (await listed(page)).find((source) => source.title === "Lavagna")?.status, { timeout: 60000 })
      .toBe("needs-ocr");
    rmSync(join(root, "GAL", "Lavagna.pdf"));
    const scanNotice = page.getByText("Lavagna non ha testo e Pyxis non ha più il file da leggere.");
    await expect(scanNotice).toBeVisible({ timeout: 60000 });
    await expect(button(page, /^(Sostituisci il file|Replace file)$/)).toHaveCount(0);
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "linked-folders/4-library.png");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dirname(dirname(root)), { recursive: true, force: true });
  }
});

test("Setup links one folder per subject, and never skips a folder the student picked", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-linked-user-"));
  const root = studyFolder();
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_PLAN_REPLIES: replies } });
  try {
    const page = await app.firstWindow();
    await toMaterial(page);
    await button(page, "Una cartella per ogni materia").click();
    await expect(title(page)).toHaveText("Dove sono le cartelle delle materie?");
    // A picker that fails in main says so on the screen.
    await app.evaluate(({ dialog }) => {
      delete process.env["PYXIS_E2E_FILE"];
      dialog.showOpenDialog = (async () => {
        throw new Error("core-busy");
      }) as typeof dialog.showOpenDialog;
    });
    await button(page, "Scegli le cartelle").click();
    await expect(page.getByText("Non sono riuscito a leggere la cartella. Riprova.")).toBeVisible();
    await expect(title(page)).toHaveText("Dove sono le cartelle delle materie?");
    await answerPicker(app, [join(root, "Fisica 1"), join(root, "Erasmus")]);
    await button(page, "Scegli le cartelle").click();
    await expect(title(page)).toHaveText("Ho trovato 2 materie", { timeout: 60000 });
    const found = page.getByRole("list", { name: "Materie trovate" });
    await expect(found.getByRole("textbox", { name: "Nome della materia della cartella Fisica 1" })).toHaveValue(
      "Fisica I",
    );
    await expect(found.getByRole("textbox", { name: "Nome della materia della cartella Erasmus" })).toHaveValue(
      "Erasmus",
    );
    await expectNoAxeViolations(page);
    await button(page, "Inizia a studiare").click();
    await expect(page).toHaveURL(/#\/ask$/);
    // The exam papers in a subfolder of Fisica 1 belong to Fisica I, not to a subject of their own.
    await expect
      .poll(async () => (await listed(page)).map((row) => `${row.title}|${row.subject}`).sort(), { timeout: 90000 })
      .toEqual(["Febbraio 2025|Fisica I", "Learning agreement|Erasmus", "Mazzoldi cap 2|Fisica I"]);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dirname(dirname(root)), { recursive: true, force: true });
  }
});

test("Setup again opens on the linked folders, renames a subject in place, adds a folder and ends without linking again", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-linked-user-"));
  const root = studyFolder();
  // A second folder for a subject that lives elsewhere: files at its top, so the folder itself is the subject.
  const chemistry = join(mkdtempSync(join(tmpdir(), "pyxis-linked-more-")), "Chimica");
  mkdirSync(chemistry);
  writeFileSync(join(chemistry, "Atomi.pdf"), onePagePdf("Un atomo ha un nucleo di protoni e neutroni"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_PLAN_REPLIES: replies } });
  try {
    const page = await app.firstWindow();
    await toMaterial(page);
    await button(page, "Una cartella con tutto lo studio").click();
    await answerPicker(app, [root]);
    await button(page, "Scegli la cartella").click();
    await expect(title(page)).toHaveText("Ho trovato 3 materie", { timeout: 60000 });
    await button(page, "Inizia a studiare").click();
    await expect(page).toHaveURL(/#\/ask$/);
    const subjects = () => page.evaluate(() => window.pyxis.invoke("subjects.list", {}));
    const physics = (await subjects()).find((row) => row.name === "Fisica I");
    expect(physics).toBeDefined();

    // Settings > Profile > Run setup again goes through all three steps.
    await page.evaluate(() => {
      location.hash = "/settings/profile";
    });
    await button(page, "Rifai la configurazione").click();
    await expect(page.locator("[aria-current=step]")).toHaveText("Passo 1 di 3: 1 · Tu");
    await expect(page.getByLabel("Nome", { exact: true })).toHaveValue("Ada");
    await button(page, "Continua").click();
    await button(page, /^(Lo faccio dopo|Continua)$/).click();

    // The material step opens on what is linked already, with the names the student confirmed.
    await expect(page.locator("[aria-current=step]")).toHaveText("Passo 3 di 3: 3 · Il materiale");
    await expect(title(page)).toHaveText("Ho trovato 3 materie");
    await expect(page.getByText("Documenti › Università", { exact: true })).toBeVisible();
    const found = page.getByRole("list", { name: "Materie trovate" });
    const name = (folder: string) =>
      found.getByRole("textbox", { name: `Nome della materia della cartella ${folder}` });
    await expect(name("Fisica 1")).toHaveValue("Fisica I");
    await expect(name("Analisi 2")).toHaveValue("Analisi matematica II");
    await expect(
      found.getByText("La cartella Erasmus non sembra materiale di studio, quindi la salto."),
    ).toBeVisible();
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "linked-folders/5-again.png");

    // A subject is renamed and another folder is added; the rename survives the trip to the picker.
    await name("Fisica 1").fill("Fisica");
    await button(page, "Aggiungi un'altra cartella").click();
    await answerPicker(app, [chemistry]);
    await button(page, "Scegli la cartella").click();
    await expect(title(page)).toHaveText("Ho trovato 4 materie", { timeout: 60000 });
    await expect(name("Fisica 1")).toHaveValue("Fisica");
    await expect(name("Chimica")).toHaveValue("Chimica");
    await button(page, "Salva e torna alle impostazioni").click();
    await expect(page).toHaveURL(/#\/settings\/profile$/);

    // The renamed subject is the same subject, so its exams and plans stay with it. No folder was linked twice.
    const after = await subjects();
    expect(after.map((row) => row.name).sort()).toEqual([
      "Analisi matematica II",
      "Chimica",
      "Fisica",
      "Geometria e algebra lineare",
    ]);
    expect(after.find((row) => row.name === "Fisica")?.id).toBe(physics!.id);
    expect(await page.evaluate(() => window.pyxis.invoke("sources.linkedFolders", {}))).toHaveLength(2);
    await expect
      .poll(async () => (await listed(page)).map((row) => `${row.title}|${row.subject}`).sort(), { timeout: 90000 })
      .toEqual([
        "Appunti integrali|Analisi matematica II",
        "Atomi|Chimica",
        "Dispense matrici|Geometria e algebra lineare",
        "Febbraio 2025|Fisica",
        "Mazzoldi cap 2|Fisica",
      ]);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dirname(dirname(root)), { recursive: true, force: true });
    rmSync(dirname(chemistry), { recursive: true, force: true });
  }
});
