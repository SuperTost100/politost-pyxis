import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan } from "./seed";
import { animationsSettled } from "./settled";

/** Picks an item of the application menu the way a click on it would: its handler runs in the main process. */
async function pick(app: ElectronApplication, id: string) {
  const found = await app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    item?.click();
    return Boolean(item);
  }, id);
  expect(found, `menu item ${id}`).toBe(true);
}

/** The keyframes and length of the animations running on the open dialog, read as it opens. */
function dialogMotion(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("dialog.px-dialog")].flatMap((node) =>
      node.getAnimations().map((animation) => {
        const effect = animation.effect as KeyframeEffect;
        return {
          duration: effect.getTiming().duration,
          moves: effect.getKeyframes().some((frame) => frame.transform !== undefined && frame.transform !== "none"),
        };
      }),
    ),
  );
}

/** The leave question: its title names it, the sentence describes it, and "Resta qui" has the focus. */
async function expectLeaveQuestion(page: Page, body: string | RegExp): Promise<Locator> {
  const question = page.getByRole("dialog", { name: "Uscire senza salvare?" });
  await expect(question).toBeVisible();
  await expect(question).toHaveAccessibleDescription(body);
  await expect(question.getByRole("button", { name: "Resta qui" })).toBeFocused();
  await expect(question.getByRole("button", { name: "Esci senza salvare" })).toBeVisible();
  await expect(question.getByRole("button", { name: "Chiudi" })).toHaveCount(0);
  return question;
}

test("DIALOG-01 the one dialog: focus, Tab, Escape, Annulla, the red button, a menu inside, one question at a time", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-dialogs-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.setViewportSize({ width: 960, height: 640 });
    await page.evaluate(() => {
      location.hash = "/dev/gallery";
    });
    const answer = page.getByRole("status").filter({ hasText: "Ultima risposta" });
    const opener = page.getByRole("button", { name: "Conferma che elimina" });
    await opener.scrollIntoViewIfNeeded();

    // A confirmation that deletes grows out of its button, with Annulla focused and never the red button.
    await opener.click();
    const confirm = page.getByRole("dialog", { name: "Eliminare Fisica 1?" });
    await expect(confirm).toBeVisible();
    expect(await dialogMotion(page)).toContainEqual({ duration: 320, moves: true });
    await expect(confirm).toHaveAccessibleDescription(/^Con l'esame cancelli quello che Pyxis ha preparato/);
    expect(await confirm.evaluate((node) => node.matches(":modal"))).toBe(true);
    const archive = confirm.getByRole("button", { name: "Archivia invece" });
    const cancel = confirm.getByRole("button", { name: "Annulla" });
    const remove = confirm.getByRole("button", { name: "Elimina l'esame" });
    await expect(cancel).toBeFocused();
    await expect(confirm.getByRole("button", { name: "Chiudi" })).toHaveCount(0);
    await animationsSettled(page);
    const [a, c, r] = [(await archive.boundingBox())!, (await cancel.boundingBox())!, (await remove.boundingBox())!];
    expect(Math.abs(a.y - r.y), "the buttons share a line").toBeLessThan(1);
    expect(a.x + a.width, "the extra action is on the left").toBeLessThan(c.x);
    expect(c.x + c.width, "Annulla comes before the red button").toBeLessThan(r.x);
    // The red button is the solid danger one, in the theme's danger colour; Annulla is the quiet one.
    const colours = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--danger)";
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return danger;
    });
    await expect(remove).toHaveCSS("background-color", colours);
    await expect(cancel).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expectNoAxeViolations(page);

    // Tab goes round inside the dialog and never reaches the page behind.
    await page.keyboard.press("Tab");
    await expect(remove).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(archive).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(remove).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();

    // A second question asked while this one is open opens nothing and answers "annulla" at once.
    await opener.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(answer).toHaveText("Ultima risposta: annulla");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(cancel).toBeFocused();

    // Escape closes it like Annulla and gives the focus back to the button it came from.
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.click();
    await confirm.getByRole("button", { name: "Annulla" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(answer).toHaveText("Ultima risposta: annulla");
    await expect(opener).toBeFocused();

    await opener.click();
    await confirm.getByRole("button", { name: "Elimina l'esame" }).click();
    await expect(answer).toHaveText("Ultima risposta: conferma");
    await opener.click();
    await confirm.getByRole("button", { name: "Archivia invece" }).click();
    await expect(answer).toHaveText("Ultima risposta: l'azione in più");

    // A click outside closes a dialog with nothing typed in it.
    await opener.click();
    await expect(cancel).toBeFocused();
    await page.mouse.click(4, 4);
    await expect(confirm).toHaveCount(0);
    await expect(answer).toHaveText("Ultima risposta: annulla");

    // A form: its first field takes the focus; a click outside keeps typed text; a menu inside sits above the dialog,
    // works, and closes on Escape before the dialog does.
    const formOpener = page.getByRole("button", { name: "Modulo", exact: true });
    await formOpener.click();
    const form = page.getByRole("dialog", { name: "Nuova mappa" });
    const topic = form.getByRole("textbox", { name: "Argomento" });
    await expect(topic).toBeFocused();
    await topic.fill("Funzioni di più variabili");
    await page.mouse.click(4, 4);
    await expect(form).toBeVisible();
    await expect(topic).toHaveValue("Funzioni di più variabili");
    const subject = form.getByRole("button", { name: "Materia: Analisi Matematica 2" });
    await subject.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((node) => Boolean(node.closest("dialog.px-dialog")))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(form).toBeVisible();
    await expect(subject).toBeFocused();
    await subject.click();
    await page.getByRole("menuitem", { name: "Fisica 1" }).click();
    await expect(form.getByRole("button", { name: "Materia: Fisica 1" })).toBeVisible();
    await expect(form).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
    await expect(formOpener).toBeFocused();

    // A dialog that only informs has the X and no Annulla. Taller than the window, its body scrolls and the title stays.
    const infoOpener = page.getByRole("button", { name: "Solo informa" });
    await infoOpener.click();
    const info = page.getByRole("dialog", { name: "Scorciatoie da tastiera" });
    const close = info.getByRole("button", { name: "Chiudi" });
    await expect(close).toBeFocused();
    await expect(info.getByRole("button", { name: "Annulla" })).toHaveCount(0);
    await animationsSettled(page);
    const box = (await info.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(640);
    const body = info.locator(".px-dialog-body");
    expect(await body.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    await body.evaluate((node) => node.scrollTo(0, node.scrollHeight));
    await expect(info.getByRole("heading", { name: "Scorciatoie da tastiera" })).toBeInViewport();
    await close.click();
    await expect(info).toHaveCount(0);
    await expect(infoOpener).toBeFocused();

    // A confirmation whose work ends at once starts it once: a second quick click, and a click on the confirming button
    // right after Annulla, do nothing while the dialog shrinks away.
    const runs = page.getByRole("status").filter({ hasText: /^Lavori avviati: / });
    await expect(runs).toHaveText("Lavori avviati: 0");
    const runOpener = page.getByRole("button", { name: "Conferma con un lavoro" });
    await runOpener.click();
    const twice = page.getByRole("dialog", { name: "Eliminare Fisica 1?" });
    await twice.getByRole("button", { name: "Elimina l'esame" }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(answer).toHaveText("Ultima risposta: conferma");
    await expect(twice).toHaveCount(0);
    await expect(runs).toHaveText("Lavori avviati: 1");
    await runOpener.click();
    await expect(twice.getByRole("button", { name: "Annulla" })).toBeFocused();
    await twice.evaluate((dialog) => {
      const buttons = [...dialog.querySelectorAll("button")];
      buttons.find((button) => button.textContent === "Annulla")!.click();
      buttons.find((button) => button.textContent === "Elimina l'esame")!.click();
    });
    await expect(answer).toHaveText("Ultima risposta: annulla");
    await expect(twice).toHaveCount(0);
    await expect(runs).toHaveText("Lavori avviati: 1");

    // Under reduced motion it only fades, in 120 ms.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await opener.click();
    await expect(confirm).toBeVisible();
    expect(await dialogMotion(page)).toContainEqual({ duration: 120, moves: false });
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("DIALOG-02 exam settings, the whiteboard and Nuova flashcard ask once before work is lost, by every way out", async () => {
  test.setTimeout(150_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-leave-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seedPlan(db, { id: "plan-a", title: "Fisica 1", language: "it", topics: [{ id: "topic-a", title: "Cinematica" }] });
    db.close();
    // As exam-sessions.spec.ts does: the page reads the seeded exam afresh.
    await page.reload();
    const sections = page.getByRole("navigation", { name: "Sezioni" });

    // Exam settings with a new name, reached by the app's own links: the router can hold back a step back only to a
    // page it opened itself, which is how the student always arrives.
    await page.locator("a.px-exams-row", { hasText: "Fisica 1" }).click();
    await expect(page.getByRole("heading", { name: "Fisica 1", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Impostazioni dell'esame" }).click();
    await expect(page).toHaveURL(/#\/plans\/plan-a\/settings$/);
    // A page ahead in history, so Avanti has somewhere to go: Fonti and back, with nothing changed yet.
    await page.getByRole("link", { name: "Vai a Fonti" }).click();
    await expect(page).toHaveURL(/#\/plans\/plan-a\/sources$/);
    // Indietro runs the page's back control, there once the page has drawn it: the settings stay on screen, with their
    // own control, until Fonti has loaded.
    await expect(page.getByRole("heading", { level: 1, name: "Materiale" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Torna a / })).toBeVisible();
    await pick(app, "back");
    await expect(page).toHaveURL(/#\/plans\/plan-a\/settings$/);
    const name = page.getByLabel("Nome dell'esame");
    await name.fill("Fisica generale");
    const body = "Hai cambiato il nome. Se esci adesso, le modifiche vanno perse.";

    // The menu's Indietro and Avanti with the focus in the name being typed: the page asks rather than the menu doing
    // nothing, and staying keeps the text and the focus.
    for (const command of ["back", "forward"]) {
      await expect(name).toBeFocused();
      await pick(app, command);
      const asked = await expectLeaveQuestion(page, body);
      await asked.getByRole("button", { name: "Resta qui" }).click();
      await expect(asked).toHaveCount(0);
      await expect(page).toHaveURL(/#\/plans\/plan-a\/settings$/);
      await expect(name).toHaveValue("Fisica generale");
    }

    // The sidebar: staying keeps the text and gives the focus back to the field the student was typing in.
    await sections.getByRole("link", { name: /^Esami$/ }).click();
    let question = await expectLeaveQuestion(page, body);
    await question.getByRole("button", { name: "Resta qui" }).click();
    await expect(question).toHaveCount(0);
    await expect(page).toHaveURL(/#\/plans\/plan-a\/settings$/);
    await expect(name).toHaveValue("Fisica generale");
    await expect(name).toBeFocused();

    // The page's back control, answered with Escape.
    await page.getByRole("button", { name: "Torna a Fisica 1" }).click();
    question = await expectLeaveQuestion(page, body);
    await page.keyboard.press("Escape");
    await expect(question).toHaveCount(0);
    await expect(page).toHaveURL(/#\/plans\/plan-a\/settings$/);
    await expect(name).toBeFocused();

    // The menu's Indietro, from a control that holds no text: the focus stays on it.
    const goal = page.getByRole("slider", { name: /^Obiettivo/ });
    await goal.focus();
    await pick(app, "back");
    question = await expectLeaveQuestion(page, body);
    await expectNoAxeViolations(page);
    await question.getByRole("button", { name: "Resta qui" }).click();
    await expect(question).toHaveCount(0);
    await expect(page).toHaveURL(/#\/plans\/plan-a\/settings$/);
    await expect(goal).toBeFocused();

    // Leaving without saving goes where the student was going, once, and the name stays as it was saved.
    await sections.getByRole("link", { name: /^Esami$/ }).click();
    question = await expectLeaveQuestion(page, body);
    await question.getByRole("button", { name: "Esci senza salvare" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await page.evaluate(() => window.pyxis.invoke("plans.read", { planId: "plan-a" })))!.title).toBe("Fisica 1");

    // Deleting the exam with an unsaved name leaves for Esami without asking.
    await page.locator("a.px-exams-row", { hasText: "Fisica 1" }).click();
    await page.getByRole("button", { name: "Impostazioni dell'esame" }).click();
    await name.fill("Fisica generale");
    await page.getByRole("button", { name: "Elimina", exact: true }).click();
    await page.getByRole("dialog", { name: "Eliminare Fisica 1?" }).getByRole("button", { name: "Elimina l'esame" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(page.getByRole("dialog", { name: "Uscire senza salvare?" })).toHaveCount(0);

    // The whiteboard: a stroke drawn and not saved.
    await sections.getByRole("link", { name: /^Nuova chat/ }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.locator(".px-composer").getByRole("button", { name: "Lavagna", exact: true }).click();
    await expect(page).toHaveURL(/#\/tools\/whiteboard$/);
    const canvas = page.locator(".px-whiteboard canvas");
    await expect(canvas).toBeVisible();
    const rect = (await canvas.boundingBox())!;
    await page.mouse.move(rect.x + 100, rect.y + 200);
    await page.mouse.down();
    await page.mouse.move(rect.x + 250, rect.y + 300, { steps: 8 });
    await page.mouse.up();
    const strokes = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("pyxis-board") ?? "[]").length);
    expect(await strokes()).toBe(1);
    const drawingBody = "Il disegno dopo l'ultimo salvataggio andrà perso.";
    const closeBoard = page.getByRole("button", { name: "Chiudi", exact: true });
    await closeBoard.click();
    question = await expectLeaveQuestion(page, drawingBody);
    await question.getByRole("button", { name: "Resta qui" }).click();
    await expect(question).toHaveCount(0);
    await expect(closeBoard).toBeFocused();
    expect(await strokes()).toBe(1);
    // The board has no back control yet, only its X, so the menu's Indietro is greyed here and its X is the way out.
    await expect
      .poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("back")?.enabled))
      .toBe(false);
    await closeBoard.click();
    question = await expectLeaveQuestion(page, drawingBody);
    await page.keyboard.press("Escape");
    await expect(question).toHaveCount(0);
    await expect(page).toHaveURL(/#\/tools\/whiteboard$/);
    await closeBoard.click();
    question = await expectLeaveQuestion(page, drawingBody);
    await question.getByRole("button", { name: "Esci senza salvare" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    expect(await strokes()).toBe(0);

    // Nuova flashcard is a dialog, so closing it is not a move: the same question opens over it.
    await sections.getByRole("link", { name: /^Flashcard\b/ }).click();
    await expect(page).toHaveURL(/#\/flashcards$/);
    const newCard = page.getByRole("button", { name: "Nuova flashcard" }).first();
    await newCard.click();
    const dialog = page.getByRole("dialog", { name: "Nuova flashcard" });
    const front = dialog.getByRole("textbox", { name: "Fronte" });
    await front.fill("Che cos'è la velocità?");
    const typed = "La flashcard che hai scritto andrà persa.";
    for (const way of ["Escape", "Annulla", "outside"] as const) {
      await front.focus();
      if (way === "Escape") await page.keyboard.press("Escape");
      else if (way === "Annulla") await dialog.getByRole("button", { name: "Annulla" }).click();
      else await page.mouse.click(4, 4);
      question = await expectLeaveQuestion(page, typed);
      await question.getByRole("button", { name: "Resta qui" }).click();
      await expect(question).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(front).toHaveValue("Che cos'è la velocità?");
    }
    await page.keyboard.press("Escape");
    question = await expectLeaveQuestion(page, typed);
    await question.getByRole("button", { name: "Esci senza salvare" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(newCard).toBeFocused();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
