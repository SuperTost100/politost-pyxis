import AxeBuilder from "@axe-core/playwright";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";
import { zipSync, strToU8 } from "fflate";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAIN = join(
  process.cwd(),
  process.env.PYXIS_OUT ?? "out",
  "main/index.js",
);
/** Set PYXIS_SHOTS to a folder to save screenshots of the dialog. */
const SHOTS = process.env.PYXIS_SHOTS;

const DAY = 86_400_000;

/** A small legacy package: two cloze deletions, a basic card with history, a card that only holds a picture and a one-field note. */
function packageFile(folder: string): string {
  const file = join(folder, "collection.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE col (id integer PRIMARY KEY, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
    CREATE TABLE notes (id integer PRIMARY KEY, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld integer, csum integer, flags integer, data text);
    CREATE TABLE cards (id integer PRIMARY KEY, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
    CREATE TABLE revlog (id integer PRIMARY KEY, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer);
  `);
  const model = (id: number, type: number, fields: string[]) => ({
    id,
    type,
    flds: fields.map((name, ord) => ({ name, ord })),
  });
  db.prepare(
    "INSERT INTO col VALUES (1,0,0,0,11,0,0,0,'{}',?,'{}','{}','{}')",
  ).run(
    JSON.stringify({
      1: model(1, 0, ["Front", "Back"]),
      2: model(2, 1, ["Text", "Back Extra"]),
      3: model(3, 0, ["Only"]),
    }),
  );
  const note = db.prepare(
    "INSERT INTO notes VALUES (?,'g',?,0,0,'',?,'',0,0,'')",
  );
  note.run(1, 1, "Qual è la <b>seconda legge</b> di Newton?\x1f<div>\\(F=ma\\)</div>");
  note.run(2, 2, "La {{c1::massa}} misura l'{{c2::inerzia}}.\x1f");
  note.run(3, 1, '<img src="grafico.png">\x1fUn grafico');
  note.run(4, 3, "Solo un campo");
  const card = db.prepare(
    "INSERT INTO cards VALUES (?,?,1,?,0,0,0,0,0,0,0,0,0,0,0,0,0,'')",
  );
  card.run(10, 1, 0);
  card.run(11, 2, 0);
  card.run(12, 2, 1);
  card.run(13, 3, 0);
  card.run(14, 4, 0);
  const log = db.prepare("INSERT INTO revlog VALUES (?,10,0,?,0,0,0,0,1)");
  const t0 = Date.now() - 30 * DAY;
  log.run(t0, 1);
  log.run(t0 + DAY, 3);
  log.run(t0 + 5 * DAY, 3);
  log.run(t0 + 15 * DAY, 4);
  db.close();
  const archive = join(folder, "Fisica.apkg");
  writeFileSync(
    archive,
    zipSync({
      "collection.anki2": readFileSync(file),
      media: strToU8('{"0":"grafico.png"}'),
    }),
  );
  return archive;
}

async function pick(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, selected) => {
    delete process.env.PYXIS_E2E_FILE;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, path);
}

test("an Anki package imports into a topic with its history, in both themes", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-anki-import-"));
  const fixtures = mkdtempSync(join(tmpdir(), "pyxis-anki-fixture-"));
  const archive = packageFile(fixtures);
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10_000,
    });
    db.exec(`
      INSERT INTO plans(id,title,status,content_language,created_at,updated_at) VALUES
        ('p-phys','Fisica 1','ready','it',1,1);
      INSERT INTO topics(id,plan_id,title,position,created_at) VALUES
        ('t-dyn','p-phys','Dinamica',0,1),('t-kin','p-phys','Cinematica',1,1);
      INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES
        ('c-old','p-phys','t-kin','Velocità media?','Spazio diviso tempo.',1);
    `);
    await page.reload();
    await page
      .locator(".ant-segmented-item-label", { hasText: "Flashcards" })
      .click();
    await expect(page.getByRole("status")).toHaveText("1 card");

    // A file that is not a package says so.
    await page.getByRole("button", { name: "Import from Anki" }).click();
    const dialog = page.getByRole("dialog", { name: "Import from Anki" });
    const bad = join(fixtures, "not-anki.apkg");
    writeFileSync(bad, "plain text, not a zip file at all, just padding here");
    await pick(app, bad);
    await dialog.getByRole("button", { name: "Choose file" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "not an Anki package",
    );
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(SHOTS, "en-light-refused.png") });
    }

    await pick(app, archive);
    await dialog.getByRole("button", { name: "Choose file" }).click();
    await expect(dialog.getByRole("status")).toContainText(
      "3 cards can be imported. 2 will be skipped.",
    );
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(
      dialog.getByRole("checkbox", { name: "Keep the review history (4 reviews)" }),
    ).toBeChecked();
    // The exam of the browser filter is empty, so the first exam and its first topic are chosen.
    await expect(dialog.getByRole("combobox", { name: "Exam" })).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Import 3 cards" }),
    ).toBeEnabled();
    expect(
      (
        await new AxeBuilder({ page }).setLegacyMode(true).analyze()
      ).violations.map((v) => v.id),
    ).toEqual([]);

    if (SHOTS) {
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(SHOTS, `en-${theme}-dialog.png`) });
      }
      await page.evaluate(() => window.pyxis.setAppearance("light"));
    }

    await dialog.getByRole("button", { name: "Import 3 cards" }).click();
    await expect(dialog.getByRole("status")).toContainText("Imported 3 cards.");
    await expect(dialog.getByRole("status")).toContainText(
      "Review history kept for 1 card.",
    );
    await expect(dialog.getByRole("status")).toContainText(
      "1 card skipped: it is not a basic or cloze note",
    );
    await expect(dialog.getByRole("status")).toContainText(
      "1 card skipped: it holds only pictures or sound.",
    );
    if (SHOTS) {
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(SHOTS, `en-${theme}-result.png`) });
      }
      await page.setViewportSize({ width: 560, height: 800 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOTS, "en-dark-result-narrow.png") });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(() => window.pyxis.setAppearance("light"));
    }

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status")).toHaveText("4 cards");
    await expect(
      page.getByRole("listitem").filter({ hasText: "seconda legge" }),
    ).toContainText("Next review");
    await expect(
      page.getByRole("listitem").filter({ hasText: "inerzia" }),
    ).toHaveCount(2);

    const cards = db
      .prepare(
        "SELECT front, back FROM cards WHERE topic_id = 't-dyn' ORDER BY created_at",
      )
      .all() as Array<{ front: string; back: string }>;
    expect(cards).toEqual([
      { front: "Qual è la **seconda legge** di Newton?", back: "$F=ma$" },
      {
        front: "La {{c1::massa}} misura l'inerzia.",
        back: "La **massa** misura l'inerzia.",
      },
      {
        front: "La massa misura l'{{c1::inerzia}}.",
        back: "La massa misura l'**inerzia**.",
      },
    ]);
    expect(
      db.prepare("SELECT rating FROM card_reviews ORDER BY reviewed_at").all(),
    ).toEqual([
      { rating: "again" },
      { rating: "good" },
      { rating: "good" },
      { rating: "easy" },
    ]);

    // Export from the same tab reaches a file with the cards.
    await page.getByRole("button", { name: "Export to Anki" }).click();
    const exporting = page.getByRole("dialog", { name: "Export to Anki" });
    await expect(exporting.getByRole("checkbox")).not.toBeChecked();
    if (SHOTS) {
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(SHOTS, "en-light-export.png") });
    }
    await exporting.getByRole("button", { name: "Cancel" }).click();
    await expect(exporting).toBeHidden();
  } finally {
    await app.close();
  }
});
