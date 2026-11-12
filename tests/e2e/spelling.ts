import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { answerNextMenu, lastMenuLabels } from "./native-menu";

/** A word Italian writes with an acute accent, typed with a grave one: Hunspell's Italian dictionary flags it. */
export const MISSPELLED = "perchè";
export const SUGGESTED = "perché";

/**
 * Types MISSPELLED into the first text field and right-clicks it until the text menu offers spelling suggestions,
 * which the checker gives only once it has a dictionary for the word's language. Returns that menu's labels. The window
 * must show a text field: the onboarding's first step, or any page after it.
 */
export async function misspellingMenu(app: ElectronApplication, page: Page): Promise<string[]> {
  const field = page.getByRole("textbox").first();
  await field.click();
  await page.keyboard.type(`${MISSPELLED} `);
  let labels: string[] = [];
  await expect(async () => {
    await answerNextMenu(app, null);
    // The word is at the start of the field: the click lands on it, as a student's would.
    await field.click({ button: "right", position: { x: 18, y: 12 } });
    await expect.poll(() => lastMenuLabels(app)).toBeDefined();
    labels = (await lastMenuLabels(app))!;
    expect(labels).toContain("Aggiungi al dizionario");
  }).toPass({ timeout: 20_000 });
  return labels;
}
