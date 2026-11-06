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
