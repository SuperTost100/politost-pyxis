import { expect, type Page } from "@playwright/test";

/**
 * Setup ends on Chiedi. Most tests start from Esami, as the app did before 0.5, so this waits for Chiedi and then
 * opens Esami from the top bar.
 */
export async function fromChiediToExams(page: Page): Promise<void> {
  await expect(page).toHaveURL(/#\/ask$/);
  await page
    .locator("header nav")
    .getByRole("link", { name: /^(Esami|Exams)$/ })
    .click();
  await expect(page).toHaveURL(/#\/exams$/);
}
