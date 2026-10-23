import { expect, test } from "@playwright/test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
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
function ymd(date: Date, plusDays = 0): string {
  const d = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + plusDays,
  );
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").split("\r\n");
}

test("CAL-01 one exam's date exports to an .ics file from the plan header and from plan settings", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-calendar-check-"));
  const saved = join(userData, "exams.ics");
  const env = {
    PYXIS_E2E_SAVE: saved,
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Exams; wait so a reload or route change cannot land on setup.
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10000,
    });
    // A plan's only session has the plan's id, as migration 19 gives it to an exam date the plan already had.
    const insertSession = db.prepare(
      "INSERT INTO plan_sessions (id,plan_id,date,created_at) VALUES (?,?,?,1)",
    );
    const insert = {
      run(id: string, title: string, examAt: number | null) {
        seedPlan(db, { id, title, examAt });
        if (examAt !== null) insertSession.run(id, id, examAt);
      },
    };
    const near = noonIn(10);
    const far = noonIn(35);
    // The title holds every character that TEXT has to escape, plus non-Latin text.
    const hard = "Chimica, parte 2; \\ 試験 😀 " + "x".repeat(150);
    insert.run("plan-undated", "Senza data", null);
    insert.run("plan-past", "Esame passato", noonIn(-5).getTime());
    insert.run("plan-near", "Analisi 1", near.getTime());
    insert.run("plan-far", hard, far.getTime());
    db.close();

    const calendarName = /^(Aggiungi al calendario|Add to calendar)$/;
    const header = page.locator(".px-plan-header-actions");
    const headerButton = () =>
      header.getByRole("button", { name: calendarName });
    const toast = (text: RegExp) => page.getByText(text).first();
    const open = async (planId: string) => {
      await page.evaluate((planId) => {
        location.hash = `/plans/${planId}`;
      }, planId);
      await expect(
        header.getByRole("button", {
          name: /^(Impostazioni del piano|Plan settings)$/,
        }),
      ).toBeVisible();
    };
    // The saved file, once it is complete. Each export starts from no file, so a toast left from the previous export
    // can't let the test read a file that is still being written.
    const exported = async () => {
      await expect
        .poll(
          () =>
            existsSync(saved) &&
            readFileSync(saved, "utf8").endsWith("END:VCALENDAR\r\n"),
        )
        .toBe(true);
      return readFileSync(saved, "utf8");
    };

    // Exams exports no calendar of every exam any more.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Analisi 1" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: calendarName })).toHaveCount(
      0,
    );

    // A plan with no date, or with a date that has passed, has no header button.
    for (const planId of ["plan-undated", "plan-past"]) {
      await open(planId);
      await expect(headerButton()).toHaveCount(0);
    }

    // Plan header, Italian: only this exam.
    await open("plan-far");
    rmSync(saved, { force: true });
    await headerButton().click();
    await expect(toast(/File del calendario salvato/)).toBeVisible();
    let ics = await exported();
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    for (const line of ics.split("\r\n"))
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    let lines = unfold(ics);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines).toContain("UID:plan-far@pyxis.politost.it");
    expect(ics).not.toContain("plan-near");
    expect(lines).toContain(`DTSTART;VALUE=DATE:${ymd(far)}`);
    expect(lines).toContain(`DTEND;VALUE=DATE:${ymd(far, 1)}`);
    expect(lines).toContain(
      "SUMMARY:Esame: " +
        hard
          .replaceAll("\\", "\\\\")
          .replaceAll(",", "\\,")
          .replaceAll(";", "\\;"),
    );
    expect(lines).toContain("TRIGGER:-PT15H");
    expect(lines).toContain("ACTION:DISPLAY");

    // Saving again keeps the same UID, so an import updates the event.
    rmSync(saved, { force: true });
    await headerButton().click();
    ics = await exported();
    expect(unfold(ics).filter((l) => l.startsWith("UID:"))).toEqual([
      "UID:plan-far@pyxis.politost.it",
    ]);

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
      await page.setViewportSize({ width: 960, height: 700 });
      await page.reload();
      await expect(headerButton()).toBeEnabled();
      await expectNoAxeViolations(page);
      await saveShot(page, `calendar-plan-header-${language}-${theme}.png`);
    }

    // Plan settings, English: only that exam, and the summary follows the interface language.
    await open("plan-near");
    await header
      .getByRole("button", { name: /^(Impostazioni del piano|Plan settings)$/ })
      .click();
    const dialog = page.getByRole("dialog");
    const settingsButton = () =>
      dialog.getByRole("button", { name: calendarName });
    await expect(settingsButton()).toBeEnabled();
    await saveShot(page, "calendar-plan-settings-en-light.png");
    rmSync(saved, { force: true });
    await settingsButton().click();
    await expect(settingsButton()).toBeEnabled();
    await expect(toast(/Calendar file saved/)).toBeVisible();
    lines = unfold(await exported());
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines).toContain("UID:plan-near@pyxis.politost.it");
    expect(lines).toContain("SUMMARY:Exam: Analisi 1");
    expect(lines).toContain(`DTSTART;VALUE=DATE:${ymd(near)}`);

    // A plan with no date cannot be exported.
    await page.keyboard.press("Escape");
    await open("plan-undated");
    await header.getByRole("button", { name: "Plan settings" }).click();
    await expect(settingsButton()).toBeDisabled();
    await settingsButton().locator("xpath=..").hover();
    await expect(
      page.getByRole("tooltip").getByText(/has no date yet/),
    ).toBeVisible();

    // Core refuses a request without a plan.
    await expect(
      page.evaluate(() =>
        window.pyxis.invoke("plans.calendar", { language: "en" } as never),
      ),
    ).rejects.toThrow();

    // The main process refuses an unknown extension and still accepts .ics.
    await expect(
      page.evaluate(() =>
        window.pyxis.saveArtifact({ filename: "x.ical", base64: "YQ==" }),
      ),
    ).rejects.toThrow();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
