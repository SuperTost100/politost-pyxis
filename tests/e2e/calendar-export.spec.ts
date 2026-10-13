import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

test("CAL-01 exam dates export to an .ics file from Exams and from one plan", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-calendar-check-"));
  mkdirSync(".shots", { recursive: true });
  const saved = join(userData, "exams.ics");
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_SAVE: saved,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Salta" }).click();
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10000,
    });
    const insert = db.prepare(
      "INSERT INTO plans (id,title,status,exam_at,created_at,updated_at) VALUES (?,?,'ready',?,1,1)",
    );
    const near = noonIn(10);
    const far = noonIn(35);
    // The title holds every character that TEXT has to escape, plus non-Latin text.
    const hard = "Chimica, parte 2; \\ 試験 😀 " + "x".repeat(150);
    insert.run("plan-undated", "Senza data", null);
    insert.run("plan-past", "Esame passato", noonIn(-5).getTime());

    const calendarButton = () =>
      page.getByRole("button", {
        name: /^(Aggiungi al calendario|Add to calendar)$/,
      });
    const toast = (text: RegExp) => page.getByText(text).first();
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

    // Nothing upcoming: the button is off and says why.
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    await page.reload();
    await expect(calendarButton()).toBeDisabled();
    await calendarButton().locator("xpath=..").hover();
    await expect(
      page.getByRole("tooltip").getByText(/Nessun esame in arrivo/),
    ).toBeVisible();

    insert.run("plan-near", "Analisi 1", near.getTime());
    insert.run("plan-far", hard, far.getTime());
    db.close();
    await page.reload();
    await expect(calendarButton()).toBeEnabled();

    // Exams page, Italian: every upcoming dated plan, none of the others.
    rmSync(saved, { force: true });
    await calendarButton().click();
    await expect(toast(/File del calendario salvato/)).toBeVisible();
    let ics = await exported();
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    for (const line of ics.split("\r\n"))
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    let lines = unfold(ics);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(2);
    expect(lines).toContain("UID:plan-near@pyxis.politost.it");
    expect(lines).toContain("UID:plan-far@pyxis.politost.it");
    expect(ics).not.toContain("plan-undated");
    expect(ics).not.toContain("plan-past");
    expect(lines).toContain(`DTSTART;VALUE=DATE:${ymd(near)}`);
    expect(lines).toContain(`DTEND;VALUE=DATE:${ymd(near, 1)}`);
    expect(lines).toContain(`DTSTART;VALUE=DATE:${ymd(far)}`);
    expect(lines).toContain("SUMMARY:Esame: Analisi 1");
    expect(lines).toContain(
      "SUMMARY:Esame: " +
        hard
          .replaceAll("\\", "\\\\")
          .replaceAll(",", "\\,")
          .replaceAll(";", "\\;"),
    );
    expect(lines.filter((l) => l === "TRIGGER:-PT15H")).toHaveLength(2);
    expect(lines.filter((l) => l === "ACTION:DISPLAY")).toHaveLength(2);

    // Saving again from the same plans keeps the same UIDs, so an import updates them.
    const uids = lines.filter((l) => l.startsWith("UID:"));
    rmSync(saved, { force: true });
    await calendarButton().click();
    ics = await exported();
    expect(unfold(ics).filter((l) => l.startsWith("UID:"))).toEqual(uids);

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
      await page.reload();
      await page.setViewportSize({ width: 960, height: 700 });
      await expect(calendarButton()).toBeEnabled();
      const audit = await new AxeBuilder({ page }).setLegacyMode().analyze();
      expect(audit.violations).toEqual([]);
      await page.screenshot({
        path: `.shots/calendar-exams-${language}-${theme}.png`,
      });
    }

    // One plan, English: only that exam, and the summary follows the interface language.
    await page.evaluate(() => {
      location.hash = "/plans/plan-near";
    });
    await page
      .getByRole("button", { name: /^(Impostazioni del piano|Plan settings)$/ })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(calendarButton()).toBeEnabled();
    await page.screenshot({
      path: ".shots/calendar-plan-settings-en-light.png",
    });
    rmSync(saved, { force: true });
    await calendarButton().click();
    await expect(
      dialog.getByRole("button", { name: "Add to calendar" }),
    ).toBeEnabled();
    await expect(toast(/Calendar file saved/)).toBeVisible();
    lines = unfold(await exported());
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines).toContain("UID:plan-near@pyxis.politost.it");
    expect(lines).toContain("SUMMARY:Exam: Analisi 1");
    expect(lines).toContain(`DTSTART;VALUE=DATE:${ymd(near)}`);

    // A plan with no date cannot be exported.
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      location.hash = "/plans/plan-undated";
    });
    await page.getByRole("button", { name: "Plan settings" }).click();
    await expect(calendarButton()).toBeDisabled();
    await calendarButton().locator("xpath=..").hover();
    await expect(
      page.getByRole("tooltip").getByText(/has no date yet/),
    ).toBeVisible();

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
