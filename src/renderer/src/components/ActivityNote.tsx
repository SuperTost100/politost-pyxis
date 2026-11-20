import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "./ActivityNote.css";

/** What a job's model call is doing (`study.part` and `study.quizRead` give it while the job runs). */
export type Activity = { phase: "starting" | "thinking" | "writing"; since: number };

/** Minutes and seconds, as "0:42" or "12:05". */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * One line under a working sentence that says what the tool is doing and for how long, so a call that thinks for a minute
 * before its first word still shows something moving. The seconds tick here and are not a live region: a screen reader
 * reads the line when it reaches it, not every second.
 */
export function ActivityNote({ activity, className }: { activity: Activity | null | undefined; className?: string }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const since = activity?.since;
  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!activity) return null;
  return (
    <span className={["px-activity-note", className].filter(Boolean).join(" ")}>
      {t(`activity.${activity.phase}`, { time: elapsedText(now - activity.since) })}
    </span>
  );
}
