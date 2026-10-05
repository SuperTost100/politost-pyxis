import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Guided plan loading and failure (PLAN-10 to PLAN-12). The recorded-reply fixture answers every call the
// same way for a whole launch, so each failing step gets its own launch. No model is called.
const MAIN = join(process.cwd(), process.env.PYXIS_OUT ?? "out", "main/index.js");
const LARGE = Boolean(process.env.PYXIS_UI_LARGE);

const modules = { modules: [{ title: "Cinematica", summary: "Il moto dei corpi" }, { title: "Dinamica", summary: "Le forze" }] };
const topics = { topics: [{ title: "Cinematica del punto", summary: "Moto", subtopics: ["Velocità"] }, { title: "Dinamica", summary: "Forze", subtopics: [] }] };

type State = "loading-modules" | "failed-modules" | "loading-tree" | "failed-tree";
/** What each state needs from the fixture: a bad reply fails the step, the delay (10 s at most) holds a good one in flight. */
const FIXTURES: Record<State, { replies: object; delay: number; step: "modules" | "tree" }> = {
  "loading-modules": { replies: { modules, topics }, delay: 10000, step: "modules" },
  "failed-modules": { replies: { modules: { modules: "no" }, topics }, delay: 0, step: "modules" },
  "loading-tree": { replies: { modules, topics }, delay: 10000, step: "tree" },
  "failed-tree": { replies: { modules, topics: { topics: "no" } }, delay: 0, step: "tree" },
};

const both = (it: string, en: string) => new RegExp(`^(${it}|${en})$`);
const next = (page: Page) => page.getByRole("button", { name: /^(Continua|Continue)$/ });

function launch(userData: string, state: State) {
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(FIXTURES[state].replies),
    PYXIS_E2E_PLAN_DELAY: String(FIXTURES[state].delay),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ args: [MAIN], env });
}

/** Through the wizard to the guided flow, then to the step that calls the model. */
async function reach(page: Page, step: "modules" | "tree") {
  await page.evaluate(() => {
    location.hash = "/plans/new";
  });
  await page.reload();
  await page.getByRole("textbox", { name: /Titolo|Title/, exact: true }).fill("Fisica audit");
  for (let i = 0; i < 4; i++) await next(page).click();
  await page.getByRole("group", { name: both("Periodo", "Period") }).getByRole("button").first().click();
  await next(page).click();
  if (step === "modules") return;
  // A held modules call is allowed to finish: the tree call is what this state waits on.
  await expect(page.getByRole("checkbox").first()).toBeVisible({ timeout: 25000 });
  await page.getByRole("checkbox").first().check();
  await next(page).click();
  await next(page).click();
}

async function expectState(page: Page, state: State) {
  const running = state.startsWith("loading");
  const list = page.getByRole("list", { name: /./ }).filter({ has: page.locator(".px-stepline") });
  await expect(list.locator(".px-stepline")).toHaveCount(1);
  await expect(list.locator(running ? ".px-stepline.is-running" : ".px-stepline.is-failed")).toHaveCount(1);
  if (running) {
    await expect(page.locator(".px-notice")).toHaveCount(0);
    await expect(page.getByRole("button", { name: both("Riprova", "Try again") })).toHaveCount(0);
  } else {
    await expect(page.locator(".px-notice")).toContainText(/Il motore non ha risposto|The engine could not answer/);
    await expect(page.getByRole("button", { name: both("Riprova", "Try again") })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: both("Indietro", "Back") })).toBeVisible();
}

/** Tab through the page and make sure every stop is a visible control, never the body. */
async function tabWalk(page: Page) {
  const seen: string[] = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const element = document.activeElement;
      const rect = element?.getBoundingClientRect();
      return { tag: element?.tagName ?? "", name: element?.textContent?.trim() ?? "", visible: Boolean(rect && rect.width > 0 && rect.height > 0) };
    });
    if (stop.tag === "BODY") break;
    expect(stop.visible, `focus is on an invisible ${stop.tag}`).toBe(true);
    seen.push(`${stop.tag}:${stop.name}`);
  }
  expect(seen.length, "Tab should reach at least the Back button").toBeGreaterThan(0);
}

for (const state of Object.keys(FIXTURES) as State[]) {
  test(`PLAN-10 guided ${state} in both languages, themes and widths`, async () => {
    test.setTimeout(900000);
    const userData = mkdtempSync(join(tmpdir(), "pyxis-guided-states-"));
    const app = await launch(userData, state);
    const failures: string[] = [];
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.getByRole("button", { name: "Salta" }).click();
      await page.evaluate((size) => window.pyxis.invoke("profile.save", { dyslexia: false, textSize: size }), LARGE ? "lg" : "md");
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      mkdirSync(".shots/m14", { recursive: true });
      for (const language of ["it", "en"] as const)
        for (const theme of ["dark", "light"] as const)
          for (const width of [1280, 960]) {
            const key = `guided-${state}-${language}-${theme}-${width}${LARGE ? "-large" : ""}`;
            try {
              await page.evaluate(
                async ({ language, theme }) => {
                  localStorage.setItem("pyxis.lang", language);
                  await window.pyxis.setAppearance(theme);
                },
                { language, theme },
              );
              await page.setViewportSize({ width, height: 800 });
              await reach(page, FIXTURES[state].step);
              await expectState(page, state);
              await page.evaluate(() => document.fonts.ready);
              await tabWalk(page);
              const violations = (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations;
              await page.screenshot({ path: `.shots/m14/${key}.png`, fullPage: true, animations: "disabled" });
              const body = await page.locator("body").innerText();
              const untranslated = body.match(/\b(?:plans|quiz|wizard|jobs|sources)\.[A-Za-z][\w.-]+/g);
              const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
              // Nothing inside the content column may spill past it either, which the page-level check can miss.
              const clipped = await page.evaluate(() =>
                Array.from(document.querySelectorAll<HTMLElement>(".px-wizard-question,.px-stepline-label,.px-notice-text,.px-notice button")).filter(
                  (node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflow !== "visible",
                ).length,
              );
              if (violations.length || untranslated || overflow || clipped || errors.length)
                failures.push(`${key}: ${violations.map((v) => v.id).join(",")} ${untranslated ?? ""} ${overflow ? "overflow" : ""} ${clipped ? "clipped" : ""} ${errors.splice(0).join(";")}`);
            } catch (error) {
              failures.push(`${key}: ${String(error).slice(0, 700)}`);
            }
          }
    } finally {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    }
    writeFileSync(`.tmp/guided-states-${state}${LARGE ? "-large" : ""}.json`, JSON.stringify({ state, failures }, null, 2));
    expect(failures, failures.join("\n")).toEqual([]);
  });
}

test("PLAN-10 a failed guided call can be retried and answers survive Back", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-guided-flow-"));
  const app = await launch(userData, "failed-tree");
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.getByRole("button", { name: "Salta" }).click();
    await page.evaluate(() => window.pyxis.invoke("profile.save", { dyslexia: false, textSize: "md" }));
    await reach(page, "tree");
    await expectState(page, "failed-tree");
    // Retry runs the call again: it shows as running, then fails again with the same, still-actionable error.
    await page.getByRole("button", { name: "Riprova" }).click();
    await expectState(page, "failed-tree");
    // Back from a failed tree returns to the style choice with the module focus still ticked.
    await page.getByRole("button", { name: "Indietro" }).click();
    await expect(page.getByRole("button", { name: /Leggere|Esercitarsi|Decidi tu/ }).first()).toBeVisible();
    await next(page).click();
    await expectState(page, "failed-tree");
    // Back twice reaches the module list, whose tick is still there.
    await page.getByRole("button", { name: "Indietro" }).click();
    await page.getByRole("button", { name: "Indietro" }).click();
    await expect(page.getByRole("checkbox").first()).toBeChecked();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("PLAN-10 Back while the modules load returns to the period step and the late answer is ignored", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-guided-back-"));
  const app = await launch(userData, "loading-modules");
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.getByRole("button", { name: "Salta" }).click();
    await page.evaluate(() => window.pyxis.invoke("profile.save", { dyslexia: false, textSize: "md" }));
    await reach(page, "modules");
    await expectState(page, "loading-modules");
    await page.getByRole("button", { name: "Indietro" }).click();
    await expect(page.getByRole("group", { name: "Periodo" })).toBeVisible();
    // The held call finishes after ten seconds; its modules must not appear on the period step.
    await page.waitForTimeout(11000);
    await expect(page.getByRole("group", { name: "Periodo" })).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
