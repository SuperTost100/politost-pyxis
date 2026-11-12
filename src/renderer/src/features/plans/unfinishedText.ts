import type { RequestOutput } from "../../../../shared/ipc";

export type UnfinishedEntry = RequestOutput<"plans.unfinished">[number];
type T = (key: string, options?: Record<string, unknown>) => string;

/** Where Riprendi goes: the page that already resumes this kind, at its attempt. */
export function resumePath(planId: string, entry: UnfinishedEntry): string {
  const base = `/plans/${planId}`;
  const attempt = entry.attemptId
    ? `?attempt=${encodeURIComponent(entry.attemptId)}`
    : "";
  switch (entry.kind) {
    case "diagnostic":
      return `${base}/diagnostic${attempt}`;
    case "redo":
      return `${base}/redo${attempt}`;
    case "past":
      return `${base}/past${attempt}`;
    case "review":
      return `${base}/review`;
    case "simulation":
      return entry.attemptId
        ? `${base}/exam/${entry.attemptId}`
        : `${base}/simulation`;
    default:
      return entry.routeTopicId
        ? `${base}/quiz/${entry.routeTopicId}${attempt}`
        : base;
  }
}

/** "Quiz su Limiti", "Simulazione d'esame": what the entry is, with its topic when it has one. */
export function unfinishedTitle(entry: UnfinishedEntry, t: T): string {
  const topic = entry.topicTitle;
  switch (entry.kind) {
    case "quiz":
      return topic
        ? t("examPage.unfinished.quizOn", { topic })
        : t("quiz.title");
    case "drill":
      return topic
        ? t("examPage.reviewTopic", { topic })
        : t("examPage.unfinished.drill");
    case "diagnostic":
      return t("plans.path.activity.diagnostic");
    case "redo":
      return t("examPage.unfinished.redo");
    case "past":
      return t("pastPapers.practiceTitle");
    case "review":
      return t("cards.reviewTitle");
    default:
      return t("plans.path.activity.simulation");
  }
}

/**
 * When it was started, in the words of a person: "oggi alle 18:40", "ieri alle 9:05", a weekday within the week, or the
 * date.
 */
export function startedWhen(
  at: number,
  now: number,
  language: string,
  t: T,
): string {
  const day = (value: number) => new Date(value).setHours(0, 0, 0, 0);
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  const time = new Intl.DateTimeFormat(language, {
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  if (days <= 0) return t("examPage.unfinished.today", { time });
  if (days === 1) return t("examPage.unfinished.yesterday", { time });
  if (days < 7)
    return new Intl.DateTimeFormat(language, { weekday: "long" }).format(at);
  return new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "long",
  }).format(at);
}

/** "3 di 8 domande · ieri alle 18:40": how far it got, or what state it is in, and when it was started. */
export function unfinishedDetail(
  entry: UnfinishedEntry,
  now: number,
  language: string,
  t: T,
): string {
  const state =
    entry.state === "writing"
      ? t("examPage.unfinished.writing")
      : entry.state === "stopped"
        ? t("examPage.unfinished.stopped")
        : entry.state === "ready"
          ? t("examPage.unfinished.ready")
          : entry.state === "expired"
            ? t("examPage.unfinished.expired")
            : entry.kind === "review"
              ? t("examPage.unfinished.reviewProgress", {
                  answered: entry.answered,
                  count: entry.total,
                })
              : t("examPage.unfinished.progress", {
                  answered: entry.answered,
                  count: entry.total,
                });
  return `${state} · ${startedWhen(entry.startedAt, now, language, t)}`;
}

/** What Elimina loses and what stays, for its confirmation. */
export function deleteBody(entry: UnfinishedEntry, t: T): string {
  const lines: string[] = [];
  if (entry.kind === "review") lines.push(t("examPage.unfinished.lostReview"));
  else if (entry.kind === "simulation" && !entry.attemptId)
    lines.push(
      t(
        entry.state === "ready"
          ? "examPage.unfinished.lostPrepared"
          : "examPage.unfinished.lostPreparing",
      ),
    );
  else if (entry.state === "writing" || entry.state === "stopped")
    lines.push(t("examPage.unfinished.lostWriting"));
  else
    lines.push(
      entry.answered > 0
        ? t("examPage.unfinished.lostAnswers", { count: entry.answered })
        : t("examPage.unfinished.lostNothing"),
    );
  if (
    (entry.kind === "quiz" || entry.kind === "drill") &&
    entry.topicId &&
    entry.state !== "writing" &&
    entry.state !== "stopped"
  )
    lines.push(t("examPage.unfinished.staysOnPath"));
  if (entry.kind === "diagnostic")
    lines.push(t("examPage.unfinished.diagnosticAgain"));
  return lines.join(" ");
}

/**
 * Whether a delete failed because the activity is no longer there (a review that expired, one deleted elsewhere). Core's
 * errors reach the page as plain objects with the error's text in `detail`.
 */
export function isMissingActivity(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const { detail, message } = error as { detail?: unknown; message?: unknown };
  return [detail, message].some((text) => typeof text === "string" && text.includes("unfinished-missing"));
}
