import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan, seedSource } from "./seed";
import { SHOTS, saveShot } from "./shots";

const day = 86_400_000;

/** One dated exam with its topics, a due card, a source, a map of its first topic and a written session. */
function seed(
  db: DatabaseSync,
  topics = [
    { id: "t-vec", title: "Misure e vettori" },
    { id: "t-kin", title: "Cinematica: moto rettilineo" },
  ],
) {
  const examAt = Date.now() + 12 * day;
  db.prepare("INSERT INTO subjects(id,name,position,created_at) VALUES('sub-fis','Fisica',0,1),('sub-chi','Chimica',1,1)").run();
  seedSource(db, { id: "s-book", kind: "smartbook", title: "Fisica I, Mazzoldi" });
  seedPlan(db, {
    id: "p-fis",
    subjectId: "sub-fis",
    title: "Fisica I",
    language: "it",
    target: 0.75,
    examAt,
    sourceIds: ["s-book"],
    topics,
  });
  db.prepare("INSERT INTO plan_sessions(id,plan_id,date,label,created_at) VALUES('s-1','p-fis',?,'Written',1)").run(examAt);
  // A second exam of a subject with no maps yet.
  seedPlan(db, { id: "p-chi", subjectId: "sub-chi", title: "Chimica generale", language: "it", examAt: examAt + 20 * day });
  db.prepare("INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES('c-1','p-fis','t-vec','Unità della forza?','Il newton.',1)").run();
  const node = (id: string, label: string, parent: string | null) => ({ id, label, parent, x: 0, y: 0, pinned: false, sources: [] });
  db.prepare("INSERT INTO maps(id,plan_id,topic_id,graph_json,grounding,created_at) VALUES('m-1','p-fis','t-vec',?,'sources',1)").run(
    JSON.stringify({
      layout: "tree",
      nodes: [node("r", "Vettori", null), node("a", "Componenti", "r"), node("b", "Somma", "r")],
      edges: [
        { from: "r", to: "a" },
        { from: "r", to: "b" },
      ],
      undo: null,
    }),
  );
}

async function openExam(page: Page, id = "p-fis", title = "Fisica I") {
  await page.evaluate((id) => {
    location.hash = `/plans/${id}`;
  }, id);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

/** Nothing on the page says it failed or found nothing to show. */
async function expectContent(page: Page, label: string) {
  await expect(page.getByText(/^(No flashcards due|Nothing here|Page not found)/), label).toHaveCount(0);
  await expect(page.locator(".px-error-state"), label).toHaveCount(0);
}

async function pickFromMenu(page: Page, item: string) {
  await page.locator(".px-exam-head").getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test("the exam page shows its rings, Adesso, the path and its sections, and reaches every feature moved onto it", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-exam-page-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    seed(db);
    db.close();
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    await page.reload();
    await openExam(page);

    // The head: the date from the written session, the rings read as one image, and the legend with each value.
    await expect(page.locator(".px-exam-date")).toHaveText(/^Written \w+day/);
    await expect(page.locator(".px-exam-rings").getByRole("img")).toHaveAccessibleName(
      "Preparation not measured yet, Path 0%, Today 0%",
    );
    const legend = page.getByRole("list", { name: "Exam rings" });
    await expect(legend.getByRole("listitem")).toHaveText(["Preparationnot measured yet", "Path0%", "Today0%"]);
    await expectNoAxeViolations(page);

    // Adesso: the path's next step with the one primary button, the same step the exam list names. The due flashcard
    // is not it: it has its own line in the Flashcard block.
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    const row = page.locator(".px-exams-row", { hasText: "Fisica I" }).locator(".px-exams-next");
    await expect(row).toContainText("Now");
    const listed = await row.evaluate((element) =>
      [...element.childNodes]
        .filter((node) => !(node instanceof HTMLElement && node.classList.contains("px-exams-kicker")))
        .map((node) => node.textContent)
        .join("")
        .trim(),
    );
    expect(listed).not.toMatch(/^Flashcards/);
    await openExam(page);
    const now = page.locator(".px-exam-now");
    await expect(now.getByText("Now", { exact: true })).toBeVisible();
    await expect(now.getByRole("heading")).toHaveText(listed);
    await now.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page).not.toHaveURL(/#\/plans\/p-fis$/);
    await expectContent(page, "Adesso's Start");
    await openExam(page);

    // The path holds every activity. Adesso is on no topic, so none starts open; a click opens one with its steps, and
    // another opens from the keyboard.
    const path = page.locator(".px-xpath-list");
    const steps = page.getByRole("list", { name: "Steps for Misure e vettori" });
    await expect(steps).toHaveCount(0);
    await path.getByRole("button", { name: /^Misure e vettori/ }).click();
    await expect(steps.getByRole("button", { name: /^Lesson/ })).toBeVisible();
    await expect(steps.getByRole("button", { name: "Flashcards" })).toBeVisible();
    const second = path.getByRole("button", { name: /^Cinematica: moto rettilineo/ });
    await second.focus();
    await page.keyboard.press("Enter");
    await expect(second).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("list", { name: "Steps for Cinematica: moto rettilineo" })).toBeVisible();
    await expect(steps).toHaveCount(0);
    await path.getByRole("button", { name: /^Exam simulation/ }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis\/simulation$/);
    await openExam(page);
    await expect(path.getByText(/^Written$/)).toBeVisible();

    // Flashcard: review this exam's due cards, or browse its cards. Each way back returns to the exam.
    const aside = page.getByRole("complementary", { name: "Flashcards, questions to redo, maps and material" });
    await expect(aside.getByRole("heading", { name: /^Flashcards/ })).toContainText("1 in all");
    await aside.getByRole("button", { name: "Review the flashcard" }).click();
    await expect(page.getByText("Unità della forza?")).toBeVisible();
    await expectContent(page, "Review the flashcard");
    await page.getByRole("button", { name: "Back to the exam: Fisica I" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis$/);
    await aside.getByRole("button", { name: "Browse all" }).click();
    await expect(page.getByText("Unità della forza?")).toBeVisible();
    await expect(page.locator("#card-exam").locator("xpath=ancestor::*[contains(@class,'ant-select')][1]")).toContainText("Fisica I");
    await page.getByRole("link", { name: "Fisica I", exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis$/);

    // Da rifare says when nothing is waiting.
    await expect(aside.getByText("No questions to redo.")).toBeVisible();

    // Mappe: the subject's maps open, and All maps opens Maps at this subject.
    await aside.getByRole("link", { name: /^Vettori/ }).click();
    await expect(page).toHaveURL(/#\/(maps|plans\/p-fis\/map)\//);
    await expect(page.getByText("Componenti")).toBeVisible();
    await openExam(page);
    await aside.getByRole("link", { name: "All maps" }).click();
    await expect(page).toHaveURL(/#\/maps\?subject=sub-fis$/);
    await expect(page.getByRole("heading", { level: 2, name: "Fisica" })).toBeInViewport();
    await expect(page.getByRole("heading", { level: 2, name: "Fisica" })).toBeFocused();
    // A subject with no maps offers to make one, with the subject already chosen.
    await openExam(page, "p-chi", "Chimica generale");
    await expect(aside.getByText("No maps of this subject yet.")).toBeVisible();
    await expect(aside.getByRole("link", { name: "All maps" })).toHaveCount(0);
    await aside.getByRole("link", { name: "Make a map" }).click();
    const newMap = page.getByRole("dialog", { name: "New map" });
    await expect(newMap).toBeVisible();
    await expect(newMap.locator("#new-map-subject").locator("xpath=ancestor::*[contains(@class,'ant-select')][1]")).toContainText("Chimica");
    await page.keyboard.press("Escape");
    await expect(newMap).toBeHidden();
    await openExam(page);

    // Materiale: a file opens its details beside the page; all the material, with adding and past papers, is a page.
    await aside.getByRole("button", { name: "Fisica I, Mazzoldi" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await aside.getByRole("link", { name: "All material" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis\/sources$/);
    await expect(page.getByRole("heading", { level: 1, name: "Material" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add sources" })).toBeVisible();
    await page.getByRole("link", { name: "Fisica I", exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis$/);

    // The page's menu: the exam's review, creating an activity, the calendar and sharing the exam.
    await pickFromMenu(page, "Review");
    await expect(page).toHaveURL(/#\/plans\/p-fis\/review$/);
    await openExam(page);
    await pickFromMenu(page, "Create an activity");
    const create = page.getByRole("dialog", { name: "Create an activity" });
    await expect(create).toContainText("Lesson");
    await create.getByRole("button", { name: "Close" }).click();
    await expect(create).toBeHidden();
    await page.locator(".px-exam-head").getByRole("button", { name: "More", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Add to calendar" })).toBeVisible();
    await page.keyboard.press("Escape");
    await pickFromMenu(page, "Share the exam");
    const share = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Save file" }) });
    await expect(share).toBeVisible();
    await share.getByRole("button", { name: "Close" }).click();
    await expect(share).toBeHidden();
    await page.getByRole("button", { name: "Exam settings" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis\/settings$/);

    // Set the hours brings the weekly hours field into view and puts the focus in it, also in the smallest window.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 700));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960);
    await openExam(page);
    await page.getByRole("button", { name: "Set the hours" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis\/settings$/);
    const hours = page.getByRole("spinbutton", { name: "Hours a week" });
    await expect(hours).toBeFocused();
    await expect(hours).toBeInViewport();

    // Old addresses of the removed tabs open the page.
    await page.evaluate(() => {
      location.hash = "/plans/p-fis/progress";
    });
    await expect(page.getByRole("heading", { level: 2, name: "Path" })).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** Sets the window to `width` device pixels at `zoom`, as Ctrl and plus do, and returns the page's width in CSS pixels. */
async function zoomWindow(app: ElectronApplication, page: Page, width: number, zoom: number) {
  await app.evaluate(
    ({ BrowserWindow }, { width, zoom }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setContentSize(width, 800);
      window.webContents.setZoomFactor(zoom);
    },
    { width, zoom },
  );
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(width / zoom));
}

/**
 * The window's own pixels, as the student sees them. Playwright's page screenshot takes CSS pixels, so at 200% zoom it
 * would show only the left half of the window. The window is made tall first, to take the whole page in one image.
 */
async function shootZoomedWindow(app: ElectronApplication, name: string) {
  if (!SHOTS) return;
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const [width] = window.getContentSize();
    window.setContentSize(width!, 4200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const bottom = (await window.webContents.executeJavaScript(
      "document.querySelector('.shell-page').getBoundingClientRect().bottom",
    )) as number;
    window.setContentSize(width!, Math.ceil((bottom + 24) * window.webContents.getZoomFactor()));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const image = await window.webContents.capturePage();
    window.setContentSize(width!, 800);
    return image.toPNG().toString("base64");
  });
  const path = join(SHOTS, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(png, "base64"));
}

// 960 px is the smallest window; at 200% zoom its page is 480 CSS pixels wide.
const narrowCases = [
  { name: "960 px", width: 960, zoom: 1, text: "md" },
  { name: "960 px, 200% zoom", width: 960, zoom: 2, text: "md" },
  { name: "1280 px, 200% zoom", width: 1280, zoom: 2, text: "md" },
  { name: "960 px, large text", width: 960, zoom: 1, text: "lg" },
  { name: "1280 px", width: 1280, zoom: 1, text: "md" },
] as const;

test("the exam page keeps its path readable in the smallest window, at 200% zoom and with large text", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-exam-narrow-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    seed(db, [
      { id: "t-vec", title: "Misure e vettori" },
      { id: "t-kin", title: "Cinematica: moto rettilineo" },
      { id: "t-din", title: "Dinamica del punto materiale e leggi di Newton" },
    ]);
    db.close();
    for (const [language, theme] of [
      ["it", "dark"],
      ["en", "light"],
    ] as const) {
      await page.evaluate(
        async ({ language, theme }) => {
          localStorage.setItem("pyxis.lang", language);
          await window.pyxis.setAppearance(theme);
        },
        { language, theme },
      );
      for (const size of narrowCases) {
        await page.evaluate((textSize) => window.pyxis.invoke("profile.save", { dyslexia: false, textSize }), size.text);
        await page.reload();
        await zoomWindow(app, page, size.width, size.zoom);
        await openExam(page);
        const label = `${size.name}, ${language} ${theme}`;
        const title = page.locator(".px-xpath-title").first();
        await expect(title).toBeVisible();
        const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
        const path = await box(".px-exam-path");
        const aside = await box(".px-exam-aside");
        const fontSize = await title.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
        // Attività stays in the window's top-right corner, and the page's content never runs under it.
        const corner = (await page.locator(".px-corner-tools").boundingBox())!;
        const right = await page.locator(".px-exam").evaluate((element) => element.getBoundingClientRect().right);
        expect(right, `${label}: the page stays clear of Attività`).toBeLessThanOrEqual(corner.x);
        // The path has room for a topic's title and its marker: about 20 letters of the title's own size.
        expect(path.width, `${label}: the path is not squeezed`).toBeGreaterThanOrEqual(20 * fontSize);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          `${label}: nothing overflows sideways`,
        ).toBe(true);
        // The sections sit under the path when the page is narrow, and beside it when there is room.
        if (size.width / size.zoom < 700) expect(aside.y, `${label}: sections under the path`).toBeGreaterThanOrEqual(path.y + path.height - 1);
        else expect(aside.x, `${label}: sections beside the path`).toBeGreaterThan(path.x + path.width - 1);
        const shot = `exam-narrow/${size.name.replace(/%/g, "").replace(/[ ,]+/g, "-")}-${language}-${theme}.png`;
        await page.evaluate(() => window.scrollTo(0, 0));
        if (size.zoom === 1) await saveShot(page, shot, { fullPage: true, animations: "disabled" });
        else await shootZoomedWindow(app, shot);
      }
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
