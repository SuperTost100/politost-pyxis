import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReminderSummary } from "../shared/reminder";
import {
  dayKey,
  initialReminders,
  readReminderState,
  reminderDue,
  StudyReminders,
  writeReminderState,
  type ReminderState,
} from "./reminders";

const roots: string[] = [];
function stateFile(): string {
  const root = mkdtempSync(join(tmpdir(), "pyxis-reminders-"));
  roots.push(root);
  return join(root, "reminders.json");
}
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const summary: ReminderSummary = {
  dueCards: 12,
  planId: "p1",
  planTitle: "Analisi",
  daysToExam: 3,
};
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute, 0);

describe("saved settings", () => {
  it("default to off at 18:00 and survive a damaged file", () => {
    const file = stateFile();
    expect(readReminderState(file)).toEqual(initialReminders);
    expect(initialReminders.enabled).toBe(false);
    writeFileSync(file, "{ not json");
    expect(readReminderState(file)).toEqual(initialReminders);
    writeFileSync(
      file,
      JSON.stringify({ enabled: "yes", time: "25:00", lastDay: "today" }),
    );
    expect(readReminderState(file)).toEqual(initialReminders);
    writeReminderState(file, {
      enabled: true,
      time: "07:30",
      lastDay: "2026-10-13",
    });
    expect(readReminderState(file)).toEqual({
      enabled: true,
      time: "07:30",
      lastDay: "2026-10-13",
    });
  });
});

describe("reminderDue", () => {
  const on: ReminderState = { enabled: true, time: "18:00", lastDay: null };
  it("is due from the chosen time for an hour, once a day", () => {
    expect(reminderDue(on, at(13, 17, 59))).toBe(false);
    expect(reminderDue(on, at(13, 18, 0))).toBe(true);
    expect(reminderDue(on, at(13, 18, 59))).toBe(true);
    expect(reminderDue(on, at(13, 19, 0))).toBe(false);
    expect(
      reminderDue({ ...on, lastDay: dayKey(at(13, 12)) }, at(13, 18, 30)),
    ).toBe(false);
    expect(
      reminderDue({ ...on, lastDay: dayKey(at(13, 12)) }, at(14, 18, 30)),
    ).toBe(true);
  });

  it("is never due while off", () => {
    expect(reminderDue({ ...on, enabled: false }, at(13, 18, 30))).toBe(false);
  });
});

describe("StudyReminders", () => {
  function setup(
    options: {
      answers?: Array<{ summary: ReminderSummary | null } | null>;
    } = {},
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(at(13, 17, 58));
    const answers = [...(options.answers ?? [])];
    const shown: ReminderSummary[] = [];
    let busy = false;
    const query = vi.fn(async () =>
      answers.length ? answers.shift()! : { summary },
    );
    const reminders = new StudyReminders({
      stateFile: stateFile(),
      query,
      show: (value) => shown.push(value),
      busy: () => busy,
    });
    return {
      reminders,
      shown,
      query,
      setBusy: (value: boolean) => {
        busy = value;
      },
    };
  }
  const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * 60_000);

  it("is off by default and never sends anything", async () => {
    const t = setup();
    expect(t.reminders.get()).toEqual({ enabled: false, time: "18:00" });
    t.reminders.start();
    await minutes(24 * 60);
    expect(t.query).not.toHaveBeenCalled();
    expect(t.shown).toEqual([]);
  });

  it("sends one reminder at the chosen time, then waits for the next day", async () => {
    const t = setup();
    t.reminders.set({ enabled: true, time: "18:00" });
    t.reminders.start();
    await minutes(1);
    expect(t.shown).toEqual([]);
    await minutes(1);
    expect(t.shown).toEqual([summary]);
    // The rest of the day, and the grace hour, stay quiet.
    await minutes(5 * 60);
    expect(t.shown).toHaveLength(1);
    // Tomorrow at 18:00.
    await minutes(24 * 60 - 5 * 60);
    expect(t.shown).toHaveLength(2);
    t.reminders.dispose();
  });

  it("uses the time the student picked", async () => {
    const t = setup();
    t.reminders.set({ enabled: true, time: "21:15" });
    t.reminders.start();
    await minutes(3 * 60 + 16);
    expect(t.shown).toEqual([]);
    await minutes(1);
    expect(t.shown).toHaveLength(1);
    t.reminders.dispose();
  });

  it("waits for tomorrow when switched on after the time has passed today", async () => {
    const t = setup();
    vi.setSystemTime(at(13, 18, 20));
    t.reminders.set({ enabled: true, time: "18:00" });
    t.reminders.start();
    await minutes(10);
    expect(t.shown).toEqual([]);
    await minutes(24 * 60);
    expect(t.shown).toHaveLength(1);
    t.reminders.dispose();
  });

  it("does not repeat a day's reminder after a restart", async () => {
    const t = setup();
    t.reminders.set({ enabled: true, time: "18:00" });
    t.reminders.start();
    await minutes(2);
    expect(t.shown).toHaveLength(1);
    t.reminders.dispose();
    const again = new StudyReminders({
      stateFile: (t.reminders as unknown as { deps: { stateFile: string } })
        .deps.stateFile,
      query: async () => ({ summary }),
      show: (value) => t.shown.push(value),
      busy: () => false,
    });
    again.start();
    await minutes(10);
    expect(t.shown).toHaveLength(1);
    again.dispose();
  });

  it("stays quiet with no cards due, and asks only once that day", async () => {
    const t = setup({ answers: [{ summary: null }] });
    t.reminders.set({ enabled: true, time: "18:00" });
    t.reminders.start();
    await minutes(30);
    expect(t.query).toHaveBeenCalledTimes(1);
    expect(t.shown).toEqual([]);
    t.reminders.dispose();
  });

  it("asks again a minute later when core could not answer", async () => {
    const t = setup({ answers: [null, null] });
    t.reminders.set({ enabled: true, time: "18:00" });
    t.reminders.start();
    await minutes(2);
    expect(t.query).toHaveBeenCalledTimes(1);
    expect(t.shown).toEqual([]);
    await minutes(2);
    expect(t.query).toHaveBeenCalledTimes(3);
    expect(t.shown).toEqual([summary]);
    t.reminders.dispose();
  });

  it("does not ask while a restore, move or wipe holds the workspace, and sends once it is free", async () => {
    const t = setup();
    t.reminders.set({ enabled: true, time: "18:00" });
    t.setBusy(true);
    t.reminders.start();
    await minutes(10);
    expect(t.query).not.toHaveBeenCalled();
    t.setBusy(false);
    await minutes(1);
    expect(t.shown).toHaveLength(1);
    t.reminders.dispose();
  });

  it("stops sending once switched off, and after dispose", async () => {
    const t = setup();
    t.reminders.set({ enabled: true, time: "18:00" });
    t.reminders.start();
    t.reminders.set({ enabled: false, time: "18:00" });
    await minutes(5);
    expect(t.shown).toEqual([]);
    t.reminders.set({ enabled: true, time: "18:10" });
    t.reminders.dispose();
    await minutes(60);
    expect(t.shown).toEqual([]);
  });

  it("refuses a switch or time it cannot read", () => {
    const t = setup();
    expect(() => t.reminders.set({ enabled: true, time: "6pm" })).toThrow(
      "invalid-setting",
    );
    expect(() =>
      t.reminders.set({ enabled: "yes" as unknown as boolean, time: "18:00" }),
    ).toThrow("invalid-setting");
    expect(t.reminders.get().enabled).toBe(false);
  });
});
