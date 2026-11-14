import { Button, Popover } from "antd";
import { CircleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PdfPasswordDialog } from "../../components/PdfPassword";
import { groupJobs } from "./jobGroups";
import { JobsPanel } from "./JobsPanel";
import { useFinishedJobs, useJobs } from "./queries";

/**
 * The button of the jobs list, in a page's top-right corner: how many jobs are running and how many problems wait, and
 * the list that opens under it. `keep` shows it even before anything has run today, as the app's pages do; during setup
 * it stays out of the way until a job has run.
 */
export function JobsButton({
  keep = false,
  leave,
  blocked,
}: {
  keep?: boolean;
  /** A page's own rule for being left (`usePlace`): a link in the list that goes to another page waits for it. */
  leave?: (then: () => void) => void;
  /** Why the page cannot be left: the list's links that go elsewhere are off, with this as the reason. */
  blocked?: string;
}) {
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
  const { problems, finished } = groups;
  // A request's jobs, such as a folder's files, count as the one row the list shows for them.
  const running = groups.runningItems;
  const empty = problems.length + running.length + finished.length === 0;
  // The button leaves with its last job; it should not reopen the list by itself when a job comes back.
  useEffect(() => {
    if (empty && !keep) setOpen(false);
  }, [empty, keep]);
  if (empty && !keep) return dialog;
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
        placement="bottomRight"
        // A tall list slides up to stay inside the window instead of hanging below it, which made the page grow.
        align={{ overflow: { adjustX: true, shiftX: true, adjustY: false, shiftY: true } }}
        arrow={false}
        rootClassName="px-jobs-popover"
        motion={{ motionName: "px-jobs-grow" }}
        content={
          empty ? (
            <p className="px-jobs-none">{t("jobs.none")}</p>
          ) : (
          <JobsPanel
            ref={panel}
            groups={groups}
            leave={leave}
            blocked={blocked}
            onUnlock={(job) =>
              setUnlocking({ jobId: job.id, title: job.title ?? "" })
            }
            onClose={() => close(false)}
            onEscape={() => close(true)}
          />
          )
        }
      >
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
                <JobsClock running />
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
            {running.length + problems.length === 0 ? <JobsClock size={18} /> : null}
          </span>
        </Button>
      </Popover>
    </>
  );
}

/** The Attività clock. While jobs run its hands turn once every 6 seconds; with reduced motion they stay still. */
function JobsClock({ running = false, size = 16 }: { running?: boolean; size?: number }) {
  return (
    <svg
      className={running ? "px-jobs-clock is-running" : "px-jobs-clock"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path className="px-jobs-hands" d="M12 6v6l4 2" />
    </svg>
  );
}
