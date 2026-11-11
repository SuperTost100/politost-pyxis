import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { animationsSettled } from "./settled";
import { SHOTS, saveShot } from "./shots";

/** The cards in the workspace, oldest first. */
function cards(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  try {
    return db
      .prepare(
        `SELECT c.front, c.back, s.name AS subject, c.plan_id, c.topic_id, c.passage_id, c.prompt_template
         FROM cards c LEFT JOIN subjects s ON s.id = c.subject_id ORDER BY c.created_at, c.rowid`,
      )
      .all() as Array<Record<string, string | null>>;
  } finally {
    db.close();
  }
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.mouse.move(1, 1);
  await animationsSettled(page);
  await saveShot(page, `new-flashcard/${name}.png`);
}

async function toFlashcards(page: Page) {
  await page
    .getByRole("navigation", { name: "Sezioni" })
    .getByRole("link", { name: /^Flashcard\b/ })
    .click();
  await expect(page).toHaveURL(/#\/flashcards$/);
}

test("a flashcard written by hand from the empty Flashcard page, with no exam, lesson, map or AI tool", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-new-flashcard-hand-"));
  // No recorded replies: no AI tool is set up.
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await toFlashcards(page);

    // The empty page says where flashcards come from now, and its one button writes the first.
    await expect(page.getByText(/^Qui compariranno le tue flashcard, divise per materia/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Apri le mappe" })).toHaveCount(0);
    const newButton = page.getByRole("button", { name: "Nuova flashcard", exact: true });
    await expect(newButton).toHaveClass(/px-btn-primary/);
    await shot(page, "1-empty");
    await newButton.click();

    const dialog = page.getByRole("dialog", { name: "Nuova flashcard" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Scrivila tu" })).toHaveAttribute("aria-checked", "true");
    // With no subject at all it starts on "Nuova materia…", its name field focused, and no exam to choose.
    await expect(dialog.getByRole("combobox", { name: "Materia" })).toHaveValue("\u0000new");
    const name = dialog.getByRole("textbox", { name: "Nome della nuova materia" });
    await expect(name).toBeFocused();
    await expect(dialog.getByRole("combobox", { name: /^Esame/ })).toBeHidden();

    // Enter in the one-line name field saves nothing.
    await name.fill("Chimica organica");
    await name.press("Enter");
    await expect(dialog).toBeVisible();

    // Empty faces are refused next to their fields, and the focus goes to the first.
    await dialog.getByRole("button", { name: "Salva", exact: true }).click();
    const front = dialog.getByRole("textbox", { name: "Fronte" });
    const back = dialog.getByRole("textbox", { name: "Retro" });
    await expect(front).toHaveAttribute("aria-invalid", "true");
    await expect(front).toHaveAccessibleDescription(/Scrivi qualcosa sul fronte/);
    await expect(back).toHaveAccessibleDescription(/Scrivi qualcosa sul retro/);
    await expect(front).toBeFocused();
    expect(cards(userData)).toEqual([]);

    // A formula goes in at the caret and shows under the field as the flashcard draws it.
    await front.fill("Formula degli alcani?\nIn una riga.");
    await back.fill("Sono ");
    await dialog.getByRole("button", { name: "Inserisci formula nel retro" }).click();
    await expect(back).toBeFocused();
    await page.keyboard.type("C_nH_{2n+2}");
    await expect(back).toHaveValue("Sono $ C_nH_{2n+2} $");
    await expect(dialog.locator(".px-nc-preview .katex")).toBeVisible();
    await shot(page, "2-hand-new-subject");

    // Escape with text typed asks first, and the safe answer keeps it.
    await page.keyboard.press("Escape");
    const keep = dialog.getByRole("button", { name: "Continua a scrivere" });
    await expect(dialog.getByText("Butti via quello che hai scritto?")).toBeVisible();
    await expect(keep).toBeFocused();
    await keep.click();
    await expect(front).toHaveValue("Formula degli alcani?\nIn una riga.");
    // A second Escape takes the question back, and the dialog stays open with its text.
    await front.focus();
    await page.keyboard.press("Escape");
    await expect(keep).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(keep).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(front).toHaveValue("Formula degli alcani?\nIn una riga.");

    // Pyxis needs an AI tool and says how to set one up; the written card stays on its side.
    await dialog.getByRole("radio", { name: "Falla fare a Pyxis" }).click();
    await expect(dialog.getByRole("radio", { name: "Falla fare a Pyxis" })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByText(/Pyxis scrive le flashcard dal materiale di una materia, e non hai ancora materie/)).toBeVisible();
    await dialog.getByRole("radio", { name: "Scrivila tu" }).click();
    await expect(front).toHaveValue("Formula degli alcani?\nIn una riga.");

    await dialog.getByRole("button", { name: "Salva", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // It is on the page at once, under its new subject, and the focus is back on the button.
    const subject = page.getByRole("region", { name: "Chimica organica" });
    await expect(subject).toContainText("1 flashcard · 1 da ripassare oggi");
    await expect(page.getByRole("button", { name: "Nuova flashcard", exact: true })).toBeFocused();
    expect(cards(userData)).toEqual([
      {
        front: "Formula degli alcani?\nIn una riga.",
        back: "Sono $ C_nH_{2n+2} $",
        subject: "Chimica organica",
        plan_id: null,
        topic_id: null,
        passage_id: null,
        prompt_template: null,
      },
    ]);
    // With a card and nothing else due, the review is the primary button and the new flashcard sits beside it.
    await expect(page.getByRole("button", { name: "Nuova flashcard", exact: true })).toHaveClass(/px-btn-secondary/);
    await expect(page.getByRole("button", { name: "Ripassa la flashcard di oggi" })).toBeVisible();

    // Now the subject exists, Pyxis's side names what it needs: an AI tool, and a way to connect one.
    await page.getByRole("button", { name: "Nuova flashcard", exact: true }).click();
    await dialog.getByRole("radio", { name: "Falla fare a Pyxis" }).click();
    await expect(dialog.getByText(/serve uno strumento AI collegato/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Collega uno strumento" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Crea le flashcard" })).toBeDisabled();
    await shot(page, "3-pyxis-no-engine");
    // Nothing typed: Escape closes at once.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Nuova flashcard", exact: true })).toBeFocused();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

const PASSAGES = [
  "Si dice che f(x) tende a l per x che tende a x0 se per ogni ε > 0 esiste δ > 0 tale che |f(x) − l| < ε.",
  "Il limite destro si calcola solo per x > x0, il limite sinistro solo per x < x0.",
  "Una successione è una funzione definita sui numeri naturali.",
];
const card = (n: number, front: string) => ({
  kind: "qa",
  front,
  back: `La risposta numero ${n}.`,
  passageId: "{{passage:0}}",
});

test("Pyxis writes a subject's flashcards to check before saving, and another page opens the dialog on a subject", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-new-flashcard-pyxis-"));
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
      // The first request fails, the second is slow enough to see Pyxis at work, the third writes thirty.
      subjectCards: [
        { fail: "rate limit reached" },
        {
          delayMs: 2500,
          cards: [
            card(1, "Che cos'è un limite?"),
            card(2, "Quando f(x) tende a l per x che tende a x0?"),
            card(3, "Che cos'è il limite destro?"),
            card(4, "Che cos'è il limite sinistro?"),
          ],
        },
        { cards: Array.from({ length: 30 }, (_, i) => card(i + 1, `Domanda di elettrostatica numero ${i + 1}?`)) },
      ],
    }),
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    try {
      seedSubjects(db, [
        { id: "ana", name: "Analisi 1" },
        { id: "phys", name: "Fisica 2" },
        { id: "geo", name: "Geometria e algebra lineare per l’ingegneria dell’informazione" },
      ]);
      seedSource(db, {
        id: "bramanti",
        subjectId: "ana",
        title: "Bramanti",
        document: { id: "d-bramanti" },
        passages: PASSAGES.map((text, i) => ({ id: `pa${i}`, text, section: "Capitolo 3" })),
      });
      seedSource(db, {
        id: "mazzoldi",
        subjectId: "phys",
        title: "Mazzoldi",
        document: { id: "d-mazzoldi" },
        passages: [{ id: "pf0", text: "Il campo elettrico è la forza per unità di carica.", section: "Elettrostatica" }],
      });
      seedPlan(db, {
        id: "gennaio",
        subjectId: "ana",
        title: "Appello del 14 gennaio",
        language: "it",
        target: 0.75,
        sourceIds: ["bramanti"],
        topics: [
          { id: "limiti", title: "Limiti" },
          { id: "succ", title: "Successioni" },
        ],
      });
      db.exec(`INSERT INTO topic_passages(topic_id,passage_id) VALUES('limiti','pa0'),('limiti','pa1'),('succ','pa2');
        INSERT INTO cards(id,subject_id,front,back,created_at) VALUES('old','ana','Che cos''è un limite?','Già scritta.',1);`);
    } finally {
      db.close();
    }
    await toFlashcards(page);
    const dialog = page.getByRole("dialog", { name: "Nuova flashcard" });
    const open = page.getByRole("button", { name: "Nuova flashcard", exact: true });

    // ---- By hand: the exam is offered for a subject that has one, and "Salva e scrivine un'altra" keeps going.
    await expect(open).toHaveClass(/px-btn-secondary/);
    await open.click();
    const subject = dialog.getByRole("combobox", { name: "Materia" });
    await expect(subject).toHaveValue("ana");
    await expect(subject).toBeFocused();
    const exam = dialog.getByRole("combobox", { name: /^Esame/ });
    await expect(exam).toHaveValue("");
    await exam.selectOption({ label: "Appello del 14 gennaio" });
    const front = dialog.getByRole("textbox", { name: "Fronte" });
    const back = dialog.getByRole("textbox", { name: "Retro" });
    await front.fill("Che cos'è una successione?");
    await back.fill("Una funzione sui naturali.");
    const more = dialog.getByRole("button", { name: /^(Salva e scrivine un’altra|Aggiunta)/ });
    await more.click();
    await expect(more).toContainText("Aggiunta");
    await expect(dialog.getByRole("status").filter({ hasText: "Flashcard aggiunta in Analisi 1." })).toBeAttached();
    await expect(front).toHaveValue("");
    await expect(back).toHaveValue("");
    await expect(front).toBeFocused();
    await expect(subject).toHaveValue("ana");
    await expect(exam).toHaveValue("gennaio");
    expect(cards(userData).at(-1)).toMatchObject({ front: "Che cos'è una successione?", plan_id: "gennaio", topic_id: null });

    // A subject with no exam folds Esame away. A double click on Salva saves one card.
    await subject.selectOption("phys");
    await expect(exam).toBeHidden();
    await front.fill("Che cos'è il campo elettrico?");
    await back.fill("La forza per unità di carica.");
    await dialog.getByRole("button", { name: "Salva", exact: true }).dblclick();
    await expect(dialog).toHaveCount(0);
    expect(cards(userData).filter((row) => row.front === "Che cos'è il campo elettrico?")).toHaveLength(1);
    await expect(page.getByRole("region", { name: "Fisica 2" })).toContainText("1 flashcard");

    // ---- Pyxis: Argomento for a subject with topics, "Su cosa?" and how many.
    await open.click();
    await dialog.getByRole("radio", { name: "Falla fare a Pyxis" }).click();
    await expect(dialog.getByText(/Pyxis le scrive dal materiale di Analisi 1 che hai in Libreria/)).toBeVisible();
    const pySubject = dialog.getByRole("combobox", { name: "Materia" });
    await expect(pySubject).toHaveValue("ana");
    await dialog.getByRole("combobox", { name: "Argomento" }).selectOption({ label: "Limiti" });
    await dialog.getByRole("textbox", { name: /^Su cosa\?/ }).fill("le definizioni di limite");
    await dialog.getByRole("button", { name: "Una in meno" }).click();
    await expect(dialog.getByRole("group", { name: "Quante flashcard" }).getByRole("textbox")).toHaveValue("9");
    await shot(page, "4-pyxis-form");

    // The AI tool fails: the error is in the dialog with Riprova, and nothing is saved.
    const before = cards(userData).length;
    await dialog.getByRole("button", { name: "Crea le flashcard" }).click();
    const failed = dialog.getByRole("alert").filter({ hasText: /Pyxis non è riuscito a scrivere le flashcard|limite/ });
    await expect(failed).toBeVisible();
    expect(cards(userData)).toHaveLength(before);
    await failed.getByRole("button", { name: "Riprova" }).click();

    // At work: the mark in the dialog, the request above it, no switch, and closing asks first.
    await expect(dialog.getByRole("button", { name: "Sto scrivendo" })).toBeDisabled();
    await expect(dialog.getByRole("status").filter({ hasText: "Leggo il materiale e scrivo le flashcard" })).toBeVisible();
    await expect(dialog.getByText("Analisi 1 · Limiti", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("radiogroup")).toHaveCount(0);
    await shot(page, "5-pyxis-working");
    await page.keyboard.press("Escape");
    await expect(dialog.getByText(/Pyxis sta ancora scrivendo/)).toBeVisible();
    await dialog.getByRole("button", { name: "Continua", exact: true }).click();

    // The proposals: the one the subject has already is left out and counted; nothing is saved yet.
    const list = dialog.getByRole("list", { name: "Flashcard proposte" }).getByRole("listitem");
    await expect(list).toHaveCount(3);
    await expect(dialog.getByRole("status").filter({ hasText: "Ne ho scritte 4 su Limiti" })).toContainText(
      "Me ne avevi chieste 9, ma nel materiale non ho trovato altro. Una l’avevi già, quindi l’ho tolta.",
    );
    expect(cards(userData)).toHaveLength(before);
    await shot(page, "6-pyxis-review");
    await list.nth(0).getByRole("textbox", { name: "Retro" }).fill("Per ogni ε esiste δ.");
    await list.nth(2).getByRole("button", { name: "Scarta la flashcard 3" }).click();
    await expect(list).toHaveCount(2);
    await dialog.getByRole("button", { name: "Salva 2 flashcard" }).click();
    await expect(dialog).toHaveCount(0);
    // Each one is linked to a passage of Limiti that matches "Su cosa?", never to the other topic's.
    const topicPassage = expect.stringMatching(/^pa[01]$/);
    expect(cards(userData).slice(before)).toEqual([
      {
        front: "Quando f(x) tende a l per x che tende a x0?",
        back: "Per ogni ε esiste δ.",
        subject: "Analisi 1",
        plan_id: "gennaio",
        topic_id: "limiti",
        passage_id: topicPassage,
        prompt_template: "cards.subject",
      },
      {
        front: "Che cos'è il limite destro?",
        back: "La risposta numero 3.",
        subject: "Analisi 1",
        plan_id: "gennaio",
        topic_id: "limiti",
        passage_id: topicPassage,
        prompt_template: "cards.subject",
      },
    ]);
    await expect(page.getByRole("region", { name: "Analisi 1" }).getByRole("list", { name: "Appello del 14 gennaio" })).toContainText(
      "Limiti2 flashcard",
    );

    // A subject with no material says what is missing instead of writing anything.
    await open.click();
    await dialog.getByRole("radio", { name: "Falla fare a Pyxis" }).click();
    await pySubject.selectOption({ label: "Geometria e algebra lineare per l’ingegneria dell’informazione" });
    await expect(dialog.getByText(/In Libreria non c’è ancora materiale di Geometria/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Crea le flashcard" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // ---- Another page opens the dialog on a subject and a side, as the Library's subject menu does.
    await page.evaluate(() => {
      location.hash = "/exams/library";
    });
    await expect(page).toHaveURL(/#\/exams\/library$/);
    await page.evaluate(() => {
      location.hash = "/flashcards?new=pyxis&subject=phys";
    });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/#\/flashcards$/);
    await expect(dialog.getByRole("radio", { name: "Falla fare a Pyxis" })).toHaveAttribute("aria-checked", "true");
    await expect(pySubject).toHaveValue("phys");
    await expect(pySubject).toBeFocused();
    // Fisica 2 has no topics, so Argomento is folded away.
    await expect(dialog.getByRole("combobox", { name: "Argomento" })).toBeHidden();
    const count = dialog.getByRole("group", { name: "Quante flashcard" }).getByRole("textbox");
    await count.fill("30");
    await count.press("Enter");
    await expect(count).toHaveValue("30");
    await expect(dialog.getByRole("button", { name: "Una in più" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Crea le flashcard" }).click();
    await expect(list).toHaveCount(30);
    await expect(dialog.getByRole("button", { name: "Salva 30 flashcard" })).toBeVisible();
    // The buttons stay in reach while the list scrolls inside the dialog.
    await expect(dialog.getByRole("button", { name: "Salva 30 flashcard" })).toBeInViewport();
    await shot(page, "7-pyxis-thirty");
    // Closing with proposals not saved asks first; then nothing is saved.
    await dialog.getByRole("button", { name: "Annulla" }).click();
    await expect(dialog.getByText(/Non hai salvato le flashcard proposte/)).toBeVisible();
    await dialog.getByRole("button", { name: "Chiudi senza salvare" }).click();
    await expect(dialog).toHaveCount(0);
    expect(cards(userData).filter((row) => row.subject === "Fisica 2")).toHaveLength(1);

    // The hand side opens the same way.
    await page.evaluate(() => {
      location.hash = "/flashcards?new=hand&subject=phys";
    });
    await expect(dialog.getByRole("radio", { name: "Scrivila tu" })).toHaveAttribute("aria-checked", "true");
    await expect(subject).toHaveValue("phys");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** A card whose fact is in the nth passage Pyxis was given. */
const cardAt = (n: number, front: string, passage = 0) => ({
  kind: "qa",
  front,
  back: `La risposta numero ${n}.`,
  passageId: `{{passage:${passage}}}`,
});

const LONG_SOURCE = "Dispense complete di analisi matematica per ingegneria informatica, secondo volume";

/** Analisi 1 with an exam, a topic "Limiti" read from two sources (one with pages, one with a very long name) and one old card. */
function seedAnalisi(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  try {
    seedSubjects(db, [{ id: "ana", name: "Analisi 1" }]);
    seedSource(db, {
      id: "bramanti",
      subjectId: "ana",
      title: "Bramanti",
      document: { id: "d-bramanti" },
      passages: [{ id: "pa0", text: PASSAGES[0]!, locator: { page: 112 }, section: "Capitolo 3" }],
    });
    seedSource(db, {
      id: "dispense",
      subjectId: "ana",
      title: LONG_SOURCE,
      document: { id: "d-dispense" },
      passages: [{ id: "pa1", text: PASSAGES[1]!, section: "Capitolo 4" }],
    });
    seedPlan(db, {
      id: "gennaio",
      subjectId: "ana",
      title: "Appello del 14 gennaio",
      language: "it",
      target: 0.75,
      sourceIds: ["bramanti", "dispense"],
      topics: [{ id: "limiti", title: "Limiti" }],
    });
    db.exec(`INSERT INTO topic_passages(topic_id,passage_id) VALUES('limiti','pa0'),('limiti','pa1');
      INSERT INTO cards(id,subject_id,front,back,created_at) VALUES('old','ana','Che cos''è un limite?','Già scritta.',1);`);
  } finally {
    db.close();
  }
}

test("proposals name their source, a dropped one can no longer be saved, and Pyxis's count stays what it wrote", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-new-flashcard-review-"));
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
      subjectCards: [
        // Every card repeats the one the subject has: a failure with a way out, not an empty list to check.
        { cards: [cardAt(1, "che cos'è un LIMITE?")] },
        { cards: [cardAt(1, "Primo?", 0), cardAt(2, "Secondo?", 1), cardAt(3, "Terzo?", 0)] },
        { cards: [cardAt(4, "Quarto?", 0), cardAt(5, "Quinto?", 1), cardAt(6, "Sesto?", 0)] },
      ],
    }),
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    seedAnalisi(userData);
    await toFlashcards(page);
    const dialog = page.getByRole("dialog", { name: "Nuova flashcard" });
    const open = page.getByRole("button", { name: "Nuova flashcard", exact: true });
    const list = dialog.getByRole("list", { name: "Flashcard proposte" }).getByRole("listitem");
    const ask = async () => {
      await open.click();
      await dialog.getByRole("radio", { name: "Falla fare a Pyxis" }).click();
      await dialog.getByRole("combobox", { name: "Argomento" }).selectOption({ label: "Limiti" });
      await dialog.getByRole("button", { name: "Crea le flashcard" }).click();
    };

    // Finding 3: every proposed front repeats one the subject has, so there is nothing to check.
    await ask();
    const failed = dialog.getByRole("alert");
    await expect(failed).toContainText("Tutte le flashcard che Pyxis ha scritto le avevi già");
    await expect(dialog.getByRole("list", { name: "Flashcard proposte" })).toHaveCount(0);
    await failed.getByRole("button", { name: "Riprova" }).click();

    await expect(list).toHaveCount(3);
    const lead = dialog.getByRole("status").filter({ hasText: "Ne ho scritte 3 su Limiti" });
    await expect(lead).toBeVisible();
    // Step 4: each proposal names its source, with the page when the source has pages, cut when long, whole to a reader.
    await expect(list.nth(0).getByRole("button", { name: "Bramanti, p. 112" })).toBeVisible();
    const longChip = list.nth(1).getByRole("button", { name: LONG_SOURCE });
    await expect(longChip).toBeVisible();
    const cut = longChip.locator(".px-pc-source");
    await expect(cut).toHaveAttribute("title", LONG_SOURCE);
    expect(await cut.evaluate((node) => node.scrollWidth > node.clientWidth), "the long name is cut with an ellipsis").toBe(true);
    expect(await cut.evaluate((node) => getComputedStyle(node).textOverflow)).toBe("ellipsis");

    // Finding 5: with the exit slowed down, the dropped card is out of what Salva will save and of its count at once.
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
    await list.nth(1).getByRole("button", { name: "Scarta la flashcard 2" }).click();
    await page.evaluate(() => (window as unknown as { restoreAnimate: () => void }).restoreAnimate());
    await expect(dialog.getByRole("button", { name: "Salva 2 flashcard" })).toBeVisible();
    await expect(dialog.locator(".px-pc-card[data-leaving]")).toHaveCount(1);
    await expect(list).toHaveCount(2);
    // Finding 11: Pyxis still says how many it wrote, not how many are left.
    await expect(lead).toBeVisible();
    await expect(dialog.getByRole("status").filter({ hasText: "Ne ho scritte 2" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Salva 2 flashcard" }).click();
    await expect(dialog).toHaveCount(0);
    expect(cards(userData).slice(1).map((row) => row.front)).toEqual(["Primo?", "Terzo?"]);

    // Finding 4's twin here: with every proposal dropped, the focus lands on a button that is still there.
    await ask();
    await expect(list).toHaveCount(3);
    for (const n of [3, 2, 1]) {
      await dialog.getByRole("button", { name: `Scarta la flashcard ${n}` }).click();
      await expect(list).toHaveCount(n - 1);
    }
    await expect(dialog.getByRole("button", { name: "Cambia la richiesta" })).toBeFocused();
    await expect(dialog.getByRole("status").filter({ hasText: "Ne ho scritte 3 su Limiti" })).toContainText(
      "Hai scartato tutte le flashcard",
    );
    await expect(dialog.locator(".px-pc-card")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(cards(userData)).toHaveLength(3);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a card is saved once, the dialog stays while it saves, and each save is announced", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-new-flashcard-saving-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    seedAnalisi(userData);
    await toFlashcards(page);
    const dialog = page.getByRole("dialog", { name: "Nuova flashcard" });
    const open = page.getByRole("button", { name: "Nuova flashcard", exact: true });
    const save = dialog.getByRole("button", { name: "Salva", exact: true });
    const front = dialog.getByRole("textbox", { name: "Fronte" });
    const back = dialog.getByRole("textbox", { name: "Retro" });
    const written = (text: string) => cards(userData).filter((row) => row.front === text).length;
    // What a screen reader would be told: every time the page's status line gets words.
    await page.evaluate(() => {
      const line = document.querySelector<HTMLElement>(".px-fc > p[role=status]")!;
      const heard: string[] = [];
      (window as unknown as { heard: string[] }).heard = heard;
      new MutationObserver(() => line.textContent && heard.push(line.textContent)).observe(line, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });

    // Finding 7: while a save is pending the dialog does not close, however the student asks.
    const lock = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    lock.exec("BEGIN IMMEDIATE");
    try {
      await open.click();
      await front.fill("In attesa?");
      await back.fill("Sì.");
      await save.click();
      await expect(save).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog.getByText("Butti via quello che hai scritto?")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Annulla" })).toBeDisabled();
      await dialog.click({ position: { x: 1, y: 1 } });
      await expect(dialog).toBeVisible();
      expect(written("In attesa?")).toBe(0);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
    await expect(dialog).toHaveCount(0);
    expect(written("In attesa?")).toBe(1);

    // Finding 10: Salva stays off while the dialog closes, so clicks that keep coming save the card once.
    await open.click();
    await front.fill("Una sola volta?");
    await back.fill("Una.");
    await page.evaluate(async () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(
        (node) => node.textContent?.trim() === "Salva",
      )!;
      for (let i = 0; i < 40; i += 1) {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    });
    await expect(dialog).toHaveCount(0);
    expect(written("Una sola volta?")).toBe(1);

    // Reopened, the dialog is a fresh one: its buttons work.
    await open.click();
    await expect(save).toBeEnabled();
    await front.fill("Terza?");
    await back.fill("Sì.");
    await save.click();
    await expect(dialog).toHaveCount(0);
    expect(written("Terza?")).toBe(1);

    // Finding 6: three saves of one card each to the same subject say the same words, and each is said.
    const heard = await page.evaluate(() => (window as unknown as { heard: string[] }).heard);
    expect(heard).toEqual(Array(3).fill("1 flashcard salvata in Analisi 1."));
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("the Flashcard page's cleanup of `?new=` never lands on the page opened right after it", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-new-flashcard-leave-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    seedAnalisi(userData);
    // React draws a page first and runs its effects a moment later, and the student can already be on the next page by
    // then. This puts the move to the Library into that gap: the Flashcard page has been drawn (its `?new=` is in the
    // address) and the router leaves it before its effects run.
    await page.evaluate(() => {
      let armed = false;
      const push = history.pushState.bind(history);
      history.pushState = (...args: Parameters<History["pushState"]>) => {
        armed ||= String(args[2]).includes("new=");
        push(...args);
      };
      new MutationObserver(() => {
        if (!armed || !document.querySelector(".px-fc")) return;
        armed = false;
        history.pushState(null, "", "#/exams/library?stay=1");
        dispatchEvent(new PopStateEvent("popstate"));
      }).observe(document.body, { childList: true, subtree: true });
      history.pushState(null, "", "#/flashcards?new=pyxis&subject=ana");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    // Give a late cleanup time to land: it would take the student back here, or drop the Library's own parameter.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    await expect(page).toHaveURL(/#\/exams\/library\?stay=1$/);
    await expect(page.getByRole("dialog", { name: "Nuova flashcard" })).toHaveCount(0);
    // The request was never seen by a page the student stayed on: the same address, asked for properly, opens it once.
    await page.evaluate(() => {
      location.hash = "/flashcards?new=pyxis&subject=ana";
    });
    const dialog = page.getByRole("dialog", { name: "Nuova flashcard" });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/#\/flashcards$/);
    await expect(dialog.getByRole("combobox", { name: "Materia" })).toHaveValue("ana");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
