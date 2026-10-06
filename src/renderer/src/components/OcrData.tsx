import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Progress } from "antd";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useJobs } from "../features/jobs/queries";
import { invoke } from "../lib/ipc";
import { Notice } from "./Notice";
import { ocrErrorKey } from "./ocrErrors";
import "./OcrData.css";

const isoCode: Record<string, string> = { eng: "en", ita: "it" };

function languageList(codes: string[], locale: string): string {
  const names = new Intl.DisplayNames(locale, { type: "language" });
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(
    codes.map((code) => names.of(isoCode[code] ?? code) ?? code),
  );
}

/**
 * First-use consent, progress and recovery for the local OCR language data. It shows disk truth from core, so it reads
 * the same in Settings and in a refused flow. Nothing is downloaded until the student presses Download, and a refused
 * action is never run again for them: `readyAction` is the button they press once the data is ready.
 */
export function OcrDataCard({
  refusal,
  readyAction,
  onLater,
  laterLabel,
}: {
  /** Message key of the refusal that brought the student here. Without it the card is a plain status. */
  refusal?: string;
  readyAction?: ReactNode;
  /** Leaves the refused action pending. */
  onLater?: () => void;
  /** Replaces the default "Not now" wording of the later button. */
  laterLabel?: string;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const state = useQuery({
    queryKey: ["ocr-data"],
    queryFn: () => invoke("sources.ocrDataState", {}),
  });
  const { data: jobs = [] } = useJobs();
  const mine = jobs.filter((job) => job.kind === "ocr-data-download");
  const active = mine.find(
    (job) => job.state === "queued" || job.state === "running",
  );
  const stopped = mine.filter((job) =>
    ["failed", "cancelled", "interrupted"].includes(job.state),
  );
  const last = stopped.at(-1);
  if (!state.data) return null;

  const size = `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(state.data.totalBytes / 1e6)} MB`;
  const languages = languageList(state.data.languages, i18n.language);

  async function start() {
    setBusy(true);
    setStartFailed(false);
    try {
      const started = await invoke("sources.ocrData", { consent: true });
      // A job that stopped earlier is replaced by this one, so the jobs list does not keep a stale failure.
      for (const job of stopped)
        if (job.id !== started.jobId)
          await invoke("jobs.dismiss", { jobId: job.id });
    } catch {
      setStartFailed(true);
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: ["ocr-data"] });
      void client.invalidateQueries({ queryKey: ["jobs"] });
    }
  }

  if (active) {
    const percent = Math.round(active.progress * 100);
    const label = active.stepLabel
      ? t(active.stepLabel)
      : t("sources.jobs.ocrData");
    return (
      <div className="px-ocr" role="group" aria-labelledby={headingId}>
        <p className="body-strong" id={headingId}>
          {label}
        </p>
        <Progress
          percent={percent}
          showInfo={false}
          aria-label={label}
          size="small"
          strokeColor="var(--primary)"
        />
        <p className="small" role="status">
          {t("sources.ocrData.progress", { percent })}
        </p>
        <div className="px-ocr-actions">
          <Button
            shape="round"
            onClick={() => void invoke("jobs.cancel", { jobId: active.id })}
          >
            {t("sources.ocrData.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  if (state.data.state === "ready") {
    return (
      <div className="px-ocr" role="group" aria-labelledby={headingId}>
        <p className="body-strong" id={headingId} role="status">
          {t("sources.ocrData.readyTitle")}
        </p>
        <p className="small">
          {t("sources.ocrData.readyBody", { size, languages })}
        </p>
        {readyAction ? (
          <div className="px-ocr-actions">{readyAction}</div>
        ) : null}
      </div>
    );
  }

  const damaged = state.data.state === "integrity";
  const failure =
    last?.state === "failed"
      ? (ocrErrorKey(last.error ?? "") ?? "jobs.failedGeneral")
      : null;
  return (
    <div className="px-ocr" role="group" aria-labelledby={headingId}>
      <p className="body-strong" id={headingId}>
        {refusal ??
          t(damaged ? "sources.ocrDataIntegrity" : "sources.ocrData.title")}
      </p>
      <p className="small">
        {t(damaged ? "sources.ocrData.integrityBody" : "sources.ocrData.body", {
          size,
          languages,
        })}
      </p>
      {failure ? <Notice tone="danger">{t(failure)}</Notice> : null}
      {last && last.state !== "failed" ? (
        <Notice tone="info">{t(`sources.ocrData.${last.state}`)}</Notice>
      ) : null}
      {startFailed ? (
        <Notice tone="danger">{t("sources.ocrData.startFailed")}</Notice>
      ) : null}
      <div className="px-ocr-actions">
        <Button
          type="primary"
          shape="round"
          loading={busy}
          onClick={() => void start()}
        >
          {t(
            last || damaged
              ? last?.state === "failed"
                ? "sources.ocrData.retry"
                : "sources.ocrData.downloadAgain"
              : "sources.ocrData.download",
            { size },
          )}
        </Button>
        {onLater ? (
          <Button type="text" shape="round" onClick={onLater}>
            {laterLabel ?? t("sources.ocrData.later")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
