import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import type { Result } from "axe-core";
import { animationsSettled } from "./settled";

/**
 * Runs axe in this page (legacy mode: the default opens a second page to collect results, which an Electron app
 * can't) and returns its violations, or only those inside the `include` selectors and tags.
 *
 * The formula keyboard's keys are skipped by `label-content-name-mismatch` only. A key draws its symbol with KaTeX,
 * whose text nodes sit side by side with nothing between them (the `y` and `x` of a fraction read as "yx"), so no
 * name a person would say or hear can contain that text. Every key keeps its spoken name.
 *
 * The check waits until no finite animation or transition is running. Axe blends a text's colour with its opacity and
 * background as they are at that moment, so a button whose colours are half way through a 150 ms transition (just
 * enabled, just hovered, in a dialog that is still zooming in) fails `color-contrast` on a slow runner, although it
 * passes once it is at rest. Looping animations are not waited for.
 */
export async function axeViolations(
  page: Page,
  options: { include?: string[]; tags?: string[] } = {},
): Promise<Result[]> {
  await animationsSettled(page);
  let builder = new AxeBuilder({ page }).setLegacyMode(true);
  for (const selector of options.include ?? []) builder = builder.include(selector);
  if (options.tags) builder = builder.withTags(options.tags);
  const { violations } = await builder.analyze();
  return violations
    .map((violation) =>
      violation.id === "label-content-name-mismatch"
        ? { ...violation, nodes: violation.nodes.filter((node) => !/class="[^"]*\bpx-formula-key\b/.test(node.html)) }
        : violation,
    )
    .filter((violation) => violation.nodes.length > 0);
}

/** Runs axe on the page, or only inside the `include` selectors, and fails naming each rule and the elements it flagged. */
export async function expectNoAxeViolations(
  page: Page,
  options: { include?: string[]; tags?: string[] } = {},
) {
  const violations = await axeViolations(page, options);
  expect(
    violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
    ),
  ).toEqual([]);
}
