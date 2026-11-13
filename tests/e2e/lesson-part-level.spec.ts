import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { partText } from "./part-texts";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { animationsSettled } from "./settled";
import { saveShot } from "./shots";

// The level of a part and its rewrites, with the recorded engine: "Livello" on part 2 writes it again at the level
// chosen and part 3, written ahead before, follows it; "Riscrivi questa parte" with its dialog; one section of a part
// rewritten; a rewrite that fails and Riprova; and the part's menu from the dots, a right-click and Shift+F10.

/** Six passages of about 3,000 characters, which the recorded outline cuts into three parts, and the recap after them. */
const passages = Array.from({ length: 6 }, (_, i) => ({
  id: `pa-${i + 1}`,
  text: `Passaggio ${i + 1} del capitolo sulle funzioni di più variabili. `.repeat(46),
  section: `2.${Math.floor(i / 2) + 1}`,
}));

const outline = {
  lessonParts: [
    { title: "Intorni e distanza", about: "Misurare la distanza tra due punti.", passages: ["P1", "P2"] },
    { title: "Interno, esterno, frontiera", about: "Dove sta un punto rispetto a un insieme.", passages: ["P3", "P4"] },
    { title: "Insiemi aperti e chiusi", about: "Quando un insieme è aperto o chiuso.", passages: ["P5", "P6"] },
  ],
};

const fence = (kind: string, body: unknown) => ["```" + kind, JSON.stringify(body), "```"].join("\n");

/** The reply for the second section of part 2, rewritten: new prose, the part's question, a new takeaway. */
const sectionText = [
  "## Frontiera: un esempio nuovo",
  "",
  Array.from({ length: 14 }, (_, i) => `Un esempio nuovo sulla frontiera, frase ${i + 1}, con un punto e un disco.`).join(" "),
  "",
  fence("pyxis-check", {
    question: "Dove sta un punto della frontiera?",
    options: ["Una cosa sbagliata", "La cosa giusta", "Un'altra cosa"],
    answer: 1,
    explanation: "Lo dice l'esempio nuovo.",
  }),
  "",
  fence("pyxis-takeaway", { text: "La frontiera, con un esempio nuovo: ogni intorno tocca dentro e fuori." }),
].join("\n");

/** The letter of the final question's option that reads `text`: options are drawn in their own order. */
async function letterOf(page: Page, text: string): Promise<string> {
  const options = await page.getByRole("region", { name: "Verifica" }).locator(".px-opt-text").allInnerTexts();
  const index = options.findIndex((option) => option.trim() === text);
  expect(index, `"${text}" among ${options.join(", ")}`).toBeGreaterThanOrEqual(0);
  return String.fromCharCode(97 + index);
}

const working = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
const parts = (page: Page) => page.getByRole("navigation", { name: "Parti del capitolo" });
const levelButton = (page: Page) => page.getByRole("button", { name: /^Livello / });
const dots = (page: Page) => page.getByRole("button", { name: "Altre azioni" });

test("a part's level, its rewrites and a section rewritten, with the earlier text readable while they are written", async () => {
  test.setTimeout(300_000);
  const holdDir = mkdtempSync(join(tmpdir(), "pyxis-part-level-hold-"));
  const simpleHold = join(holdDir, "simple");
  const againHold = join(holdDir, "again");
  const userData = mkdtempSync(join(tmpdir(), "pyxis-part-level-"));
  const app = await launchPyxis({
    userData,
    env: {
      PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
        lessonParts: outline,
        markdown: [
          { markdown: partText("Intorni") },
          { markdown: partText("Frontiera") },
          { markdown: partText("Aperti") },
          // "Semplice" on part 2, then part 3 written again ahead at that level.
          { markdown: partText("Frontiera semplice"), hold: simpleHold },
          { markdown: partText("Aperti semplice") },
          // "Riscrivi questa parte" on part 2, then its second section.
          { markdown: partText("Frontiera di nuovo"), hold: againHold },
          { markdown: sectionText },
          // Writing part 2 again fails, and Riprova writes it.
          { fail: "engine down" },
          { markdown: partText("Frontiera riprovata") },
          // "Tecnico" on part 2 fails.
          { fail: "engine down" },
        ],
      }),
      PYXIS_E2E_PLAN_DELAY: "300",
    },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const db = () => new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  /** The tags of the texts each part points at, as `partText` names them in its first heading. */
  const shown = () => {
    const read = db();
    const rows = read
      .prepare(
        `SELECT p.position, json_extract(i.body_json, '$.markdown') AS markdown FROM lesson_parts p
         LEFT JOIN items i ON i.id = p.item_id ORDER BY p.position`,
      )
      .all() as Array<{ position: number; markdown: string | null }>;
    read.close();
    return rows.map((row) => /^## (.+): l'idea$/m.exec(row.markdown ?? "")?.[1] ?? null);
  };
  const jobCount = () => {
    const read = db();
    const count = read.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'lesson-part'").get() as { n: number };
    read.close();
    return count.n;
  };
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const seeding = db();
    seedSubjects(seeding, [{ id: "an2", name: "Analisi 2" }]);
    seedSource(seeding, { id: "bramanti", title: "Bramanti, Pagani, Salsa", subjectId: "an2", document: { id: "bramanti-doc" }, passages });
    seedPlan(seeding, {
      id: "p-an2",
      subjectId: "an2",
      title: "Analisi Matematica 2",
      language: "it",
      sourceIds: ["bramanti"],
      topics: [{ id: "t-funzioni", title: "Funzioni di più variabili" }],
    });
    for (const passage of passages)
      seeding.prepare("INSERT INTO topic_passages(topic_id,passage_id) VALUES(?,?)").run("t-funzioni", passage.id);
    seeding.close();
    await page.reload();

    // Part 1 read and answered, part 2 opened and answered: both done, and part 3 written ahead.
    await page.evaluate(() => {
      location.hash = "/plans/p-an2/lesson/t-funzioni";
    });
    await expect(page.getByText("Intorni: l'idea")).toBeVisible({ timeout: 30_000 });
    await expect(levelButton(page)).toHaveText(/Bilanciato/);
    await page.getByRole("heading", { level: 1 }).focus();
    await page.keyboard.press(await letterOf(page, "La cosa giusta"));
    await expect(page.getByRole("button", { name: /^Continua/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Frontiera: l'idea")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("heading", { level: 1 }).focus();
    await page.keyboard.press(await letterOf(page, "La cosa giusta"));
    await expect(page.getByRole("button", { name: /^Continua/ })).toBeFocused();
    await expect.poll(shown, { timeout: 30_000 }).toEqual(["Intorni", "Frontiera", "Aperti", null]);

    // "Livello" on a part is the old lesson's menu, and says what the level applies to.
    await levelButton(page).click();
    await expect(page.getByText("Vale per questa parte e per le prossime")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Bilanciato" })).toHaveClass(/ant-dropdown-menu-item-selected/);
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await page.getByRole("menuitem", { name: "Semplice" }).click();
    // The part is written again in place, over the text it has now, which stays readable; the page moves up to it from
    // the foot, where the answer left the student, and the button names the level being written.
    await expect(working(page, "Sto riscrivendo la parte 2")).toBeVisible();
    await expect(working(page, "Sto riscrivendo la parte 2")).toBeInViewport();
    await expect(levelButton(page)).toHaveText(/Semplice/);
    await expect(page.getByText("Al livello Semplice.", { exact: false })).toBeVisible();
    await expect(page.getByText("Frontiera: l'idea")).toBeVisible();
    await expect(levelButton(page)).toBeDisabled();
    await expectNoAxeViolations(page);
    await saveShot(page, "lesson-part-level/rewriting-it-light.png");
    writeFileSync(simpleHold, "");
    await expect(page.getByText("Frontiera semplice: l'idea")).toBeVisible({ timeout: 30_000 });
    await expect(working(page, "Sto riscrivendo la parte 2")).toHaveCount(0);
    await expect(page.getByText("Frontiera: l'idea")).toHaveCount(0);
    await expect(levelButton(page)).toHaveText(/Semplice/);
    await expect(page.getByRole("heading", { level: 1, name: "Interno, esterno, frontiera" })).toBeFocused();
    // The new text has its own question, open again, and the part stays done.
    await expect(page.getByText("Giusto.", { exact: true })).toHaveCount(0);
    await expect(parts(page).getByRole("link", { name: /Interno, esterno, frontiera.*letta/ })).toBeVisible();
    await expect(page.getByText("Riassunto di frontiera semplice: la cosa giusta.", { exact: false })).toBeVisible();
    // Part 3, written ahead at the earlier level, is written again at the level chosen; part 1, done, keeps its text.
    await expect.poll(shown, { timeout: 30_000 }).toEqual(["Intorni", "Frontiera semplice", "Aperti semplice", null]);

    // "Riscrivi questa parte": the dialog, which Annulla closes with nothing started.
    const jobs = jobCount();
    await dots(page).click();
    await page.getByRole("menuitem", { name: "Riscrivi questa parte" }).click();
    const confirm = page.getByRole("dialog", { name: "Riscrivere questa parte?" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("quello che hai già finito resta finito");
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "lesson-part-level/rewrite-dialog-it-light.png");
    await confirm.getByRole("button", { name: "Annulla" }).click();
    await expect(confirm).toHaveCount(0);
    expect(jobCount()).toBe(jobs);
    // Confirmed: the working state in place, then the new text with its question open again, and the part done.
    await dots(page).click();
    await page.getByRole("menuitem", { name: "Riscrivi questa parte" }).click();
    await page.getByRole("dialog", { name: "Riscrivere questa parte?" }).getByRole("button", { name: "Riscrivi" }).click();
    await expect(working(page, "Sto riscrivendo la parte 2")).toBeVisible();
    await expect(page.getByText("Finché la nuova versione non è pronta, quella di adesso resta qui sotto.")).toBeVisible();
    await expect(page.getByText("Frontiera semplice: l'idea")).toBeVisible();
    // Its open question takes no pick while the text under it is about to change.
    await expect(page.getByRole("region", { name: "Verifica" }).getByRole("button").first()).toBeDisabled();
    writeFileSync(againHold, "");
    await expect(page.getByText("Frontiera di nuovo: l'idea")).toBeVisible({ timeout: 30_000 });
    await expect(levelButton(page)).toHaveText(/Semplice/);
    await expect(parts(page).getByRole("link", { name: /Interno, esterno, frontiera.*letta/ })).toBeVisible();
    await page.getByRole("heading", { level: 1 }).focus();
    await page.keyboard.press(await letterOf(page, "La cosa giusta"));
    await expect(page.getByText("Giusto.", { exact: true })).toBeVisible();

    // One section of the part: the dialog lists the part's sections, and only the one chosen changes.
    await dots(page).click();
    await page.getByRole("menuitem", { name: "Riscrivi una sezione" }).click();
    const sections = page.getByRole("dialog", { name: "Quale sezione riscrivo?" });
    await expect(sections.getByText("Il resto della parte resta com'è.")).toBeVisible();
    await expect(sections.getByRole("radio")).toHaveCount(2);
    await sections.getByRole("radio", { name: "Frontiera di nuovo: un esempio" }).check();
    await sections.getByRole("textbox").fill("Con un esempio più semplice");
    await animationsSettled(page);
    await saveShot(page, "lesson-part-level/section-dialog-it-light.png");
    await sections.getByRole("button", { name: "Riscrivi" }).click();
    await expect(sections).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 2, name: "Frontiera: un esempio nuovo" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Frontiera di nuovo: l'idea" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Frontiera di nuovo: un esempio" })).toHaveCount(0);
    // The part keeps its one question at the end, open again, and the foot has the new summary.
    await expect(page.getByRole("region", { name: "Verifica" })).toContainText("Dove sta un punto della frontiera?");
    await expect(page.getByText("Giusto.", { exact: true })).toHaveCount(0);
    await expect(page.getByText("La frontiera, con un esempio nuovo: ogni intorno tocca dentro e fuori.")).toBeVisible();

    // Writing the part again fails: the failure is in place, the text stays, and Riprova writes it.
    await dots(page).click();
    await page.getByRole("menuitem", { name: "Riscrivi questa parte" }).click();
    await page.getByRole("dialog", { name: "Riscrivere questa parte?" }).getByRole("button", { name: "Riscrivi" }).click();
    const failed = page.getByText("Non sono riuscito a riscrivere la parte 2. La versione di adesso non è cambiata.");
    await expect(failed).toBeVisible({ timeout: 30_000 });
    await expect(failed).toBeInViewport();
    await expect(page.getByRole("heading", { level: 2, name: "Frontiera: un esempio nuovo" })).toBeVisible();
    await expectNoAxeViolations(page);
    await saveShot(page, "lesson-part-level/rewrite-failed-it-light.png");
    await page.getByRole("button", { name: "Riprova" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Frontiera riprovata: l'idea" })).toBeVisible({ timeout: 30_000 });
    await expect(failed).toHaveCount(0);
    await expect(parts(page).getByRole("link", { name: /Interno, esterno, frontiera.*letta/ })).toBeVisible();

    // A level that fails: the menu names the level of the text on screen, and the failure names the one that failed.
    await levelButton(page).click();
    await page.getByRole("menuitem", { name: "Tecnico" }).click();
    const levelFailed = page.getByText("Non sono riuscito a riscrivere la parte 2 al livello Tecnico.", { exact: false });
    await expect(levelFailed).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 2, name: "Frontiera riprovata: l'idea" })).toBeVisible();
    await expect(levelButton(page)).toHaveText(/Semplice/);
    await levelButton(page).click();
    await expect(page.getByRole("menuitem", { name: "Semplice" })).toHaveClass(/ant-dropdown-menu-item-selected/);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Tieni questa versione" }).click();
    await expect(levelFailed).toHaveCount(0);

    // The part's menu from the keyboard: the dots, a right-click and Shift+F10 open it, and one Escape closes only it.
    await dots(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Riscrivi questa parte" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem", { name: "Riscrivi questa parte" })).toHaveCount(0);
    await expect(dots(page)).toBeFocused();
    await expect(page).toHaveURL(/\/lesson\/t-funzioni\?part=2$/);
    await page.getByRole("heading", { level: 1 }).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Riscrivi una sezione" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem", { name: "Riscrivi una sezione" })).toHaveCount(0);
    await page.getByRole("heading", { level: 1 }).focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menuitem", { name: "Riscrivi questa parte" })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Riscrivi questa parte" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Riscrivere questa parte?" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Riscrivere questa parte?" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/lesson\/t-funzioni\?part=2$/);
    // Riscrivi questa parte twice, the second one retried: two jobs. "Tecnico"'s failed job went with "Tieni questa
    // versione", and the section was rewritten by the page's own call.
    expect(jobCount()).toBe(jobs + 2);

    // Part 3 opens at the level chosen on part 2.
    await page.getByRole("button", { name: /^Continua/ }).click();
    await expect(page.getByText("Aperti semplice: l'idea")).toBeVisible({ timeout: 30_000 });
    await expect(levelButton(page)).toHaveText(/Semplice/);

    // Back on part 1, done at "Bilanciato", the student picks "Bilanciato" for the parts to come: core keeps it on the
    // outline, with nothing to write, and the menu still says what the level applies to.
    await parts(page).getByRole("link", { name: /Intorni e distanza/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Intorni: l'idea" })).toBeVisible({ timeout: 30_000 });
    await expect(levelButton(page)).toHaveText(/Bilanciato/);
    const before = jobCount();
    await levelButton(page).click();
    await expect(page.getByText("Vale per questa parte e per le prossime")).toBeVisible();
    await page.getByRole("menuitem", { name: "Bilanciato" }).click();
    const outlineWording = () => {
      const read = db();
      const row = read.prepare("SELECT wording FROM lesson_outlines WHERE topic_id = 't-funzioni'").get() as { wording: string | null };
      read.close();
      return row.wording;
    };
    await expect.poll(outlineWording).toBe("balanced");
    await expect(levelButton(page)).toHaveText(/Bilanciato/);
    expect(jobCount()).toBe(before);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(holdDir, { recursive: true, force: true });
  }
});
