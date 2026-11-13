import type { RequestOutput } from "../../../../shared/ipc";
import { stepPath } from "./reopen";

type T = (key: string, options?: Record<string, unknown>) => string;
type Next = NonNullable<NonNullable<RequestOutput<"plans.recommend">>["next"]>;
export type NextPart = NonNullable<Next["part"]>;
export type Outline = NonNullable<RequestOutput<"study.parts">["outline"]>;

/** Where a part of a topic's lesson opens: the lesson step's page at that part. */
export function partPath(planId: string, topicId: string, position: number): string {
  return `${stepPath(planId, "lesson", topicId)}?part=${position}`;
}

/** Midnight of the day `at` falls on, in local time. */
function dayStart(at: number): number {
  return new Date(at).setHours(0, 0, 0, 0);
}

/**
 * When the student finished the part they pick up after, for "ieri hai finito la parte 3": yesterday, a weekday within
 * the last week, or the date. Core sets `resumeFrom` only for a day before today.
 */
export function resumeWhen(t: T, at: number, now: number, language: string): string {
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  if (days <= 1) return t("examPage.resumeWhen.yesterday");
  if (days < 7)
    return t("examPage.resumeWhen.weekday", {
      day: new Intl.DateTimeFormat(language, { weekday: "long" }).format(at),
    });
  return t("examPage.resumeWhen.date", {
    date: new Intl.DateTimeFormat(language, { day: "numeric", month: "long" }).format(at),
  });
}

/**
 * The suggested part's title and the line under it on the exam page. Under "Riprendi da" the title carries the part's
 * number, since the line no longer does; the recap is named as such and has no number. A topic of one part has none of
 * this, as its page has no "Parte 1 di 1": null, and the card names the lesson as it does for a topic without parts.
 */
export function nowPartText(
  t: T,
  input: { part: NextPart; topic: string; now: number; language: string },
): { title: string; line: string } | null {
  const { part, topic } = input;
  if (part.count < 2 && part.kind === "part") return null;
  const recap = part.kind === "recap";
  const resume = part.resumeFrom;
  const title = recap
    ? t("lesson.recapTitle")
    : resume
      ? t("examPage.partTitle", { n: part.position, title: part.title })
      : part.title;
  const line = resume
    ? t("examPage.resumeLine", {
        topic,
        count: part.minutes,
        n: resume.position,
        when: resumeWhen(t, resume.at, input.now, input.language),
      })
    : recap
      ? t("examPage.recapLine", { topic, count: part.minutes })
      : t("examPage.partLine", { n: part.position, parts: part.count, topic, count: part.minutes });
  return { title, line };
}

/**
 * The open topic's line on the path while its lesson in parts is under way: "2 parti su 8 lette · circa 43 minuti alla
 * fine". Null once every part is done, or when the topic is one part, where the path's usual line stays.
 */
export function partsLine(t: T, outline: Outline): string | null {
  if (outline.parts.length < 2 || outline.parts.every((part) => part.done)) return null;
  return [
    t("plans.path.partsRead", { count: outline.done, total: outline.teaching }),
    t("plans.path.partsLeft", { count: outline.minutesLeft }),
  ].join(" · ");
}

/** "Lezione in 8 parti e un ripasso", over the part rows. */
export function partsHeading(t: T, outline: Outline): string {
  const recap = outline.parts.some((part) => part.kind === "recap");
  return t(recap ? "plans.path.lessonPartsRecap" : "plans.path.lessonParts", { count: outline.teaching });
}
