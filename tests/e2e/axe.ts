import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Runs axe on the page, or only inside the `include` selectors, and fails naming each rule and the elements it flagged.
 * Legacy mode keeps axe in this page; the default opens a second page to collect results, which an Electron app can't.
 */
export async function expectNoAxeViolations(
  page: Page,
  options: { include?: string[]; tags?: string[] } = {},
) {
  let builder = new AxeBuilder({ page }).setLegacyMode(true);
  for (const selector of options.include ?? []) builder = builder.include(selector);
  if (options.tags) builder = builder.withTags(options.tags);
  const { violations } = await builder.analyze();
  expect(
    violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
    ),
  ).toEqual([]);
}
