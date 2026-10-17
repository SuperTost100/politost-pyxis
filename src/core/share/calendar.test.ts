import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import {
  buildCalendar,
  escapeText,
  exportCalendar,
  foldLine,
  type CalendarExam,
} from "./calendar";

const originalTz = process.env["TZ"];
afterEach(() => {
  if (originalTz === undefined) delete process.env["TZ"];
  else process.env["TZ"] = originalTz;
});

/** Local noon on a calendar day, as the plan settings store it. */
function noon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12).getTime();
}

function exam(over: Partial<CalendarExam> = {}): CalendarExam {
  return {
    planId: "plan-1",
    title: "Fisica 1",
    subject: null,
    examAt: noon(2026, 11, 20),
    ...over,
  };
}

const NOW = Date.UTC(2026, 9, 13, 8, 30, 15);

/** Undo RFC 5545 folding, then split into content lines. */
function unfold(ics: string): string[] {
  expect(ics.endsWith("\r\n")).toBe(true);
  return ics
    .slice(0, -2)
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n");
}

describe("escapeText", () => {
  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeText("a\\b;c,d\ne\r\nf\rg")).toBe(
      "a\\\\b\\;c\\,d\\ne\\nf\\ng",
    );
  });

  it("drops control characters and lone surrogates", () => {
    expect(escapeText("a\u0000b\u0007c\u007fd\ud800e")).toBe("abcd\ufffde");
  });
});

describe("foldLine", () => {
  const octets = (s: string) => Buffer.byteLength(s, "utf8");

  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:Exam")).toBe("SUMMARY:Exam");
  });

  it("folds at 75 octets, counting the leading space of continuations", () => {
    const folded = foldLine("SUMMARY:" + "a".repeat(200));
    const lines = folded.split("\r\n");
    expect(lines[0]).toHaveLength(75);
    for (const line of lines.slice(1)) {
      expect(line.startsWith(" ")).toBe(true);
      expect(octets(line)).toBeLessThanOrEqual(75);
    }
    expect(lines.join("").replaceAll(" ", "")).toBe(
      "SUMMARY:" + "a".repeat(200),
    );
  });

  it.each([
    ["two-octet letters", "è"],
    ["three-octet CJK", "試"],
    ["four-octet emoji", "😀"],
    ["combining marks", "é"],
  ])("never splits a multi-byte character (%s)", (_name, unit) => {
    // Try every starting offset so each character boundary lands on the fold.
    for (let pad = 0; pad < 5; pad += 1) {
      const text = "x".repeat(pad) + unit.repeat(120);
      const line = "SUMMARY:" + text;
      const folded = foldLine(line);
      const lines = folded.split("\r\n");
      for (const part of lines) expect(octets(part)).toBeLessThanOrEqual(75);
      // Each piece must be valid UTF-8 on its own (no replacement characters).
      for (const part of lines) {
        const bytes = Buffer.from(part, "utf8");
        expect(bytes.toString("utf8")).toBe(part);
        expect(part).not.toContain("\ufffd");
      }
      expect(
        lines[0] +
          lines
            .slice(1)
            .map((l) => l.slice(1))
            .join(""),
      ).toBe(line);
    }
  });
});

describe("buildCalendar", () => {
  it("writes the calendar envelope with CRLF line endings", () => {
    const { ics, count } = buildCalendar([exam()], "en", NOW);
    expect(count).toBe(1);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const lines = unfold(ics);
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("CALSCALE:GREGORIAN");
    expect(lines).toContain("METHOD:PUBLISH");
    expect(lines.find((l) => l.startsWith("PRODID:"))).toMatch(
      /^PRODID:-\/\/PoliTost\/\/Pyxis\/\/(EN|IT)$/,
    );
  });

  it("writes one all-day event with a reminder at 9:00 the day before", () => {
    const lines = unfold(buildCalendar([exam()], "en", NOW).ics);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines).toContain("DTSTART;VALUE=DATE:20261120");
    expect(lines).toContain("DTEND;VALUE=DATE:20261121");
    expect(lines).toContain("DTSTAMP:20261013T083015Z");
    expect(lines).toContain("SUMMARY:Exam: Fisica 1");
    expect(lines).toContain("BEGIN:VALARM");
    expect(lines).toContain("ACTION:DISPLAY");
    expect(lines).toContain("TRIGGER:-PT15H");
    expect(lines).toContain("END:VALARM");
    const alarm = lines.slice(lines.indexOf("BEGIN:VALARM"));
    expect(alarm.some((l) => l.startsWith("DESCRIPTION:"))).toBe(true);
    // A reminder inside the event, not after it.
    expect(lines.indexOf("END:VALARM")).toBeLessThan(
      lines.indexOf("END:VEVENT"),
    );
  });

  it("uses Italian wording for an Italian interface", () => {
    const lines = unfold(
      buildCalendar([exam({ subject: "Fisica" })], "it", NOW).ics,
    );
    expect(lines).toContain("SUMMARY:Esame: Fisica 1");
    const description = lines.find((l) => l.startsWith("DESCRIPTION:Data"))!;
    expect(description).toContain("PoliTost Pyxis");
    expect(description).toContain("Materia: Fisica");
  });

  it("says where the event came from and names the subject in English", () => {
    const lines = unfold(
      buildCalendar([exam({ subject: "Physics" })], "en", NOW).ics,
    );
    const description = lines.find((l) => l.startsWith("DESCRIPTION:Exam"))!;
    expect(description).toContain("PoliTost Pyxis");
    expect(description).toContain("Subject: Physics");
    // The line break between the two sentences is escaped, not literal.
    expect(description).toContain("\\n");
  });

  it("skips exams with no date and exams that are over", () => {
    const { ics, count } = buildCalendar(
      [
        exam({ planId: "undated", examAt: null }),
        exam({ planId: "past", examAt: noon(2026, 10, 12) }),
        exam({ planId: "later", examAt: noon(2026, 12, 1) }),
      ],
      "en",
      NOW,
    );
    expect(count).toBe(1);
    expect(ics).toContain("UID:later@pyxis.politost.it");
    expect(ics).not.toContain("undated");
    expect(ics).not.toContain("UID:past@");
  });

  it("keeps an exam that is today, even after noon", () => {
    const evening = new Date(2026, 9, 13, 21, 0).getTime();
    const { count } = buildCalendar(
      [exam({ examAt: noon(2026, 10, 13) })],
      "en",
      evening,
    );
    expect(count).toBe(1);
  });

  it("returns an empty result when nothing is upcoming", () => {
    expect(buildCalendar([], "en", NOW)).toEqual({ ics: "", count: 0 });
    expect(buildCalendar([exam({ examAt: null })], "en", NOW)).toEqual({
      ics: "",
      count: 0,
    });
  });

  it("keeps the UID stable per plan so a re-import updates the event", () => {
    const first = unfold(buildCalendar([exam()], "en", NOW).ics);
    const moved = unfold(
      buildCalendar(
        [exam({ title: "Fisica 1 (orale)", examAt: noon(2026, 12, 2) })],
        "it",
        NOW + 86_400_000,
      ).ics,
    );
    const uid = (lines: string[]) => lines.find((l) => l.startsWith("UID:"));
    expect(uid(first)).toBe("UID:plan-1@pyxis.politost.it");
    expect(uid(moved)).toBe(uid(first));
  });

  it("gives each plan its own UID", () => {
    const { ics } = buildCalendar(
      [exam({ planId: "a" }), exam({ planId: "b" })],
      "en",
      NOW,
    );
    const uids = unfold(ics).filter((l) => l.startsWith("UID:"));
    expect(uids).toEqual([
      "UID:a@pyxis.politost.it",
      "UID:b@pyxis.politost.it",
    ]);
  });

  it("orders events by date", () => {
    const { ics } = buildCalendar(
      [
        exam({ planId: "b", examAt: noon(2026, 12, 1) }),
        exam({ planId: "a", examAt: noon(2026, 11, 1) }),
      ],
      "en",
      NOW,
    );
    expect(unfold(ics).filter((l) => l.startsWith("UID:"))[0]).toBe(
      "UID:a@pyxis.politost.it",
    );
  });

  it("escapes and folds a 200 character title in any script", () => {
    const title = "試験,;\\😀 è".repeat(22) + "試験";
    expect(title).toHaveLength(200);
    const { ics } = buildCalendar([exam({ title })], "en", NOW);
    for (const physical of ics.split("\r\n")) {
      expect(Buffer.byteLength(physical, "utf8")).toBeLessThanOrEqual(75);
    }
    const summary = unfold(ics).find((l) => l.startsWith("SUMMARY:"))!;
    expect(summary).toBe(`SUMMARY:Exam: ${escapeText(title)}`);
    // Decoding the escapes gives back the original title.
    expect(
      summary
        .slice("SUMMARY:Exam: ".length)
        .replace(/\\([\\;,n])/g, (_m, c: string) => (c === "n" ? "\n" : c)),
    ).toBe(title);
  });

  describe("sessions with a time and a place", () => {
    it("writes a 2 hour event with a floating local time and the place as LOCATION", () => {
      const lines = unfold(
        buildCalendar(
          [exam({ sessionId: "s1", time: "09:30", place: "Aula 5, Edificio A", label: "Written" })],
          "en",
          NOW,
        ).ics,
      );
      expect(lines).toContain("DTSTART:20261120T093000");
      expect(lines).toContain("DTEND:20261120T113000");
      expect(lines.some((l) => l.startsWith("DTSTART;VALUE=DATE"))).toBe(false);
      expect(lines).toContain("LOCATION:Aula 5\\, Edificio A");
      expect(lines).toContain("SUMMARY:Exam: Fisica 1 (Written)");
      expect(lines.find((l) => l.startsWith("DESCRIPTION:Exam date"))).toContain("Place: Aula 5");
    });

    it("keeps the 9:00 reminder the day before, whatever the start time", () => {
      const trigger = (time: string | null) =>
        unfold(buildCalendar([exam({ time })], "en", NOW).ics).find((l) => l.startsWith("TRIGGER:"));
      expect(trigger(null)).toBe("TRIGGER:-PT15H");
      expect(trigger("00:00")).toBe("TRIGGER:-PT15H");
      expect(trigger("09:00")).toBe("TRIGGER:-PT24H");
      expect(trigger("14:45")).toBe("TRIGGER:-PT29H45M");
    });

    it("rolls a late session into the next day", () => {
      const lines = unfold(buildCalendar([exam({ time: "23:00" })], "en", NOW).ics);
      expect(lines).toContain("DTSTART:20261120T230000");
      expect(lines).toContain("DTEND:20261121T010000");
    });

    it("writes no LOCATION for a session without a place, and no time for one without a time", () => {
      const lines = unfold(buildCalendar([exam({ place: "  " })], "en", NOW).ics);
      expect(lines.some((l) => l.startsWith("LOCATION"))).toBe(false);
      expect(lines).toContain("DTSTART;VALUE=DATE:20261120");
    });

    it("gives two sessions of one plan two events with their own stable UIDs, in time order", () => {
      const sessions = [
        exam({ sessionId: "oral", examAt: noon(2026, 11, 20), time: "14:00", label: "Oral" }),
        exam({ sessionId: "written", examAt: noon(2026, 11, 20), time: "09:00", label: "Written" }),
        exam({ sessionId: "later", examAt: noon(2026, 12, 2) }),
      ];
      const lines = unfold(buildCalendar(sessions, "en", NOW).ics);
      expect(lines.filter((l) => l.startsWith("UID:"))).toEqual([
        "UID:written@pyxis.politost.it",
        "UID:oral@pyxis.politost.it",
        "UID:later@pyxis.politost.it",
      ]);
      // Moving the oral part keeps its UID.
      const moved = unfold(
        buildCalendar([exam({ sessionId: "oral", examAt: noon(2026, 11, 25), time: "10:00" })], "en", NOW).ics,
      );
      expect(moved).toContain("UID:oral@pyxis.politost.it");
    });

    it("skips a session that is over and keeps one today", () => {
      const sessions = [
        exam({ sessionId: "past", examAt: noon(2026, 10, 12), time: "09:00" }),
        exam({ sessionId: "today", examAt: noon(2026, 10, 13), time: "08:00" }),
      ];
      const { ics, count } = buildCalendar(sessions, "en", NOW);
      expect(count).toBe(1);
      expect(ics).toContain("UID:today@");
    });
  });

  describe("calendar days", () => {
    it("uses the local date across a spring-forward change", () => {
      process.env["TZ"] = "Europe/Rome";
      // Clocks went forward on 2027-03-28; the day after is still day 29.
      const lines = unfold(
        buildCalendar([exam({ examAt: noon(2027, 3, 28) })], "en", NOW).ics,
      );
      expect(lines).toContain("DTSTART;VALUE=DATE:20270328");
      expect(lines).toContain("DTEND;VALUE=DATE:20270329");
    });

    it("uses the local date across a fall-back change and a month end", () => {
      process.env["TZ"] = "America/New_York";
      const fall = unfold(
        buildCalendar([exam({ examAt: noon(2026, 11, 1) })], "en", NOW).ics,
      );
      expect(fall).toContain("DTSTART;VALUE=DATE:20261101");
      expect(fall).toContain("DTEND;VALUE=DATE:20261102");
      const monthEnd = unfold(
        buildCalendar([exam({ examAt: noon(2026, 12, 31) })], "en", NOW).ics,
      );
      expect(monthEnd).toContain("DTSTART;VALUE=DATE:20261231");
      expect(monthEnd).toContain("DTEND;VALUE=DATE:20270101");
      const leap = unfold(
        buildCalendar([exam({ examAt: noon(2028, 2, 28) })], "en", NOW).ics,
      );
      expect(leap).toContain("DTEND;VALUE=DATE:20280229");
    });

    it("keeps the day for noon in a zone far from UTC", () => {
      // Local noon in Auckland (UTC+13 in summer) is 23:00 UTC the day before;
      // reading the UTC date would put the exam a day early.
      process.env["TZ"] = "Pacific/Auckland";
      const examAt = noon(2026, 12, 15);
      expect(new Date(examAt).getUTCDate()).toBe(14);
      const lines = unfold(buildCalendar([exam({ examAt })], "en", NOW).ics);
      expect(lines).toContain("DTSTART;VALUE=DATE:20261215");
      expect(lines).toContain("DTEND;VALUE=DATE:20261216");
    });

    it("keeps the day for noon on the far west side too", () => {
      process.env["TZ"] = "Pacific/Honolulu";
      const examAt = noon(2026, 12, 15);
      expect(new Date(examAt).getUTCDate()).toBe(15);
      const lines = unfold(buildCalendar([exam({ examAt })], "en", NOW).ics);
      expect(lines).toContain("DTSTART;VALUE=DATE:20261215");
    });

    it("decides past and upcoming by local day", () => {
      process.env["TZ"] = "Pacific/Auckland";
      // 23:30 on 14 Dec in Auckland is already 14 Dec there, 10:30 UTC.
      const now = new Date(2026, 11, 14, 23, 30).getTime();
      expect(
        buildCalendar([exam({ examAt: noon(2026, 12, 14) })], "en", now).count,
      ).toBe(1);
      expect(
        buildCalendar([exam({ examAt: noon(2026, 12, 13) })], "en", now).count,
      ).toBe(0);
    });
  });
});

describe("exportCalendar", () => {
  function fixture() {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO subjects (id, name, position, created_at) VALUES ('s1', 'Fisica', 0, 1)",
    ).run();
    // A plan's only session has the plan's id, as migration 19 gives an exam date the plan had before.
    const add = (
      id: string,
      title: string,
      examAt: number | null,
      subject: string | null = null,
    ) => {
      db.prepare(
        "INSERT INTO plans (id, title, status, subject_id, exam_at, created_at, updated_at) VALUES (?, ?, 'ready', ?, ?, 1, 1)",
      ).run(id, title, subject, examAt);
      if (examAt != null)
        db.prepare(
          "INSERT INTO plan_sessions (id, plan_id, date, created_at) VALUES (?, ?, ?, 1)",
        ).run(id, id, examAt);
    };
    return { db, add };
  }
  const decode = (base64: string) =>
    Buffer.from(base64, "base64").toString("utf8");

  it("exports one plan with its subject, and no other plan", () => {
    const { db, add } = fixture();
    add("a", "Analisi", noon(2026, 11, 3), "s1");
    add("b", "Chimica", noon(2026, 11, 20));
    const file = exportCalendar(db, { planId: "a", language: "it" }, NOW);
    expect(file.count).toBe(1);
    expect(file.filename).toBe("Analisi.ics");
    const lines = unfold(decode(file.base64));
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines).toContain("UID:a@pyxis.politost.it");
    expect(lines).toContain("SUMMARY:Esame: Analisi");
    expect(lines).toContain("DTSTART;VALUE=DATE:20261103");
    expect(lines.find((l) => l.startsWith("DESCRIPTION:Data"))).toContain(
      "Materia: Fisica",
    );
    expect(decode(file.base64)).not.toContain("Chimica");
  });

  it("exports one plan and names the file after it", () => {
    const { db, add } = fixture();
    add("a", 'Analisi/1: parte "A"', noon(2026, 11, 3));
    add("b", "Chimica", noon(2026, 11, 20));
    const file = exportCalendar(db, { planId: "a", language: "en" }, NOW);
    expect(file.count).toBe(1);
    expect(file.filename).toBe("Analisi 1 parte A.ics");
    expect(decode(file.base64)).not.toContain("Chimica");
  });

  it("keeps a long title's file name short", () => {
    const { db, add } = fixture();
    add("a", "試".repeat(200), noon(2026, 11, 3));
    const file = exportCalendar(db, { planId: "a", language: "en" }, NOW);
    expect(file.filename.endsWith(".ics")).toBe(true);
    expect(Buffer.byteLength(file.filename, "utf8")).toBeLessThanOrEqual(244);
  });

  it("returns nothing to save for a plan with no date or a past date", () => {
    const { db, add } = fixture();
    add("a", "Analisi", null);
    add("b", "Passato", noon(2026, 9, 1));
    for (const planId of ["a", "b"])
      expect(exportCalendar(db, { planId, language: "en" }, NOW)).toMatchObject(
        { count: 0, base64: "" },
      );
  });

  it("names an untitled plan's file with the fallback word", () => {
    const { db, add } = fixture();
    add("a", ' / : * ? " ', noon(2026, 11, 3));
    expect(
      exportCalendar(db, { planId: "a", language: "it" }, NOW).filename,
    ).toBe("esame.ics");
    expect(
      exportCalendar(db, { planId: "a", language: "en" }, NOW).filename,
    ).toBe("exam.ics");
  });

  it("exports every session of a plan with its time and place", () => {
    const { db, add } = fixture();
    add("a", "Analisi", noon(2026, 11, 3));
    db.prepare("UPDATE plan_sessions SET time = '09:00', place = 'Aula 2', label = 'Scritto' WHERE id = 'a'").run();
    db.prepare(
      "INSERT INTO plan_sessions (id, plan_id, date, time, place, label, created_at) VALUES ('a-orale', 'a', ?, '15:30', 'Studio 14', 'Orale', 2)",
    ).run(noon(2026, 11, 17));
    const lines = unfold(decode(exportCalendar(db, { planId: "a", language: "it" }, NOW).base64));
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(2);
    // The first session keeps the plan's id, so the event a student added before sessions existed is updated.
    expect(lines).toContain("UID:a@pyxis.politost.it");
    expect(lines).toContain("UID:a-orale@pyxis.politost.it");
    expect(lines).toContain("DTSTART:20261103T090000");
    expect(lines).toContain("DTSTART:20261117T153000");
    expect(lines).toContain("LOCATION:Studio 14");
    expect(lines).toContain("SUMMARY:Esame: Analisi (Orale)");
  });

  it("rejects a plan that does not exist", () => {
    const { db } = fixture();
    expect(() =>
      exportCalendar(db, { planId: "nope", language: "en" }, NOW),
    ).toThrow("plan-missing");
  });
});
