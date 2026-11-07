import { Button, Popover } from "antd";
import { CircleAlert, Clock, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PdfPasswordDialog } from "../../components/PdfPassword";
import { groupJobs } from "./jobGroups";
import { JobsPanel } from "./JobsPanel";
import { useFinishedJobs, useJobs } from "./queries";

/**
 * The button of the jobs list: how many jobs are running and how many problems wait, and the list beside it. In the
 * sidebar ("row") it is the Attività row and always there. As an icon, during setup, it stays out of the way until a
 * job has run today.
 */
export function JobsButton({ variant = "icon" }: { variant?: "row" | "icon" }) {
  const { t } = useTranslation();
  const { data: jobs = [] } = useJobs();
  const { data: done = [], refetch } = useFinishedJobs();
  const groups = useMemo(() => groupJobs(jobs, done), [jobs, done]);
  const [open, setOpen] = useState(false);
  const [unlocking, setUnlocking] = useState<{
    jobId: string;
    title: string;
  } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // The dialog sits outside the popover, so it stays open when a click inside it closes the popover.
  const dialog = (
    <PdfPasswordDialog target={unlocking} onClose={() => setUnlocking(null)} />
  );
  const { problems, running, finished } = groups;
  const empty = problems.length + running.length + finished.length === 0;
  // The button leaves with its last job; it should not reopen the list by itself when a job comes back.
  useEffect(() => {
    if (empty && variant === "icon") setOpen(false);
  }, [empty, variant]);
  if (empty && variant === "icon") return dialog;
  const label = t("jobs.buttonLabel", {
    parts: [
      running.length > 0 && t("jobs.running", { count: running.length }),
      problems.length > 0 && t("jobs.toFix", { count: problems.length }),
      running.length + problems.length === 0 &&
        (empty ? t("jobs.none") : t("jobs.doneToday", { count: finished.length })),
    ]
      .filter(Boolean)
      .join(", "),
  });
  // The Attività row's count: the problems, else the running jobs. Its hidden words drop the number it already shows.
  const shown = problems.length || running.length;
  const withoutCount = (text: string) => text.replace(/^\d+\s*/, "");
  const rowWords = [
    problems.length > 0
      ? ` ${withoutCount(t("jobs.toFix", { count: problems.length }))}`
      : running.length > 0
        ? ` ${withoutCount(t("jobs.running", { count: running.length }))}`
        : `: ${empty ? t("jobs.none") : t("jobs.doneToday", { count: finished.length })}`,
    problems.length > 0 && running.length > 0 ? `, ${t("jobs.running", { count: running.length })}` : "",
  ].join("");
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  return (
    <>
      {dialog}
      <Popover
        trigger="click"
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // A list left open past midnight would still show yesterday's jobs.
          if (next) void refetch();
        }}
        afterOpenChange={(next) => {
          if (next) panel.current?.focus();
        }}
        placement={variant === "row" ? "rightTop" : "bottomRight"}
        // Beside the sidebar row, a tall list slides up to stay inside the window instead of hanging below it, which
        // made the page grow and scroll the sidebar away.
        align={variant === "row" ? { overflow: { adjustX: true, shiftX: true, adjustY: false, shiftY: true } } : undefined}
        arrow={false}
        rootClassName="px-jobs-popover"
        content={
          empty ? (
            <p className="px-jobs-none">{t("jobs.none")}</p>
          ) : (
          <JobsPanel
            ref={panel}
            groups={groups}
            onUnlock={(job) =>
              setUnlocking({ jobId: job.id, title: job.title ?? "" })
            }
            onClose={() => close(false)}
            onEscape={() => close(true)}
          />
          )
        }
      >
        {variant === "row" ? (
          // The row names itself from what it shows, the word and the count, plus hidden words that say what the
          // count is: "Attività 4 da sistemare, 1 in corso".
          <button
            ref={trigger}
            type="button"
            className="px-jobs-row"
            data-tip={t("jobs.title")}
            aria-expanded={open}
          >
            {running.length > 0 ? (
              <LoaderCircle className="px-spin" size={18} strokeWidth={1.75} aria-hidden />
            ) : (
              <Clock size={18} strokeWidth={1.75} aria-hidden />
            )}
            <span>{t("jobs.title")}</span>
            {shown > 0 ? (
              <span className={problems.length > 0 ? "px-side-count is-problem" : "px-side-count"}>{shown}</span>
            ) : null}
            <span className="visually-hidden">{rowWords}</span>
          </button>
        ) : (
        <Button
          ref={trigger}
          type="text"
          className="px-top-tool px-jobs-button"
          aria-expanded={open}
        >
          {/* The counts are only a picture of this sentence, so a screen reader reads the sentence once. */}
          <span className="visually-hidden">{label}</span>
          <span className="px-jobs-trigger" aria-hidden>
            {running.length > 0 ? (
              <span className="px-jobs-part">
                <LoaderCircle
                  className="px-spin"
                  size={16}
                  strokeWidth={1.75}
                />
                <span className="meta">{running.length}</span>
              </span>
            ) : null}
            {running.length > 0 && problems.length > 0 ? (
              <span className="px-jobs-sep" />
            ) : null}
            {problems.length > 0 ? (
              <span className="px-jobs-part is-problem">
                <CircleAlert size={16} strokeWidth={1.75} />
                <span className="meta">{problems.length}</span>
              </span>
            ) : null}
            {running.length + problems.length === 0 ? (
              <Clock size={18} strokeWidth={1.75} />
            ) : null}
          </span>
        </Button>
        )}
      </Popover>
    </>
  );
}
