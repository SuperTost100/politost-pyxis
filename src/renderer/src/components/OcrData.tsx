import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Progress } from "antd";
import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useJobs } from "../features/jobs/queries";
import { invoke } from "../lib/ipc";
import { Notice } from "./Notice";
import { ocrErrorKey } from "./ocrErrors";
import "./OcrData.css";
import { formatBytes } from "@shared/format-bytes";

const isoCode: Record<string, string> = { eng: "en", ita: "it" };

function languageList(codes: string[], locale: string): string {
  const names = new Intl.DisplayNames(locale, { type: "language" });
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(
    codes.map((code) => names.of(isoCode[code] ?? code) ?? code),
  );
}

/** The OCR data on disk, its download job, and starting the download again (replacing a job that stopped). */
function useOcrData() {
  const client = useQueryClient();
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
  return { state, active, last, busy, startFailed, start };
}

/**
 * Settings > Data: the OCR data as one row of the "Dove sono i tuoi dati" card (pyxis-mockups app/index.html,
 * "s-settings-data"). Pyxis downloads it by itself, so the row only reports: ready, downloading with its progress, or
 * stopped with a small way to start it again. What the download is and where it comes from is folded under it.
 */
export function OcrDataRow() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { state, active, last, busy, startFailed, start } = useOcrData();
  if (!state.data) return null;
  const size = formatBytes(state.data.totalBytes, i18n.language);
  const languages = languageList(state.data.languages, i18n.language);
  const ready = state.data.state === "ready";
  const damaged = state.data.state === "integrity";
  const percent = active ? Math.round(active.progress * 100) : 0;
  const failure =
    last?.state === "failed"
      ? (ocrErrorKey(last.error ?? "") ?? "jobs.failedGeneral")
      : null;
  const line = startFailed
    ? t("sources.ocrData.startFailed")
    : active
      ? t("sources.ocrData.progress", { percent })
      : ready
        ? t("settings.ocrRow.ready", { size })
        : failure
          ? t(failure)
          : last
            ? t(`sources.ocrData.${last.state}`)
            : damaged
              ? t("sources.ocrDataIntegrity")
              : t("settings.ocrRow.missing");
  const label = active?.stepLabel ? t(active.stepLabel) : t("sources.jobs.ocrData");
  return (
    <li>
      <div className="px-ctl-row">
        <div className="px-ctl-text">
          <span className="px-ctl-title" id={id}>
            {t("settings.ocrRow.title")}
          </span>
          <span className="px-ctl-description" role="status">
            {line}
          </span>
        </div>
        {active ? (
          <div className="px-ctl-acts px-ocr-row-progress">
            <Progress
              percent={percent}
              showInfo={false}
              aria-label={label}
              size="small"
              strokeColor="var(--primary)"
            />
            <Button
              size="small"
              type="text"
              onClick={() => void invoke("jobs.cancel", { jobId: active.id })}
            >
              {t("sources.ocrData.cancel")}
            </Button>
          </div>
        ) : ready ? null : (
          <Button size="small" loading={busy} onClick={() => void start()}>
            {failure
              ? t("sources.ocrData.retry")
              : t(last || damaged ? "settings.ocrRow.downloadAgain" : "settings.ocrRow.download", { size })}
          </Button>
        )}
      </div>
      <details className="px-ctl-why">
        <summary>
          <ChevronRight size={14} strokeWidth={2} aria-hidden />
          {t("settings.ocrRow.more")}
        </summary>
        <div className="px-ctl-why-body">
          <p>{t("sources.ocrData.body", { size, languages })}</p>
        </div>
      </details>
    </li>
  );
}

/**
 * Progress and recovery for the local OCR language data in a refused flow. It shows disk truth from core, as Settings'
 * row does. A refused action is never run again for the student: `readyAction` is the button they press once the data
 * is ready.
 */
export function OcrDataCard({
  refusal,
  readyAction,
  onLater,
}: {
  /** Message key of the refusal that brought the student here. Without it the card is a plain status. */
  refusal?: string;
  readyAction?: ReactNode;
  /** Leaves the refused action pending. */
  onLater?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const { state, active, last, busy, startFailed, start } = useOcrData();
  if (!state.data) return null;

  const size = formatBytes(state.data.totalBytes, i18n.language);
  const languages = languageList(state.data.languages, i18n.language);

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
            {t("sources.ocrData.later")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
