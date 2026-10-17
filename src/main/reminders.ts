import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ReminderSettings } from "../shared/bridge";
import {
  DEFAULT_REMINDER_TIME,
  isReminderTime,
  type ReminderSummary,
} from "../shared/reminder";

const MINUTE = 60 * 1000;
/** A reminder is still sent this long after its time (the computer was asleep or Pyxis was just opened); later it waits for tomorrow. */
export const REMINDER_GRACE = 60 * MINUTE;

export type ReminderState = ReminderSettings & {
  /** The local date ("YYYY-MM-DD") the reminder last ran, whether or not it sent anything. */
  lastDay: string | null;
};

export const initialReminders: ReminderState = {
  enabled: false,
  time: DEFAULT_REMINDER_TIME,
  lastDay: null,
};

/** Reads the saved settings. A missing or damaged file gives the defaults: off, 18:00. */
export function readReminderState(file: string): ReminderState {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { ...initialReminders };
    return {
      enabled: raw.enabled === true,
      time: isReminderTime(raw.time) ? raw.time : DEFAULT_REMINDER_TIME,
      lastDay:
        typeof raw.lastDay === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(raw.lastDay)
          ? raw.lastDay
          : null,
    };
  } catch {
    return { ...initialReminders };
  }
}

export function writeReminderState(file: string, state: ReminderState): void {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2));
  renameSync(temporary, file);
}

const two = (n: number) => String(n).padStart(2, "0");
export const dayKey = (at: Date) =>
  `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;

/** Minutes after midnight of an "HH:MM" time. */
const minutes = (time: string) =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const minutesOf = (at: Date) => at.getHours() * 60 + at.getMinutes();

/** On, not yet run today, past the chosen time, and no more than REMINDER_GRACE past it. */
export function reminderDue(state: ReminderState, at: Date): boolean {
  if (!state.enabled || state.lastDay === dayKey(at)) return false;
  const late = minutesOf(at) - minutes(state.time);
  return late >= 0 && late * MINUTE < REMINDER_GRACE;
}

export type ReminderDeps = {
  stateFile: string;
  /** Asks core for the cards due now. null: core could not answer (not open, restoring), so the check runs again. */
  query: () => Promise<{ summary: ReminderSummary | null } | null>;
  show: (summary: ReminderSummary) => void;
  /** A manual backup, restore, move or wipe holds the workspace. */
  busy: () => boolean;
  now?: () => Date;
  log?: (message: string) => void;
};

/**
 * One study reminder a day while Pyxis runs, at the time the student picked, if flashcards are due. Off by default. A
 * check every minute compares the clock with the saved time, so a computer that slept through it still sends it when it
 * wakes, within REMINDER_GRACE. Nothing runs while Pyxis is closed.
 */
export class StudyReminders {
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private readonly now: () => Date;

  constructor(private readonly deps: ReminderDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private state(): ReminderState {
    return readReminderState(this.deps.stateFile);
  }

  get(): ReminderSettings {
    const { enabled, time } = this.state();
    return { enabled, time };
  }

  /**
   * Saves the switch and the time. Turning it on, or picking a time that has already passed today, waits for tomorrow:
   * a notification the moment the switch flips would be a surprise, not a reminder.
   */
  set(settings: ReminderSettings): ReminderSettings {
    if (typeof settings.enabled !== "boolean" || !isReminderTime(settings.time))
      throw new Error("invalid-setting");
    const state = this.state();
    const at = this.now();
    const changed =
      settings.enabled !== state.enabled || settings.time !== state.time;
    writeReminderState(this.deps.stateFile, {
      enabled: settings.enabled,
      time: settings.time,
      lastDay:
        changed && minutesOf(at) >= minutes(settings.time)
          ? dayKey(at)
          : state.lastDay,
    });
    return this.get();
  }

  start(every = MINUTE): void {
    this.timer = setInterval(() => void this.check(), every);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<
    "off" | "not-due" | "busy" | "unknown" | "nothing" | "sent"
  > {
    if (this.checking) return "busy";
    const state = this.state();
    if (!state.enabled) return "off";
    const at = this.now();
    if (!reminderDue(state, at)) return "not-due";
    if (this.deps.busy()) return "busy";
    this.checking = true;
    try {
      const answer = await this.deps.query();
      if (!answer) return "unknown";
      // Today is done either way: with nothing due there is nothing to say, and asking again every minute would not change that.
      writeReminderState(this.deps.stateFile, {
        ...this.state(),
        lastDay: dayKey(at),
      });
      if (!answer.summary) return "nothing";
      this.deps.show(answer.summary);
      return "sent";
    } catch (error) {
      this.deps.log?.(
        `pyxis: study reminder failed (${error instanceof Error ? error.message : "unknown"})`,
      );
      return "unknown";
    } finally {
      this.checking = false;
    }
  }
}
