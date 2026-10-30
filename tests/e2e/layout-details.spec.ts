import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { seedPlan, seedSource } from "./seed";
import { saveShot } from "./shots";

const sizes = [
  { width: 1280, height: 800 },
  { width: 960, height: 640 },
] as const;

async function look(page: Page, language: "it" | "en", theme: "light" | "dark") {
  await page.evaluate(
    async ({ language, theme }) => {
      localStorage.setItem("pyxis.lang", language);
      await window.pyxis.setAppearance(theme);
    },
    { language, theme },
  );
  await page.reload();
}

/** Seeds an exam with two topics (the first with a summary and sub-topics), one source and a finished job. */
function seed(db: DatabaseSync) {
  seedSource(db, {
    id: "src-a",
    title: "Appunti di fisica",
    document: { id: "doc-a" },
    passages: [{ id: "pa-1", text: "La forza è il prodotto di massa e accelerazione.", section: "1. Forze" }],
  });
  // A title with no spaces to break at, for the viewer's header.
  seedSource(db, {
    id: "src-long",
    title: "Appunti_di_fisica_generale_per_il_corso_di_laurea_in_ingegneria_edile_e_dei_sistemi_territoriali_2026",
    library: 1,
    document: { id: "doc-long" },
    passages: [{ id: "pa-long", text: "Una riga del capitolo lungo.", section: "1. Forze" }],
  });
  seedPlan(db, {
    id: "plan-a",
    title: "Fisica 1",
    language: "it",
    sourceIds: ["src-a"],
    topics: [
      { id: "topic-a", title: "Misure e vettori" },
      { id: "topic-b", title: "Cinematica del punto" },
    ],
  });
  db.prepare("UPDATE topics SET tree_json = ? WHERE id = 'topic-a'").run(
    JSON.stringify({ summary: "Misure e vettori", subtopics: ["Introduzione", "Metodo sperimentale e misure", "Vettori e versori"] }),
  );
  db.prepare("INSERT INTO items(id,plan_id,kind,body_json,created_at) VALUES('intro-a','plan-a','intro',?,1)").run(
    JSON.stringify({ markdown: "Benvenuto in **Fisica 1**.", passageIds: [] }),
  );
  const now = Date.now();
  db.prepare(
    "INSERT INTO jobs(id,kind,params_json,state,progress,created_at,updated_at) VALUES('job-a','lesson-write',?,'succeeded',1,?,?)",
  ).run(JSON.stringify({ exam: "Fisica 1", topic: "Misure e vettori" }), now - 60_000, now - 30_000);
}

test("LAYOUT-01 the exam page names the lesson once, its path row keeps one type size, and the Sources row opens whole", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-layout-details-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seed(db);
    db.close();

    for (const language of ["it", "en"] as const)
      for (const theme of ["light", "dark"] as const)
        for (const size of sizes) {
          const key = `${language}-${theme}-${size.width}`;
          await look(page, language, theme);
          await page.setViewportSize(size);
          await page.evaluate(() => {
            location.hash = "/plans/plan-a";
          });
          await expect(page.locator(".px-path-rows")).toBeVisible();
          const lessonName = language === "it" ? "Lezione" : "Lesson";
          // The path starts on the introduction, so open the first topic.
          await page.locator(".px-path-row.is-topic .px-path-row-main").first().click();
          // The step chips and the other-activity list call the lesson by the same name.
          await expect(page.locator(".px-path-step").first()).toContainText(lessonName);
          await page
            .locator(".px-path-next")
            .getByRole("button", { name: /^(Scegli un'altra attività|Choose another activity)$/ })
            .click();
          await expect(page.locator(".px-path-chooser")).toContainText(lessonName);
          await expect(page.getByText(/Testo smart|Smart text/)).toHaveCount(0);

          // The open topic's summary and sub-topics share one font size and colour.
          const about = page.locator(".px-path-about");
          await expect(about).toBeVisible();
          const type = await about.evaluate((element) => {
            const own = getComputedStyle(element);
            return {
              own: [own.fontSize, own.lineHeight, own.color],
              inner: Array.from(element.querySelectorAll(".px-markdown")).map((part) => {
                const style = getComputedStyle(part);
                return [style.fontSize, style.lineHeight, style.color];
              }),
            };
          });
          expect(type.inner.length).toBeGreaterThan(0);
          for (const part of type.inner) expect(part).toEqual(type.own);
          await saveShot(page, `layout-details/path-${key}.png`);
          await expectNoAxeViolations(page);

          // The whole Sources row is the target: the meta line opens the panel, and the name stays the only control that does.
          await page.evaluate(() => {
            location.hash = "/plans/plan-a/sources";
          });
          // A fresh page: the other-activity list above would take the first click as a click outside it.
          await page.reload();
          const row = page.locator(".px-source-row").first();
          await expect(row).toBeVisible();
          await expect(row.getByRole("button", { name: "Appunti di fisica", exact: true })).toHaveCount(1);
          await saveShot(page, `layout-details/sources-${key}.png`);
          // A real pointer click at the meta line: the title button's stretched area takes it, which is the point.
          const click = async (selector: string) => {
            await row.scrollIntoViewIfNeeded();
            const box = (await row.locator(selector).boundingBox())!;
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          };
          await click(".px-source-row-meta");
          await expect(page.getByRole("dialog")).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog")).toHaveCount(0);
          // The status area at the right opens it too.
          await click(".px-source-row-status");
          await expect(page.getByRole("dialog")).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog")).toHaveCount(0);
        }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("LAYOUT-02 the source viewer has one way back and one close, side by side", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-layout-details-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seed(db);
    db.close();

    for (const language of ["it", "en"] as const)
      for (const theme of ["light", "dark"] as const)
        for (const size of sizes) {
          const key = `${language}-${theme}-${size.width}`;
          await look(page, language, theme);
          await page.setViewportSize(size);
          await page.evaluate(() => {
            location.hash = "/plans/plan-a/sources";
          });
          await expect(page.locator(".px-source-row")).toBeVisible();
          await page.evaluate(() =>
            window.dispatchEvent(
              new CustomEvent("pyxis:source-viewer", { detail: { passageId: "pa-1", back: () => undefined } }),
            ),
          );
          const viewer = page.getByRole("dialog");
          await expect(viewer.getByText(/La forza è il prodotto/)).toBeVisible();
          const back = viewer.getByRole("button", { name: /^(Dettagli della fonte|Source details)$/ });
          const close = viewer.getByRole("button", { name: /^(Chiudi|Close)$/ });
          await expect(back).toHaveCount(1);
          await expect(close).toHaveCount(1);
          const [backBox, closeBox] = [await back.boundingBox(), await close.boundingBox()];
          // Same row: their vertical centres are within a few pixels, the close at the right of the way back.
          const centre = (box: NonNullable<typeof backBox>) => box.y + box.height / 2;
          expect(Math.abs(centre(backBox!) - centre(closeBox!))).toBeLessThan(8);
          expect(closeBox!.x).toBeGreaterThan(backBox!.x + backBox!.width);
          await saveShot(page, `layout-details/viewer-${key}.png`);
          await close.click();
          await expect(page.getByRole("dialog")).toHaveCount(0);

          // Opened without a way back, a long unbroken title wraps inside its own column and leaves the close button clear.
          await page.evaluate(() =>
            window.dispatchEvent(new CustomEvent("pyxis:source-viewer", { detail: { passageId: "pa-long" } })),
          );
          await expect(viewer.getByText(/Una riga del capitolo lungo/)).toBeVisible();
          const title = viewer.locator(".source-viewer-title");
          const [titleBox, closeOnly] = [await title.boundingBox(), await viewer.locator(".source-viewer-close").boundingBox()];
          expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(closeOnly!.x);
          const overflow = await title.evaluate((element) => element.scrollWidth > element.clientWidth);
          expect(overflow).toBe(false);
          await saveShot(page, `layout-details/viewer-long-${key}.png`);
          await expectNoAxeViolations(page);
          await viewer.getByRole("button", { name: /^(Chiudi|Close)$/ }).click();
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await page.evaluate(() =>
            window.dispatchEvent(
              new CustomEvent("pyxis:source-viewer", { detail: { passageId: "pa-1", back: () => undefined } }),
            ),
          );
          await expect(viewer.getByText(/La forza è il prodotto/)).toBeVisible();
          await expectNoAxeViolations(page);
          await close.click();
          await expect(page.getByRole("dialog")).toHaveCount(0);
        }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("LAYOUT-03 the exam settings save bar leaves the goal slider in view", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-layout-details-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seed(db);
    db.close();

    for (const language of ["it", "en"] as const)
      for (const theme of ["light", "dark"] as const)
        for (const size of sizes) {
          const key = `${language}-${theme}-${size.width}`;
          await look(page, language, theme);
          await page.setViewportSize(size);
          await page.evaluate(() => {
            location.hash = "/plans/plan-a/settings";
          });
          const rail = page.locator(".px-set-goal .ant-slider-rail");
          await expect(rail).toBeVisible();
          await expect(page.getByRole("region", { name: /^(Modifiche da salvare|Changes to save)$/ })).toHaveCount(0);
          // Put the slider at the bottom edge of the window, where the bar will land when the goal changes.
          await page.evaluate(() => {
            const slider = document.querySelector(".px-set-goal .ant-slider")!;
            window.scrollBy(0, slider.getBoundingClientRect().bottom - innerHeight + 16);
          });
          const before = (await rail.boundingBox())!;
          await page.mouse.click(before.x + before.width * 0.3, before.y + before.height / 2);
          const bar = page.getByRole("region", { name: /^(Modifiche da salvare|Changes to save)$/ });
          await expect(bar).toBeVisible();
          const barBox = (await bar.boundingBox())!;
          // The whole goal group, its caption included, sits above the bar.
          const group = page.locator(".px-set-group", { has: page.locator(".px-set-goal") });
          await expect
            .poll(async () => {
              const box = (await group.boundingBox())!;
              return box.y + box.height <= barBox.y;
            })
            .toBe(true);
          await saveShot(page, `layout-details/settings-goal-${key}.png`);
          await expectNoAxeViolations(page);
        }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("LAYOUT-04 the study levels fill their rows in setup and in the profile", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-layout-details-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const rows = (target: Page) =>
      target.evaluate(() => {
        const grid = document.querySelector(".px-profile-levels")!;
        const box = grid.getBoundingClientRect();
        const lines = new Map<number, Array<{ left: number; right: number }>>();
        for (const item of Array.from(grid.children)) {
          const rect = item.getBoundingClientRect();
          const line = lines.get(Math.round(rect.top)) ?? [];
          line.push({ left: rect.left, right: rect.right });
          lines.set(Math.round(rect.top), line);
        }
        return {
          left: box.left,
          right: box.right,
          lines: [...lines.values()].map((line) => ({
            count: line.length,
            left: Math.min(...line.map((item) => item.left)),
            right: Math.max(...line.map((item) => item.right)),
          })),
        };
      });
    const balanced = async (target: Page) => {
      const found = await rows(target);
      expect(found.lines.length).toBeGreaterThan(1);
      for (const line of found.lines) {
        // No row holds a single option, and every row runs the full width of the grid.
        expect(line.count).toBeGreaterThan(1);
        expect(Math.abs(line.left - found.left)).toBeLessThan(1);
        expect(Math.abs(line.right - found.right)).toBeLessThan(1);
      }
      const counts = found.lines.map((line) => line.count);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    };

    for (const language of ["it", "en"] as const)
      for (const theme of ["light", "dark"] as const)
        for (const size of sizes) {
          const key = `${language}-${theme}-${size.width}`;
          await look(page, language, theme);
          await page.setViewportSize(size);
          // Setup, step one: the profile.
          await expect(page.locator(".px-profile-levels")).toBeVisible();
          await balanced(page);
          await saveShot(page, `layout-details/setup-levels-${key}.png`, { fullPage: true });
          await expectNoAxeViolations(page);
        }
    await page.getByRole("button", { name: /^(Salta|Skip)$/ }).click();
    await expect(page).toHaveURL(/#\/exams$/);

    for (const language of ["it", "en"] as const)
      for (const theme of ["light", "dark"] as const)
        for (const size of sizes) {
          const key = `${language}-${theme}-${size.width}`;
          await look(page, language, theme);
          await page.setViewportSize(size);
          await page.evaluate(() => {
            location.hash = "/settings/profile";
          });
          await expect(page.locator(".px-profile-levels")).toBeVisible();
          await balanced(page);
          await saveShot(page, `layout-details/profile-levels-${key}.png`, { fullPage: true });
          await expectNoAxeViolations(page);
        }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("LAYOUT-05 a reading page keeps the jobs entry, and an empty Exams list says what to do next", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-layout-details-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));

    // Skipping setup leaves no exam: one primary action creates the first one.
    for (const language of ["it", "en"] as const)
      for (const theme of ["light", "dark"] as const)
        for (const size of sizes) {
          const key = `${language}-${theme}-${size.width}`;
          await look(page, language, theme);
          await page.setViewportSize(size);
          await expect(page.locator(".empty h2")).toHaveText(
            language === "it" ? "Crea un esame per iniziare" : "Create an exam to get started",
          );
          const primary = page.locator(".empty .ant-btn-primary");
          await expect(primary).toHaveCount(1);
          await expect(primary).toHaveText(language === "it" ? "Nuovo esame" : "New exam");
          await saveShot(page, `layout-details/exams-empty-${key}.png`);
          await expectNoAxeViolations(page);
        }

    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seed(db);
    db.close();
    for (const language of ["it", "en"] as const)
      for (const theme of ["light", "dark"] as const)
        for (const size of sizes) {
          const key = `${language}-${theme}-${size.width}`;
          await look(page, language, theme);
          await page.setViewportSize(size);
          await page.evaluate(() => {
            location.hash = "/plans/plan-a/intro";
          });
          await expect(page.getByText("Benvenuto in")).toBeVisible();
          // The shell's jobs entry, with today's finished job behind it.
          const jobs = page.locator(".px-reader-bar").getByRole("button", { name: /^(Attività|Background tasks)/ });
          await expect(jobs).toBeVisible();
          await jobs.click();
          await expect(page.locator(".px-jobs")).toBeVisible();
          await saveShot(page, `layout-details/reader-jobs-${key}.png`);
          await expectNoAxeViolations(page);
          await page.keyboard.press("Escape");
          await expect(page.locator(".px-jobs")).toBeHidden();
        }

    // No job at all: the entry stays out of sight. The reload gives React Query a fresh client, so it cannot reuse the cached jobs.
    const empty = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    empty.exec("DELETE FROM jobs");
    empty.close();
    await look(page, "en", "light");
    await page.setViewportSize(sizes[0]);
    await page.evaluate(() => {
      location.hash = "/plans/plan-a/intro";
    });
    await page.reload();
    await expect(page).toHaveURL(/#\/plans\/plan-a\/intro$/);
    // The introduction text is seeded Italian content, so it shows the page loaded in either interface language.
    await expect(page.getByText("Benvenuto in")).toBeVisible();
    await expect(page.locator(".px-reader-bar")).toBeVisible();
    await expect(
      page.locator(".px-reader-bar").getByRole("button", { name: /^(Attività|Background tasks)/ }),
    ).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
