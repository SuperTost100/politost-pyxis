import { expect, type Page } from "@playwright/test";

/**
 * Setup ends on Chiedi. Most tests start from Esami, as the app did before 0.5, so this waits for Chiedi and then
 * opens Esami from the sidebar.
 */
export async function fromChiediToExams(page: Page): Promise<void> {
  await expect(page).toHaveURL(/#\/ask$/);
  await page
    .getByRole("navigation", { name: /^(Sezioni|Sections)$/ })
    .getByRole("link", { name: /^(Esami|Exams)$/ })
    .click();
  await expect(page).toHaveURL(/#\/exams$/);
}

/** Opens the Library from the sidebar, which was a tab of Esami before 0.5. */
export async function toLibrary(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: /^(Sezioni|Sections)$/ })
    .getByRole("link", { name: /^(Libreria|Library)$/ })
    .click();
  await expect(page).toHaveURL(/#\/exams\/library$/);
}

/**
 * Opens "Aggiungi fonti" on its File tab, the way a student does: from "Aggiungi file" in the Library's head or, while
 * the Library holds no file and the head has no such button, from the empty page's "Collega una cartella" and its File
 * tab. Waits for the dialog.
 */
export async function openAddFiles(page: Page): Promise<void> {
  const head = page.getByRole("button", { name: /^(Aggiungi file|Add files)$/ });
  const empty = page.locator(".px-empty").getByRole("button", { name: /^(Collega una cartella|Link a folder)$/ });
  await expect(head.or(empty)).toBeVisible();
  const fromEmpty = await empty.isVisible();
  await (fromEmpty ? empty : head).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Segmented renders radios; the hidden native input is the accessible control.
  if (fromEmpty) await dialog.getByRole("radio", { name: "File", exact: true }).locator("..").click();
}

/** Opens every flashcard the way a student does: the Flashcard section in the sidebar, then "Sfoglia tutte" in its head. */
export async function toAllFlashcards(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: /^(Sezioni|Sections)$/ })
    .getByRole("link", { name: /^Flashcards?\b/ })
    .click();
  await expect(page).toHaveURL(/#\/flashcards$/);
  await page.getByRole("button", { name: /^(Sfoglia tutte|Browse all)$/ }).click();
  await expect(page).toHaveURL(/#\/flashcards\/all$/);
}

/** Picks an item of the Esami menu (the dots in its head), on the exam list. */
export async function fromExamsMenu(page: Page, item: string | RegExp): Promise<void> {
  await page.getByRole("button", { name: /^(Altro su Esami|More for Exams)$/ }).click();
  await page.getByRole("menuitem", { name: item }).click();
}
