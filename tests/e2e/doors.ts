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

/** Picks an item of the Esami menu (the dots in its head), on the exam list. */
export async function fromExamsMenu(page: Page, item: string | RegExp): Promise<void> {
  await page.getByRole("button", { name: /^(Altro su Esami|More for Exams)$/ }).click();
  await page.getByRole("menuitem", { name: item }).click();
}
