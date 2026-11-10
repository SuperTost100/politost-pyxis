import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan, seedSource } from "./seed";

const day = 86_400_000;

/** One dated exam with two topics, a due card, a source, a map of its first topic and a written session. */
function seed(db: DatabaseSync) {
  const examAt = Date.now() + 12 * day;
  seedSource(db, { id: "s-book", kind: "smartbook", title: "Fisica I, Mazzoldi" });
  seedPlan(db, {
    id: "p-fis",
    title: "Fisica I",
    language: "it",
    target: 0.75,
    examAt,
    sourceIds: ["s-book"],
    topics: [
      { id: "t-vec", title: "Misure e vettori" },
      { id: "t-kin", title: "Cinematica: moto rettilineo" },
    ],
  });
  db.prepare("INSERT INTO plan_sessions(id,plan_id,date,label,created_at) VALUES('s-1','p-fis',?,'Written',1)").run(examAt);
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

async function openExam(page: Page) {
  await page.evaluate(() => {
    location.hash = "/plans/p-fis";
  });
  await expect(page.getByRole("heading", { level: 1, name: "Fisica I" })).toBeVisible();
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

    // Adesso: the path's suggestion with the one primary button.
    const now = page.locator(".px-exam-now");
    await expect(now.getByText("Now", { exact: true })).toBeVisible();
    await now.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis\/(intro|diagnostic)$/);
    await openExam(page);

    // The path holds every activity: a topic opens to its steps from the keyboard, the simulation is a step.
    const path = page.locator(".px-xpath-list");
    const topic = path.getByRole("button", { name: /^Misure e vettori/ });
    await topic.focus();
    await page.keyboard.press("Enter");
    await expect(topic).toHaveAttribute("aria-expanded", "true");
    const steps = page.getByRole("list", { name: "Steps for Misure e vettori" });
    await expect(steps.getByRole("button", { name: /^Lesson/ })).toBeVisible();
    await expect(steps.getByRole("button", { name: /^Flashcards, 1 due/ })).toBeVisible();
    await path.getByRole("button", { name: /^Exam simulation/ }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis\/simulation$/);
    await openExam(page);
    await expect(path.getByText(/^Written$/)).toBeVisible();

    // Flashcard: review today's, or browse every card.
    const aside = page.getByRole("complementary", { name: "Flashcards, questions to redo, maps and material" });
    await expect(aside.getByRole("heading", { name: /^Flashcards/ })).toContainText("1 in all");
    await aside.getByRole("button", { name: "Review the flashcard" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis\/review\/cards$/);
    await openExam(page);
    await aside.getByRole("button", { name: "Browse all" }).click();
    await expect(page).toHaveURL(/#\/exams\/cards$/);
    await openExam(page);

    // Da rifare says when nothing is waiting.
    await expect(aside.getByText("No questions to redo.")).toBeVisible();

    // Mappe: the subject's maps open, and so does the list of all maps.
    await aside.getByRole("link", { name: /^Vettori/ }).click();
    await expect(page).toHaveURL(/#\/(maps|plans\/p-fis\/map)\//);
    await openExam(page);
    await aside.getByRole("link", { name: "All maps" }).click();
    await expect(page).toHaveURL(/#\/maps$/);
    await openExam(page);

    // Materiale: a file opens its details beside the page; all the material, with adding and past papers, is a page.
    await aside.getByRole("button", { name: "Fisica I, Mazzoldi" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
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
    await expect(page.getByRole("dialog")).toContainText("Lesson");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.locator(".px-exam-head").getByRole("button", { name: "More", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Add to calendar" })).toBeVisible();
    await page.keyboard.press("Escape");
    await pickFromMenu(page, "Share the exam");
    await expect(page.getByRole("dialog").getByRole("button", { name: "Save file" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Exam settings" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis\/settings$/);

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
