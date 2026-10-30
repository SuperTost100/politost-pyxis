import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan } from "./seed";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";
import { animationsSettled } from "./settled";

/** Local noon, `days` from today, as plan settings store an exam date. */
function noonIn(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(12, 0, 0, 0);
  return date;
}
const dmy = (date: Date) =>
  `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, "").split("\r\n");

test("EXAM-01 an exam holds a written and an oral session, and a finished exam can be archived and restored", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-sessions-check-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10000,
    });
    const written = noonIn(21);
    const oral = noonIn(33);
    // A goal off the slider's steps: saving other settings must leave it exactly as stored.
    seedPlan(db, { id: "plan-a", title: "Fisica 1", language: "it", target: 0.77, topics: [{ id: "topic-a", title: "Cinematica" }] });
    seedPlan(db, { id: "plan-b", title: "Analisi 2", language: "it", topics: [{ id: "topic-b", title: "Integrali" }] });
    db.exec(`
      INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES('card-a','plan-a','topic-a','Cos''è la velocità?','Spazio sul tempo',1);
      INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES('card-b','plan-b','topic-b','Cos''è un integrale?','Un''area',1);
    `);
    db.close();

    const setLook = async (language: "en" | "it", theme: "light" | "dark") => {
      await page.evaluate(
        async ({ language, theme }) => {
          localStorage.setItem("pyxis.lang", language);
          await window.pyxis.setAppearance(theme);
        },
        { language, theme },
      );
      await page.reload();
    };
    const snap = async (name: string, language: string, theme: string) => {
      await saveShot(page, `${name}-${language}-${theme}.png`);
    };
    await setLook("en", "light");
    await page.setViewportSize({ width: 1280, height: 860 });
    const read = (planId: string) =>
      page.evaluate((id) => window.pyxis.invoke("plans.read", { planId: id }), planId);

    // Exam settings: two sessions, the first with a time and a place.
    await page.evaluate(() => {
      location.hash = "/plans/plan-a";
    });
    await page.getByRole("button", { name: "Exam settings" }).click();
    await expect(page).toHaveURL(/#\/plans\/plan-a\/settings$/);
    await expect(page.getByRole("heading", { name: "Exam settings", level: 1 })).toBeVisible();
    const settingsPage = page.locator(".px-exam-settings");
    const saveBar = page.getByRole("region", { name: "Changes to save" });
    // Nothing changed yet, so there is nothing to save.
    await expect(saveBar).toHaveCount(0);
    await settingsPage.getByLabel("Exam date").fill(dmy(written));
    await page.keyboard.press("Enter");
    await settingsPage.getByLabel("Time (optional)").fill("09:30");
    await page.keyboard.press("Enter");
    await settingsPage.getByLabel("Name (optional)").fill("Written");
    await settingsPage.getByLabel("Place (optional)").fill("Aula 5");
    await settingsPage.getByRole("button", { name: "Add another session" }).click();
    await settingsPage.getByLabel("Date", { exact: true }).fill(dmy(oral));
    await page.keyboard.press("Enter");
    await settingsPage.getByLabel("Time (optional)").nth(1).fill("14:00");
    await page.keyboard.press("Enter");
    await settingsPage.getByLabel("Name (optional)").nth(1).fill("Oral");
    await settingsPage.getByLabel("Place (optional)").nth(1).fill("Studio 14");
    // The bar names what changed, and the calendar button waits for the sessions to be saved.
    await expect(saveBar).toContainText("1 change to save: the sessions.");
    await expect(settingsPage.getByRole("button", { name: "Add to calendar" })).toBeDisabled();
    await snap("plan-settings-sessions", "en", "light");
    await saveBar.getByRole("button", { name: "Save changes" }).click();
    await expect(saveBar).toHaveCount(0);
    // Saving says so, and the bar's room goes with the bar.
    await expect(page.getByText("Changes saved")).toBeVisible();
    // The spin buttons are in the interface language, not antd's English.
    await expect(settingsPage.getByRole("button", { name: "Increase", exact: true })).toBeAttached();
    await expect(settingsPage.getByRole("button", { name: "Increase Value" })).toHaveCount(0);
    // With no weekly hours saved, the planner's estimate is offered in the field, not an empty box.
    const useHours = settingsPage.getByRole("button", { name: /^Use .+ h$/ });
    await expect(useHours).toBeVisible();
    await expect(settingsPage.getByLabel("Hours a week")).toHaveAttribute("placeholder", /\d/);
    // The goal slider is gold, as in setup.
    await expect(settingsPage.locator(".px-wizard-gold-slider")).toHaveCount(1);

    const plan = await read("plan-a");
    expect(plan!.sessions.map((s) => [s.label, s.time, s.place])).toEqual([
      ["Written", "09:30", "Aula 5"],
      ["Oral", "14:00", "Studio 14"],
    ]);
    expect(plan!.examAt).toBe(written.getTime());
    // The untouched goal is saved back exactly as stored.
    expect(plan!.target).toBe(0.77);
    await settingsPage.getByRole("link", { name: "Fisica 1" }).click();
    await expect(page).toHaveURL(/#\/plans\/plan-a$/);
    // No weekly hours yet, so the path has no expected dates and says how to get them.
    const hoursHint = page.getByText("Set your weekly hours to see when you will study each topic.");
    await expect(hoursHint).toBeVisible();
    await page.getByRole("button", { name: "Set the hours" }).click();
    await expect(page).toHaveURL(/#\/plans\/plan-a\/settings$/);
    await settingsPage.getByRole("link", { name: "Fisica 1" }).click();
    await expect(page).toHaveURL(/#\/plans\/plan-a$/);
    // The header lists them, and the calendar file has one timed event each with the place as its location.
    const list = page.getByRole("list", { name: "Exam sessions" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list).toContainText("Written");
    await expect(list).toContainText("Studio 14");
    const calendar = await page.evaluate(() =>
      window.pyxis.invoke("plans.calendar", { planId: "plan-a", language: "en" }),
    );
    const lines = unfold(Buffer.from(calendar.base64, "base64").toString("utf8"));
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(2);
    expect(lines).toContain("LOCATION:Aula 5");
    expect(lines).toContain("LOCATION:Studio 14");
    expect(lines.filter((l) => l.startsWith("DTSTART:"))).toHaveLength(2);
    await snap("plan-header-sessions", "en", "light");
    await setLook("en", "dark");
    await snap("plan-header-sessions", "en", "dark");
    await page.getByRole("button", { name: "Exam settings" }).click();
    await expect(page.getByRole("heading", { name: "Exam settings", level: 1 })).toBeVisible();
    await snap("plan-settings-sessions", "en", "dark");
    await expectNoAxeViolations(page);

    // Remove the second session again: one session left, no frame around it.
    await settingsPage.getByRole("button", { name: "Remove session 2" }).click();
    await expect(settingsPage.getByRole("button", { name: /^Remove session/ })).toHaveCount(0);
    // A new name and goal join the list. The goal moves from the keyboard.
    await settingsPage.getByLabel("Exam name").fill("Fisica generale");
    await settingsPage.getByRole("slider", { name: "Goal, out of 30" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(settingsPage.getByText("It was 23.1/30 before.")).toBeVisible();
    await expect(saveBar).toContainText("3 changes to save: the name, the sessions and the goal.");
    await snap("plan-settings-changes", "en", "dark");
    await expectNoAxeViolations(page);
    // Leaving with unsaved changes asks first.
    await settingsPage.getByRole("link", { name: "Fisica 1" }).click();
    const leave = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect(leave).toContainText("You changed the name, the sessions and the goal.");
    await leave.getByRole("button", { name: "Stay here" }).click();
    await expect(leave).toBeHidden();
    await expect(page).toHaveURL(/#\/plans\/plan-a\/settings$/);
    await saveBar.getByRole("button", { name: "Discard changes" }).click();
    await expect(saveBar).toHaveCount(0);
    await expect(settingsPage.getByLabel("Exam name")).toHaveValue("Fisica 1");

    // Delete asks first, lists what would go from the real counts, and offers to archive instead.
    await settingsPage.getByRole("button", { name: "Delete", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Delete Fisica 1?" });
    await expect(confirm.getByRole("listitem")).toHaveText([
      "1 topic and the path",
      "1 flashcard and its reviews",
      "The mastery of each topic and the gaps found",
    ]);
    await expect(confirm.getByRole("button", { name: "Archive instead" })).toBeVisible();
    await animationsSettled(page);
    await snap("plan-settings-delete", "en", "dark");
    await expectNoAxeViolations(page);
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    expect(await read("plan-a")).not.toBeNull();
    // Sources are added from here with the same picker as the Sources tab.
    await settingsPage.getByRole("button", { name: "Add sources" }).click();
    const picker = page.getByRole("dialog", { name: "Add sources" });
    await expect(picker.getByRole("button", { name: "Attach selected sources" })).toBeDisabled();
    await picker.getByRole("button", { name: "Cancel" }).click();
    await expect(picker).toBeHidden();

    // Archive the other exam from its settings.
    await page.evaluate(() => {
      location.hash = "/plans/plan-b";
    });
    await page.getByRole("button", { name: "Exam settings" }).click();
    // An unsaved edit is not dropped without asking: the archive is done, then the page asks before leaving.
    await settingsPage.getByLabel("Exam name").fill("Analisi 2 bis");
    await settingsPage.getByRole("button", { name: "Archive", exact: true }).click();
    const leaveAfter = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect(leaveAfter).toContainText("You changed the name.");
    expect((await read("plan-b"))!.archivedAt).not.toBeNull();
    await leaveAfter.getByRole("button", { name: "Stay here" }).click();
    await expect(settingsPage.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
    await expect(settingsPage.getByLabel("Exam name")).toHaveValue("Analisi 2 bis");
    await saveBar.getByRole("button", { name: "Discard changes" }).click();
    await settingsPage.getByRole("link", { name: "Analisi 2" }).click();
    await expect(page).toHaveURL(/#\/plans\/plan-b$/);
    await expect(page.getByText("This exam is archived.")).toBeVisible();
    await snap("plan-archived", "en", "dark");

    // Exams page: Analisi 2 left the Active list, and the Archived filter brings it back.
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    await expect(page.getByRole("heading", { name: "Fisica 1" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Analisi 2" })).toHaveCount(0);
    await snap("exams-active", "en", "dark");
    await page.getByRole("combobox", { name: "Status" }).click();
    await page.getByTitle("Archived").click();
    await expect(page.getByRole("heading", { name: "Analisi 2" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fisica 1" })).toHaveCount(0);
    await snap("exams-archived", "en", "dark");
    await setLook("en", "light");
    await page.getByRole("combobox", { name: "Status" }).click();
    await page.getByTitle("Archived").click();
    await snap("exams-archived", "en", "light");

    // The flashcards of an archived exam are not listed, and none is due.
    await setLook("en", "dark");
    const due = await page.evaluate(() => window.pyxis.invoke("study.browse", { status: "due" }));
    expect(due.cards.map((card) => card.planId)).toEqual(["plan-a"]);

    // Restore from the plan page.
    await page.evaluate(() => {
      location.hash = "/plans/plan-b";
    });
    await page.getByRole("button", { name: "Restore exam" }).click();
    await expect(page.getByText("This exam is archived.")).toHaveCount(0);
    expect((await read("plan-b"))!.archivedAt).toBeNull();
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    await expect(page.getByRole("heading", { name: "Analisi 2" })).toBeVisible();
    // With nothing archived the filter is gone.
    await expect(page.getByRole("combobox", { name: "Status" })).toHaveCount(0);

    // Wizard, exam step: the name, the first day, then a second session with its own time and place.
    for (const theme of ["dark", "light"] as const) {
      await setLook("en", theme);
      await page.evaluate(() => {
        location.hash = "/plans/new";
      });
      await page.getByLabel("Exam name").fill("Chimica");
      await page.getByLabel("Exam date").fill(dmy(written));
      await page.keyboard.press("Enter");
      await page.getByLabel("Time (optional)").fill("10:00");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Add another session" }).click();
      await page.getByLabel("Date", { exact: true }).fill(dmy(oral));
      await page.keyboard.press("Enter");
      await page.getByLabel("Name (optional)").nth(1).fill("Oral");
      await expect(page.getByText("2 sessions, the first on")).toBeVisible();
      await snap("wizard-date", "en", theme);
    }

    // Italian at a narrow width: the fields stack, and nothing is cut off.
    await setLook("it", "dark");
    await page.setViewportSize({ width: 480, height: 900 });
    await page.evaluate(() => {
      location.hash = "/plans/plan-a";
    });
    await page.getByRole("button", { name: "Impostazioni dell'esame" }).click();
    await expect(settingsPage.getByRole("button", { name: "Aggiungi un'altra prova" })).toBeVisible();
    await snap("plan-settings-sessions-narrow", "it", "dark");
    await page.evaluate(() => {
      location.hash = "/plans/new";
    });
    await page.getByLabel("Nome dell'esame").fill("Chimica");
    await page.getByLabel("Data dell'esame").fill(dmy(written));
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Aggiungi un'altra prova" }).click();
    await snap("wizard-date-narrow", "it", "dark");
    await page.evaluate(() => window.pyxis.invoke("plans.archive", { planId: "plan-b", archived: true }));
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    await expect(page.getByRole("combobox", { name: "Stato" })).toBeVisible();
    await snap("exams-narrow", "it", "dark");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
