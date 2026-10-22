import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPickedSource } from "./picked-source";
import { launchPyxis } from "./app-under-test";
import { makeBook } from "./book";
import { saveShot } from "./shots";

function smartbook() {
  return makeBook({
    id: "states",
    chapters: [1, 2].map((n) => ({
      title: `Tema ${n}`,
      text: `## p1 | Tema ${n}\nIl moto rettilineo uniforme del tema ${n}.\n`,
    })),
  });
}

const diagnostic = {
  questions: Array.from({ length: 10 }, (_, i) => ({
    stem: `Diagnosi ${i}`,
    options: ["a", "b", "c", "d"],
    correct: 0,
    topicIndex: i % 2,
    passageIds: [`{{passage:${i % 2}}}`],
    explanation: "La relazione fisica.",
  })),
};

async function launch(delay = 0) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ui-states-"));
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
      markdown: { markdown: "## Ripasso\nUsa le formule [P1]." },
      questions: diagnostic,
    }),
    PYXIS_E2E_PLAN_DELAY: String(delay),
  };
  const app = await launchPyxis({ userData, env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Salta" }).click();
  await expect(page).toHaveURL(/#\/exams$/);
  return { app, page, userData };
}

const goto = (page: Page, hash: string) =>
  page.evaluate((hash) => {
    window.location.hash = hash;
  }, hash);

async function addSource(page: Page, app: ElectronApplication, userData: string) {
  const file = join(userData, "fisica.ptsb");
  writeFileSync(file, smartbook());
  const { sourceId } = (await importPickedSource(page, app, file)) as { sourceId: string };
  await expect
    .poll(async () =>
      (
        (await page.evaluate(() => window.pyxis.invoke("sources.list", {}))) as Array<{
          id: string;
          status: string;
        }>
      ).find((row) => row.id === sourceId)?.status,
    )
    .toBe("ready");
  return sourceId;
}

/** Picks a menu item the way a click on it would: runs its handler in the main process. */
async function pick(app: ElectronApplication, id: string) {
  const found = await app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    item?.click();
    return Boolean(item);
  }, id);
  expect(found, `menu item ${id}`).toBe(true);
}

test("UI-01 the menu works while a plan builds, a wizard error goes away, and the close button of study pages leads to the plan", async () => {
  test.setTimeout(240000);
  const { app, page, userData } = await launch(3000);
  try {
    const sourceId = await addSource(page, app, userData);

    // A failed "Add subject" says so on its step and not on the next one.
    await goto(page, "/plans/new");
    await page.getByLabel("Titolo", { exact: true }).fill("Fisica");
    await page.getByLabel("Materia", { exact: true }).fill("x".repeat(130));
    await page.getByRole("button", { name: "Aggiungi questa materia", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Non riesco a preparare il piano.");
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Quando hai l'esame?" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);

    // The answers are saved once the plan exists: the build screen must not hold the menu.
    const { planId } = (await page.evaluate(
      (sourceId) => window.pyxis.invoke("plans.create", { title: "Fisica", sourceIds: [sourceId] }),
      sourceId,
    )) as { planId: string };
    await goto(page, `/plans/new?build=${planId}`);
    await expect(page.getByRole("heading", { name: "Sto preparando Fisica" })).toBeVisible();
    await pick(app, "settings");
    await expect(page).toHaveURL(/#\/settings/);

    await expect
      .poll(
        async () =>
          (
            (await page.evaluate((planId) => window.pyxis.invoke("plans.build", { planId }), planId)) as {
              state: string;
            }
          ).state,
        { timeout: 120000 },
      )
      .toBe("succeeded");
    const plan = (await page.evaluate(
      (planId) => window.pyxis.invoke("plans.read", { planId }),
      planId,
    )) as { topics: Array<{ id: string }> };
    const topic = plan.topics[0]!.id;

    // The X of Cards, Practice and Review goes where Back goes: the plan.
    for (const route of [`cards/${topic}`, `practice/${topic}`, "review"]) {
      await goto(page, `/plans/${planId}/${route}`);
      await page.getByRole("button", { name: "Chiudi", exact: true }).click();
      await expect(page, route).toHaveURL(new RegExp(`#/plans/${planId}$`));
    }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("UI-02 a passage search says when nothing matches, ignores an empty query and drops hits of a removed source", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  try {
    await addSource(page, app, userData);
    // A second source keeps the toolbar on screen after the first is removed.
    const notes = join(userData, "Appunti.txt");
    writeFileSync(notes, "Il primo principio della termodinamica lega calore, lavoro ed energia interna.\n");
    const { sourceId: notesId } = (await importPickedSource(page, app, notes)) as { sourceId: string };
    await expect
      .poll(async () =>
        (
          (await page.evaluate(() => window.pyxis.invoke("sources.list", {}))) as Array<{
            id: string;
            status: string;
          }>
        ).find((row) => row.id === notesId)?.status,
      )
      .toBe("ready");
    await goto(page, "/exams/library");
    // Passages are searched in the Contenuto scope of the title field; Enter asks at once.
    await page.getByRole("combobox", { name: "Cerca in" }).click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option[title="Contenuto"]')
      .click();
    const query = page.getByRole("textbox", { name: "Cerca nei brani" });
    const none = (text: string) => page.getByText(`Nessun brano delle tue fonti corrisponde a “${text}”.`);

    // An empty query asks nothing: no result section, no message.
    await query.fill("   ");
    await query.press("Enter");
    await expect(page.getByRole("region", { name: "Cerca nelle fonti" })).toHaveCount(0);
    await expect(page.getByText(/Nessun brano delle tue fonti/)).toHaveCount(0);

    await query.fill("pappagallo");
    await query.press("Enter");
    await expect(none("pappagallo")).toBeVisible();
    await saveShot(page, "ui-states-search-none-it.png", { animations: "disabled" });

    await query.fill("moto rettilineo");
    await query.press("Enter");
    const hits = page.locator(".px-library-hit");
    await expect(hits.first()).toBeVisible();
    await expect(page.getByText(/Nessun brano delle tue fonti/)).toHaveCount(0);

    // The source goes away: its hits go with it, and the search says nothing matches.
    // The hits replace the list in the Contenuto scope, so the source is removed from the Titoli scope.
    const pickScope = async (name: string) => {
      await page.getByRole("combobox", { name: "Cerca in" }).click();
      await page.locator(`.ant-select-dropdown:visible .ant-select-item-option[title="${name}"]`).click();
    };
    await pickScope("Titoli");
    // The typed words filter titles in this scope, so the field is emptied to list the source again.
    await page.getByRole("textbox", { name: "Cerca una fonte per titolo" }).fill("");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Azioni per Fisica" }).click();
    await page.getByRole("menuitem", { name: "Rimuovi", exact: true }).click();
    await expect(page.getByRole("button", { name: "Azioni per Fisica" })).toHaveCount(0);
    await pickScope("Contenuto");
    await query.fill("moto rettilineo");
    await query.press("Enter");
    await expect(hits).toHaveCount(0);
    await expect(none("moto rettilineo")).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("UI-03 the cards page announces the next card, names parked cards, and shows the wizard's progress", async () => {
  test.setTimeout(240000);
  const { app, page, userData } = await launch();
  try {
    const sourceId = await addSource(page, app, userData);
    const invoke = <T>(channel: string, input: object) =>
      page.evaluate(([c, i]) => window.pyxis.invoke(c as never, i as never), [channel, input] as const) as Promise<T>;
    const { planId } = await invoke<{ planId: string }>("plans.create", { title: "Fisica", sourceIds: [sourceId] });
    await expect
      .poll(async () => (await invoke<{ state: string }>("plans.build", { planId })).state, { timeout: 120000 })
      .toBe("succeeded");
    const { topics } = await invoke<{ topics: Array<{ id: string }> }>("plans.read", { planId });
    const topicId = topics[0]!.id;
    const save = (front: string, back: string) => invoke<{ id: string }>("study.save", { planId, topicId, front, back });
    await save("Prima carta", "Retro uno");
    await save("Seconda carta", "Retro due");
    const parkedA = await save("La {{c1::energia}} cinetica", "Retro tre");
    const parkedB = await save("Il {{c1::lavoro}} meccanico", "Retro quattro");
    for (const card of [parkedA, parkedB]) await invoke("study.suspend", { cardId: card.id, suspended: true });

    await goto(page, `/plans/${planId}/cards/${topicId}`);
    // Parked cloze cards read as sentences, and each Resume names its card.
    await expect(page.getByText("{{c1::")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Riprendi la flashcard: La energia cinetica" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Riprendi la flashcard: Il lavoro meccanico" })).toBeVisible();
    await saveShot(page, "ui-states-cards-parked-it.png", { animations: "disabled", fullPage: true });

    // Rating a card says which one comes next, since the buttons the focus was on are gone. Every announcement is
    // recorded: the card just rated is never read out as the next one, not even until the queue updates.
    const rated = (await page.getByText("Prima carta").isVisible()) ? "Prima carta" : "Seconda carta";
    const next = rated === "Prima carta" ? "Seconda carta" : "Prima carta";
    await page.evaluate(() => {
      const said: string[] = [];
      (window as unknown as { said: string[] }).said = said;
      new MutationObserver(() => {
        for (const node of document.querySelectorAll('[role="status"]')) {
          const text = node.textContent ?? "";
          if (text.startsWith("Flashcard successiva") && said.at(-1) !== text) said.push(text);
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.getByRole("button", { name: /^Gira/ }).click();
    await page.getByRole("button", { name: "Bene", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Flashcard successiva:" })).toHaveText(
      `Flashcard successiva: ${next}`,
    );
    expect(await page.evaluate(() => (window as unknown as { said: string[] }).said)).toEqual([
      `Flashcard successiva: ${next}`,
    ]);

    // The wizard's progress line is a progress bar.
    await goto(page, "/plans/new");
    const progress = page.getByRole("progressbar");
    await expect(progress).toHaveAttribute("aria-valuenow", "17");
    await expect(progress).toHaveAttribute("aria-valuemax", "100");
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
