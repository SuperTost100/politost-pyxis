import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { seedPlan, seedSource } from "./seed";
import { saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

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
    await fromChiediToExams(page);
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
    removeTestFolder(userData);
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
    await fromChiediToExams(page);
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
    removeTestFolder(userData);
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
    await fromChiediToExams(page);
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
    removeTestFolder(userData);
  }
});

test("LAYOUT-04 setup offers the kinds of school, and the profile picks the level from a dropdown that fits its row", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-layout-details-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    // The profile picks the level from a dropdown in its row: the whole field sits inside the card, beside the row's text.
    const fits = async (target: Page) => {
      const field = target.getByRole("combobox", { name: /^(Livello di studio|Education level)$/ });
      await expect(field).toBeVisible();
      const [box, card, title] = await Promise.all([
        field.boundingBox(),
        field.locator("xpath=ancestor::ul[1]").boundingBox(),
        target.getByText(/^(Livello di studio|Education level)$/).boundingBox(),
      ]);
      expect(box!.x).toBeGreaterThanOrEqual(card!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(card!.x + card!.width);
      expect(box!.y).toBeGreaterThanOrEqual(card!.y);
      expect(box!.y + box!.height).toBeLessThanOrEqual(card!.y + card!.height);
      // At 960 px and wider the field shares the row with its name instead of wrapping under it.
      expect(box!.y).toBeLessThan(title!.y + title!.height);
      await expect(field.locator("option")).toHaveCount(7);
    };

    for (const language of ["it", "en"] as const)
      for (const theme of ["light", "dark"] as const)
        for (const size of sizes) {
          const key = `${language}-${theme}-${size.width}`;
          await look(page, language, theme);
          await page.setViewportSize(size);
          // Setup, step one: the profile. Its study levels are now a choice of university or school, then the kind of
          // school, so the balanced grid is only the profile's.
          await page.getByRole("radio", { name: /^(A scuola|At school)$/ }).click();
          await expect(page.getByRole("radiogroup", { name: /^(Che scuola fai|Which school)$/ })).toBeVisible();
          await saveShot(page, `layout-details/setup-levels-${key}.png`, { fullPage: true });
          await expectNoAxeViolations(page);
        }
    await page.getByRole("button", { name: /^(Salta|Skip)$/ }).click();
    await fromChiediToExams(page);

    for (const language of ["it", "en"] as const)
      for (const theme of ["light", "dark"] as const)
        for (const size of sizes) {
          const key = `${language}-${theme}-${size.width}`;
          await look(page, language, theme);
          await page.setViewportSize(size);
          await page.evaluate(() => {
            location.hash = "/settings/profile";
          });
          await fits(page);
          await saveShot(page, `layout-details/profile-levels-${key}.png`, { fullPage: true });
          await expectNoAxeViolations(page);
        }
  } finally {
    await app.close();
    removeTestFolder(userData);
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
    await fromChiediToExams(page);
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

    // No job left: the entry leaves the bar. It is there, with its list open, once the jobs queries have loaded; clearing
    // the finished job then empties them, and the assertion waits for the button to go instead of for a fixed time.
    await expect(page).toHaveURL(/#\/plans\/plan-a\/intro$/);
    const bar = page.locator(".px-reader-bar");
    const entry = bar.getByRole("button", { name: /^(Attività|Background tasks)/ });
    await entry.click();
    await page.getByRole("button", { name: /^(Chiudi le finite|Clear finished)$/ }).click();
    await expect(entry).toHaveCount(0);
    await expect(bar).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("LAYOUT-06 Attività sits in the top-right corner, and a long list stays inside the window", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-layout-jobs-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    const now = Date.now();
    const job = db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,step_label,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    );
    job.run("j-failed", "ocr-data-download", "{}", "failed", 0.5, "sources.jobs.ocrData", "ocr-data-offline", now, now);
    job.run("j-a", "source-import", JSON.stringify({ sourceId: "a" }), "running", 0.4, "sources.jobs.extract", null, now, now);
    job.run("j-b", "source-import", JSON.stringify({ sourceId: "b" }), "running", 0.7, "sources.jobs.extract", null, now, now);
    for (const [index, topic] of ["Limiti", "Derivate", "Integrali", "Serie", "Successioni", "Continuità"].entries()) {
      const at = now - 60_000 * (index + 1);
      job.run(`j-done-${index}`, "lesson-write", JSON.stringify({ exam: "Analisi 1", topic }), "succeeded", 1, null, null, at, at);
    }
    db.close();
    await page.reload();

    // Attività sits in the page's top-right corner, outside the sidebar, and its list opens under it. The list is taller
    // than the window: it stays inside it instead of hanging below, which used to grow the page and scroll the sidebar.
    const side = page.getByRole("complementary", { name: "Barra laterale" });
    await expect(side.getByRole("button", { name: /^Attività/ })).toHaveCount(0);
    const corner = page.locator(".px-corner-tools").getByRole("button", { name: /^Attività/ });
    const icon = (await corner.boundingBox())!;
    expect(icon.x + icon.width).toBeGreaterThan(1280 - 60);
    expect(icon.y).toBeLessThan(60);
    await corner.click();
    const list = page.locator(".px-jobs");
    await expect(list).toBeFocused();
    await expect(list.getByRole("heading", { level: 2, name: "Attività" })).toBeInViewport();
    await expect(list.getByRole("heading", { name: "C'è bisogno di te" })).toBeVisible();
    const box = (await list.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(800 - 16 + 1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect((await side.boundingBox())!.y).toBe(0);
    // A finished job shows its time on its own, beside the exam it belongs to.
    const done = list.locator("li", { hasText: "Lezione su Limiti scritta" });
    await expect(done.locator(".px-jobs-sub")).toHaveText("Analisi 1");
    await expect(done.locator("time")).toHaveText(/^\d{2}:\d{2}$/);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
