import { Button, Popover } from "antd";
import { CircleAlert, ListChecks, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PdfPasswordDialog } from "../../components/PdfPassword";
import { groupJobs } from "./jobGroups";
import { JobsPanel } from "./JobsPanel";
import { useFinishedJobs, useJobs } from "./queries";

/**
 * The top-bar button of the jobs list: how many jobs are running and how many problems wait, and the list under it.
 * It stays out of the way until a job has run today.
 */
export function JobsButton() {
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
    if (empty) setOpen(false);
  }, [empty]);
  if (empty) return dialog;
  const label = t("jobs.buttonLabel", {
    parts: [
      running.length > 0 && t("jobs.running", { count: running.length }),
      problems.length > 0 && t("jobs.toFix", { count: problems.length }),
      running.length + problems.length === 0 &&
        t("jobs.doneToday", { count: finished.length }),
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
        arrow={false}
        rootClassName="px-jobs-popover"
        content={
          <JobsPanel
            ref={panel}
            groups={groups}
            onUnlock={(job) =>
              setUnlocking({ jobId: job.id, title: job.title ?? "" })
            }
            onClose={() => close(false)}
            onEscape={() => close(true)}
          />
        }
      >
        <Button
          ref={trigger}
          type="text"
          shape="round"
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
              <ListChecks size={16} strokeWidth={1.75} />
            ) : null}
          </span>
        </Button>
      </Popover>
    </>
  );
}
