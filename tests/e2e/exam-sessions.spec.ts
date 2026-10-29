import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan } from "./seed";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";

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
    seedPlan(db, { id: "plan-a", title: "Fisica 1", language: "it", topics: [{ id: "topic-a", title: "Cinematica" }] });
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
    const dialog = page.getByRole("dialog", { name: "Exam settings" });
    await dialog.getByLabel("Exam date").fill(dmy(written));
    await page.keyboard.press("Enter");
    await dialog.getByLabel("Time (optional)").fill("09:30");
    await page.keyboard.press("Enter");
    await dialog.getByLabel("Name (optional)").fill("Written");
    await dialog.getByLabel("Place (optional)").fill("Aula 5");
    await dialog.getByRole("button", { name: "Add another session" }).click();
    await dialog.getByLabel("Date", { exact: true }).fill(dmy(oral));
    await page.keyboard.press("Enter");
    await dialog.getByLabel("Time (optional)").nth(1).fill("14:00");
    await page.keyboard.press("Enter");
    await dialog.getByLabel("Name (optional)").nth(1).fill("Oral");
    await dialog.getByLabel("Place (optional)").nth(1).fill("Studio 14");
    // The calendar button waits for the sessions to be saved.
    await expect(dialog.getByRole("button", { name: "Add to calendar" })).toBeDisabled();
    await snap("plan-settings-sessions", "en", "light");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();

    const plan = await read("plan-a");
    expect(plan!.sessions.map((s) => [s.label, s.time, s.place])).toEqual([
      ["Written", "09:30", "Aula 5"],
      ["Oral", "14:00", "Studio 14"],
    ]);
    expect(plan!.examAt).toBe(written.getTime());
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
    await snap("plan-settings-sessions", "en", "dark");
    await expectNoAxeViolations(page);

    // Remove the second session again: one session left, no frame around it.
    await dialog.getByRole("button", { name: "Remove session 2" }).click();
    await expect(dialog.getByRole("button", { name: /^Remove session/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Archive the other exam from its settings.
    await page.evaluate(() => {
      location.hash = "/plans/plan-b";
    });
    await page.getByRole("button", { name: "Exam settings" }).click();
    await dialog.getByRole("button", { name: "Archive exam" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("This exam is archived.")).toBeVisible();
    expect((await read("plan-b"))!.archivedAt).not.toBeNull();
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
    const settings = page.getByRole("dialog", { name: "Impostazioni dell'esame" });
    await expect(settings.getByRole("button", { name: "Aggiungi un'altra prova" })).toBeVisible();
    await snap("plan-settings-sessions-narrow", "it", "dark");
    await settings.getByRole("button", { name: "Annulla" }).click().catch(() => page.keyboard.press("Escape"));
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
