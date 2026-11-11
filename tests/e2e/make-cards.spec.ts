import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { animationsSettled } from "./settled";
import { SHOTS, saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";


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
  seedSubjects(db, [{ id: "s-mat", name: "Analisi" }]);
  seedSource(db, {
    id: "src-an",
    title: "Appunti di analisi",
    document: { id: "d-an" },
    passages: [{ id: "pa1", text: PASSAGE, locator: { chapter: 1, paragraph: "p1" }, section: "1. Integrali" }],
  });
  seedPlan(db, {
    id: "p-an",
    subjectId: "s-mat",
    title: "Analisi 1",
    language: "it",
    target: 0.75,
    updatedAt: 2,
    sourceIds: ["src-an"],
    topics: [{ id: "t-lim", title: "Limiti" }, { id: "t-int", title: "Integrali" }],
  });
  seedPlan(db, {
    id: "p-geo",
    subjectId: "s-mat",
    title: "Geometria",
    language: "it",
    target: 0.75,
    topics: [{ id: "t-mat", title: "Matrici" }],
  });
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
  await page.mouse.move(1, 1);
  await animationsSettled(page);
  await saveShot(page, `${name}.png`);
}

test("flashcards from an Ask answer and from selected text: pick a place, review, then save", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-make-cards-"));
  const env = {
    PYXIS_E2E_REPLY: REPLY,
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({ cards: { cards: CARDS } }),
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
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
      await animationsSettled(page);
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
      await animationsSettled(page);
      await shot(page, "8-reply-action-dark");
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("in the map's dialog a dropped flashcard cannot be saved, its source is named, and the focus has somewhere to go", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-make-cards-drop-"));
  const env = { PYXIS_E2E_PLAN_REPLIES: JSON.stringify({ cards: { cards: CARDS } }) };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    seed(userData);
    await page.evaluate(() => {
      localStorage.setItem("pyxis.lang", "en");
      location.hash = "/ask";
    });
    await page.reload();
    const dialog = page.getByRole("dialog", { name: "Make flashcards" });
    const cards = dialog.getByRole("list", { name: "Proposed flashcards" }).getByRole("listitem");
    const ask = async () => {
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("pyxis:make-cards", {
            detail: { text: "L'integrale per parti", origin: "selection", planId: "p-an", topicId: "t-int", passageIds: ["pa1"] },
          }),
        ),
      );
      await dialog.getByRole("button", { name: "Make flashcards" }).click();
      await expect(cards).toHaveCount(3);
    };

    await ask();
    // The two linked cards name their source; the concept with no passage has no chip.
    await expect(cards.nth(0).getByRole("button", { name: "Appunti di analisi" })).toBeVisible();
    await expect(cards.nth(2).getByRole("button")).toHaveCount(1);

    // With the exit slowed down, the dropped card is out of Save and its count at once.
    await page.evaluate(() => {
      const real = Element.prototype.animate;
      Element.prototype.animate = function (keyframes, options) {
        const slow = typeof options === "number" ? options * 40 : { ...options, duration: Number(options?.duration ?? 0) * 40 };
        return real.call(this, keyframes, slow);
      };
      (window as unknown as { restoreAnimate: () => void }).restoreAnimate = () => {
        Element.prototype.animate = real;
      };
    });
    await cards.nth(0).getByRole("button", { name: "Drop flashcard 1" }).click();
    await page.evaluate(() => (window as unknown as { restoreAnimate: () => void }).restoreAnimate());
    await expect(dialog.getByRole("button", { name: "Save 2 flashcards" })).toBeVisible();
    await expect(dialog.locator(".px-pc-card[data-leaving]")).toHaveCount(1);
    await expect(cards).toHaveCount(2);
    await dialog.getByRole("button", { name: "Save 2 flashcards" }).click();
    await expect(dialog).toHaveCount(0);
    // The rows come back by front: the first card, which was dropped, is not among them.
    expect(rows(userData).map((row) => row.front)).toEqual([
      "Integrando",
      "L'integrale per parti vale {{c1::uv}} meno l'integrale di v du.",
    ]);

    // Every card dropped: the focus goes to "Make again", which is still there.
    await ask();
    for (const n of [3, 2, 1]) {
      await dialog.getByRole("button", { name: `Drop flashcard ${n}` }).click();
      await expect(cards).toHaveCount(n - 1);
    }
    await expect(dialog.getByRole("button", { name: "Make again" })).toBeFocused();
    await expect(dialog.getByText("You dropped every flashcard")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
