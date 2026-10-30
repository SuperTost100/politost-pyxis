import { useQueryClient } from "@tanstack/react-query";
import { Button, Progress } from "antd";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useJobs } from "../features/jobs/queries";
import { jobErrorKey } from "../features/jobs/jobErrors";
import { invoke } from "../lib/ipc";
import { Notice } from "./Notice";
import { OcrDataCard } from "./OcrData";
import { isOcrRefusal } from "./ocrErrors";
import "./OcrData.css";

/** What the scan notice needs to know about a source. */
export type ScanSource = {
  id: string;
  title: string;
  kind: string;
  status: string;
  sections: number;
  blobSha: string | null;
  scanJobId?: string;
};

/**
 * A scanned PDF whose OCR found no text is marked failed with no sections. It can be read again, so it keeps the scan
 * notice. A failed import names its error, and has nothing to read.
 */
export function scanFoundNothing(source: Omit<ScanSource, "title"> & { error?: string }): boolean {
  return (
    source.status === "failed" &&
    source.kind === "pdf" &&
    source.sections === 0 &&
    !!source.blobSha &&
    !source.error
  );
}

/** Whether a source waits for its scanned pages to be read, or is being read now. */
export const scanPending = (source: Omit<ScanSource, "title"> & { error?: string }) =>
  source.status === "needs-ocr" || source.status === "ocr-queued" || scanFoundNothing(source);

const messageKeyOf = (err: unknown): string =>
  err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "sources.importFailed";

/**
 * The state of a scan's reading, with what the student can do about it. Reading runs in Pyxis's background process, so
 * this only watches its job: leaving the page, closing the window or quitting does not lose the pages read. The Library
 * and the exam wizard show the same notice.
 */
export function ScanNotice({
  source,
  onReplace,
  quiet = false,
}: {
  source: ScanSource;
  /** Adds the file again, for a scan whose file Pyxis no longer has. */
  onReplace?: () => void;
  /** Inside a panel that has its own primary button, its buttons stay secondary. */
  quiet?: boolean;
}) {
  const primary = quiet ? "default" : "primary";
  const { t } = useTranslation();
  const client = useQueryClient();
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const { data: jobs = [], isPending: jobsLoading } = useJobs();
  const job = source.scanJobId ? jobs.find((item) => item.id === source.scanJobId) : undefined;
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["sources"] });
    void client.invalidateQueries({ queryKey: ["jobs"] });
  };

  async function read(): Promise<void> {
    setBusy(true);
    setRefusal(null);
    try {
      await invoke("sources.ocr", { sourceId: source.id });
    } catch (err) {
      setRefusal(messageKeyOf(err));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function onJob(action: "jobs.cancel" | "jobs.resume", jobId: string): Promise<void> {
    setBusy(true);
    try {
      await invoke(action, { jobId });
    } catch {
      setRefusal("jobs.actionFailed");
    } finally {
      setBusy(false);
      refresh();
    }
  }

  if (!source.blobSha)
    return (
      <Notice
        tone="warning"
        action={onReplace ? { label: t("sources.replace"), onClick: onReplace } : undefined}
      >
        {t("sources.scannedNoFile", { title: source.title })}
      </Notice>
    );

  // Without the language data the download card comes first. Once the data is in, waiting scans start by themselves.
  if (isOcrRefusal(refusal))
    return (
      <OcrDataCard
        refusal={t(refusal)}
        onLater={() => setRefusal(null)}
        readyAction={
          <Button type={primary} shape="round" loading={busy} onClick={() => void read()}>
            {t("sources.offerOcr")}
          </Button>
        }
      />
    );

  const percent = Math.round((job?.progress ?? 0) * 100);
  // A scan marked reading with no job behind it (one left by an older version, say) is offered again; Read joins or restarts it.
  if (source.status === "ocr-queued" && (job || jobsLoading)) {
    const paused = job?.state === "interrupted";
    return (
      <div className="px-ocr" role="group" aria-labelledby={headingId}>
        <p className="body-strong" id={headingId}>
          {t(paused ? "sources.ocrPaused" : "sources.ocrReading", { title: source.title })}
        </p>
        <Progress
          percent={percent}
          showInfo={false}
          aria-label={t("sources.ocrReading", { title: source.title })}
          size="small"
          strokeColor="var(--primary)"
        />
        <p className="small" role="status">
          {t(paused ? "sources.ocrPausedHint" : "sources.ocrReadingHint", { percent })}
        </p>
        {refusal ? <Notice tone="danger">{t(refusal)}</Notice> : null}
        {job ? (
          <div className="px-ocr-actions">
            {paused ? (
              <Button type={primary} shape="round" loading={busy} onClick={() => void onJob("jobs.resume", job.id)}>
                {t("sources.ocrResume")}
              </Button>
            ) : null}
            <Button shape="round" disabled={busy} onClick={() => void onJob("jobs.cancel", job.id)}>
              {t("sources.ocrCancel")}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  // A run that stopped says why, unless the student stopped it.
  const stopped = job?.state === "failed" && job.error ? jobErrorKey(job.error) : null;
  const message = scanFoundNothing(source)
    ? t("sources.scanEmpty", { title: source.title })
    : stopped
      ? `${t("sources.ocrStopped", { title: source.title })} ${t(stopped)}`
      : t("sources.scanned", { title: source.title });
  return (
    <>
      <Notice
        tone="warning"
        action={{
          label: t(stopped || scanFoundNothing(source) ? "sources.ocrAgain" : "sources.offerOcr"),
          onClick: () => void read(),
        }}
      >
        {message}
      </Notice>
      {refusal ? <Notice tone="danger">{t(refusal)}</Notice> : null}
    </>
  );
}
