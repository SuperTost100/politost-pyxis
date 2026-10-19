import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAIN = join(process.cwd(), process.env.PYXIS_OUT ?? "out", "main/index.js");
/** Set to a folder to also save screenshots of the reply action, the selection menu and the review dialog. */
const SHOTS = process.env.PYXIS_SHOTS_DIR;

const PASSAGE =
  "L'integrale per parti si usa quando l'integrando è un prodotto: la formula vale uv meno l'integrale di v du.";
const REPLY = [
  "Usa l'integrazione per parti [P1].",
  "",
  "La formula è $\\int u\\,dv = uv - \\int v\\,du$.",
].join("\n");

/** The model's recorded answer: a linked question, a cloze and a concept the student will drop. */
const CARDS = [
  {
    kind: "qa",
    front: "Quando si usa l'integrazione per parti?",
    back: "Quando l'integrando è un prodotto di due funzioni.",
    passageId: "{{passage:0}}",
  },
  {
    kind: "cloze",
    text: "L'integrale per parti vale {{c1::uv}} meno l'integrale di v du.",
    extra: "Formula dell'integrazione per parti.",
    passageId: "{{passage:0}}",
  },
  {
    kind: "concept",
    term: "Integrando",
    definition: "La funzione che sta sotto il segno di integrale.",
    passageId: null,
  },
];

function seed(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  db.exec(`
    INSERT INTO subjects(id,name,position,created_at) VALUES('s-mat','Analisi',0,1);
    INSERT INTO sources(id,kind,title,status,library,created_at,updated_at) VALUES('src-an','excerpt','Appunti di analisi','ready',1,1,1);
    INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES('d-an','src-an',1,'{"kind":"excerpt"}',1);
    INSERT INTO plans(id,subject_id,title,status,content_language,target,created_at,updated_at) VALUES
      ('p-an','s-mat','Analisi 1','ready','it',0.75,1,2),
      ('p-geo','s-mat','Geometria','ready','it',0.75,1,1);
    INSERT INTO plan_sources(plan_id,source_id) VALUES('p-an','src-an');
    INSERT INTO topics(id,plan_id,title,position,created_at) VALUES
      ('t-lim','p-an','Limiti',0,1),('t-int','p-an','Integrali',1,1),('t-mat','p-geo','Matrici',0,1);
  `);
  db.prepare(
    "INSERT INTO passages(id,source_id,document_id,text,locator_json,section_path,created_at) VALUES('pa1','src-an','d-an',?,'{\"chapter\":1,\"paragraph\":\"p1\"}','1. Integrali',1)",
  ).run(PASSAGE);
  db.exec("INSERT INTO topic_passages(topic_id,passage_id) VALUES('t-int','pa1')");
  db.close();
}

const rows = (userData: string) => {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  try {
    return db
      .prepare(
        "SELECT front, back, topic_id, passage_id, grounding, prompt_template FROM cards ORDER BY front",
      )
      .all() as Array<Record<string, string | null>>;
  } finally {
    db.close();
  }
};

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test("flashcards from an Ask answer and from selected text: pick a place, review, then save", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-make-cards-"));
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_REPLY: REPLY,
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({ cards: { cards: CARDS } }),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    seed(userData);
    await page.evaluate(() => {
      localStorage.setItem("pyxis.lang", "en");
      location.hash = "/ask";
    });
    await page.reload();
    await page.getByRole("button", { name: /^Subject:/ }).click();
    await page.getByRole("button", { name: "Analisi", exact: true }).click();
    const box = page.getByRole("textbox", { name: "Message" });
    await box.fill("Come si risolve un integrale per parti?");
    await box.press("Enter");
    await expect(page).toHaveURL(/#\/ask\/.+/);
    const make = page.getByRole("button", { name: "Make flashcards" });
    await expect(make).toBeVisible({ timeout: 30_000 });
    await shot(page, "1-reply-action");

    // The reply cites a passage of the Integrali topic, so its plan and topic are already chosen.
    await make.click();
    const dialog = page.getByRole("dialog", { name: "Make flashcards" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Usa l'integrazione per parti")).toBeVisible();
    await expect(dialog.locator("#mc-plan").locator("xpath=ancestor::div[contains(@class,'ant-select')][1]")).toContainText("Analisi 1");
    await expect(dialog.locator("#mc-topic").locator("xpath=ancestor::div[contains(@class,'ant-select')][1]")).toContainText("Integrali");
    await shot(page, "2-dialog-pick");
    await dialog.getByRole("button", { name: "Make flashcards" }).click();
    const cards = dialog.getByRole("list", { name: "Proposed flashcards" }).getByRole("listitem");
    await expect(cards).toHaveCount(3);
    expect(rows(userData)).toEqual([]);
    // The cloze keeps its markup and says how it works.
    await expect(cards.nth(1).getByRole("textbox", { name: "Front" })).toHaveValue(/\{\{c1::uv\}\}/);
    await expect(cards.nth(1)).toContainText("hidden when you study");
    await shot(page, "3-dialog-review");

    // Edit one, drop one, keep the rest.
    await cards.nth(0).getByRole("textbox", { name: "Back" }).fill("Quando l'integrando è un prodotto.");
    await cards.nth(2).getByRole("button", { name: "Drop flashcard 3" }).click();
    await expect(cards).toHaveCount(2);
    await dialog.getByRole("button", { name: "Save 2 flashcards" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Saved 2 flashcards to Integrali.")).toBeVisible();
    expect(rows(userData)).toEqual([
      {
        front: "L'integrale per parti vale {{c1::uv}} meno l'integrale di v du.",
        back: "Formula dell'integrazione per parti.",
        topic_id: "t-int",
        passage_id: "pa1",
        grounding: "sources",
        prompt_template: "cards.text",
      },
      {
        front: "Quando si usa l'integrazione per parti?",
        back: "Quando l'integrando è un prodotto.",
        topic_id: "t-int",
        passage_id: "pa1",
        grounding: "sources",
        prompt_template: "cards.text",
      },
    ]);
    // They are ordinary new cards: due at once.
    const due = (await page.evaluate(() =>
      window.pyxis.invoke("study.cards", { planId: "p-an", topicId: "t-int" }),
    )) as unknown[];
    expect(due).toHaveLength(2);

    // Selected text in a source: the passage picks the topic again. Saving the same cards adds nothing.
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("pyxis:source-viewer", { detail: { passageId: "pa1" } })),
    );
    const paragraph = page.locator(".source-viewer-paragraph p");
    await expect(paragraph).toHaveText(PASSAGE);
    const select = () =>
      paragraph.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
    await select();
    const menu = page.getByRole("group", { name: "Ask the tutor" });
    await expect(menu.getByRole("button")).toHaveText(["Ask the tutor", "Make flashcards", "Copy"]);
    await shot(page, "4-selection-menu");
    await menu.getByRole("button", { name: "Make flashcards" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#mc-topic").locator("xpath=ancestor::div[contains(@class,'ant-select')][1]")).toContainText("Integrali");
    await dialog.getByRole("button", { name: "Make flashcards" }).click();
    await expect(cards).toHaveCount(3);
    await dialog.getByRole("button", { name: "Save 3 flashcards" }).click();
    await expect(page.getByText(/Saved 1 flashcard to Integrali\. 2 were already there\./)).toBeVisible();
    expect(rows(userData)).toHaveLength(3);

    // Cancel leaves nothing behind.
    await select();
    await menu.getByRole("button", { name: "Make flashcards" }).click();
    await dialog.getByRole("button", { name: "Make flashcards" }).click();
    await expect(cards).toHaveCount(3);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(rows(userData)).toHaveLength(3);

    if (SHOTS) {
      await page.evaluate(() => window.pyxis.setAppearance("dark"));
      await page.waitForTimeout(600);
      await select();
      await shot(page, "5-selection-menu-dark");
      await menu.getByRole("button", { name: "Make flashcards" }).click();
      await dialog.getByRole("button", { name: "Make flashcards" }).click();
      await expect(cards).toHaveCount(3);
      await shot(page, "6-dialog-review-dark");
      await page.setViewportSize({ width: 480, height: 800 });
      await shot(page, "7-dialog-review-narrow-dark");
      await page.setViewportSize({ width: 1280, height: 800 });
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await page.locator(".ant-drawer").getByRole("button", { name: "Close" }).click();
      await page.waitForTimeout(600);
      await shot(page, "8-reply-action-dark");
    }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
