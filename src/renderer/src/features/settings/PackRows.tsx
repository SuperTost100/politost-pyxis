import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Progress } from "antd";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@shared/format-bytes";
import type { RequestOutput } from "@shared/ipc";
import { ControlList } from "../../components/Controls";
import { useConfirm } from "../../components/Dialog";
import { MenuButton, useItemMenu } from "../../components/ItemMenu";
import { invoke } from "../../lib/ipc";
import { useJobs } from "../jobs/queries";
import "./PackRows.css";

type Pack = "pyodide" | "drawing";
type Status = RequestOutput<"tools.runtime">;

/** The status query the Python page shares: disk truth for each pack, asked again twice a second while one downloads. */
export const packStatusKey = ["python-runtime"];

/** One line of a row, under its text. A new line grows in where it lands (`PackRows.css`). */
function Line({ tone, children }: { tone?: "error"; children: ReactNode }) {
  return (
    <span className={tone === "error" ? "px-pack-line is-error" : "px-pack-line"} role={tone === "error" ? "alert" : undefined}>
      <span>{children}</span>
    </span>
  );
}

/**
 * One pack's row in Settings › Studio (the "Disegni e Python" card): what it is for, and one of its states, each in the
 * place the last one was. Not downloaded: its size on the button and where the files come from. Downloading: the
 * progress in the button's place, with Annulla. Ready: its size on disk, and Rimuovi in the three dots, which a
 * right-click on the row opens too. Older than this app's pack: Aggiorna. Failed: where it stopped and Riprova. A
 * download starts only when the button is pressed.
 */
function PackRow({ pack, status }: { pack: Pack; status: Status }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const confirm = useConfirm();
  const [starting, setStarting] = useState(false);
  const [failedStart, setFailedStart] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  const { data: jobs = [] } = useJobs();
  const info = status.info[pack];
  const name = pack === "pyodide" ? "python" : "drawings";
  const size = formatBytes(info.size, i18n.language);
  // The job to stop: the pack's own, or the one the Python page started for every pack that was missing.
  const job = jobs.find(
    (item) =>
      (item.state === "queued" || item.state === "running") &&
      (pack === "drawing"
        ? item.kind === "local-drawings-download" || (item.kind === "local-runtime-download" && item.ref === "missing")
        : item.kind === "local-runtime-download" && (item.ref === "pyodide" || item.ref === "missing")),
  );
  // The download of the pack is under way, or its job has been asked for and has not begun to fetch yet.
  const downloading = info.phase === "downloading" || starting || (Boolean(job) && info.phase !== "ready");
  const ready = info.phase === "ready";
  const percent = info.totalBytes ? Math.min(100, Math.round((info.bytes / info.totalBytes) * 100)) : 0;
  const sized = (bytes: number) => formatBytes(bytes, i18n.language);
  const canRemove = ready || info.outdated;

  async function start() {
    setStarting(true);
    setFailedStart(false);
    try {
      await invoke("tools.runtimeDownload", { pack });
    } catch {
      setFailedStart(true);
    } finally {
      setStarting(false);
      void client.invalidateQueries({ queryKey: packStatusKey });
      void client.invalidateQueries({ queryKey: ["jobs"] });
    }
  }
  async function remove() {
    const answer = await confirm({
      title: t(`settings.packs.${name}.removeTitle`),
      body: t(`settings.packs.${name}.removeBody`, { size }),
      confirm: t("settings.packs.removeConfirm"),
      tone: "danger",
    });
    if (answer !== "confirm") return;
    setRemoveFailed(false);
    try {
      await invoke("tools.runtimeRemove", { pack });
    } catch {
      setRemoveFailed(true);
    } finally {
      void client.invalidateQueries({ queryKey: packStatusKey });
    }
  }
  const menu = {
    items: [{ key: "remove", label: t(`settings.packs.${name}.remove`), danger: true }],
    onClick: ({ key }: { key: string }) => {
      if (key === "remove") void remove();
    },
  };
  const region = t(`settings.packs.${name}.more`);
  const { bind, popup } = useItemMenu({ menu, region, disabled: !canRemove || downloading });

  // What the row says under its text, from the pack's state.
  let line: ReactNode = null;
  if (downloading) line = null;
  else if (removeFailed) line = <Line tone="error">{t("settings.packs.removeFailed")}</Line>;
  else if (info.phase === "failed" || failedStart)
    line = (
      <Line tone="error">
        {failedStart
          ? t("settings.packs.startFailed")
          : info.error === "runtime-integrity-failed"
            ? t("settings.packs.tampered")
            : info.bytes > 0
              ? t("settings.packs.stoppedAt", { done: sized(info.bytes) })
              : t("settings.packs.notStarted")}
      </Line>
    );
  else if (ready)
    line = <Line>{t(`settings.packs.${name}.onDisk`, { size, version: info.version })}</Line>;
  else if (info.outdated)
    line = <Line>{t(`settings.packs.${name}.outdated`, { size, version: info.version })}</Line>;
  else line = <Line>{t(`settings.packs.${name}.consent`)}</Line>;

  // Polite and in tens, so a screen reader hears the download move without hearing every byte.
  const announced = Math.floor(percent / 10) * 10;
  const failed = info.phase === "failed" || failedStart;

  return (
    <li {...(canRemove && !downloading ? bind : {})} data-pack={pack} data-phase={downloading ? "downloading" : info.phase}>
      <div className="px-ctl-row px-pack-row">
        <div className="px-ctl-text">
          <span className="px-ctl-title">{t(`settings.packs.${name}.title`)}</span>
          <span className="px-ctl-description">{t(`settings.packs.${name}.about`)}</span>
          {pack === "drawing" ? (
            <span className="px-ctl-description">
              {t(status.packs.pyodide === "ready" ? "settings.packs.drawings.withPython" : "settings.packs.drawings.withoutPython")}
            </span>
          ) : null}
          {line}
        </div>
        <div className="px-ctl-acts px-pack-acts">
          {downloading ? (
            <div className="px-pack-progress" key="progress">
              <div className="px-pack-meter">
                <Progress
                  percent={percent}
                  showInfo={false}
                  size="small"
                  strokeColor="var(--primary)"
                  aria-label={t(`settings.packs.${name}.progress`, { percent })}
                />
                <span className="px-pack-stat" aria-hidden="true">
                  {t("settings.packs.transfer", { current: sized(info.bytes), total: sized(info.totalBytes) })}
                </span>
              </div>
              <span className="visually-hidden" role="status" aria-live="polite">
                {t(`settings.packs.${name}.progress`, { percent: announced })}
              </span>
              {job ? (
                <Button size="small" type="text" onClick={() => void invoke("jobs.cancel", { jobId: job.id })}>
                  {t("settings.packs.cancel")}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="px-pack-buttons" key={info.phase}>
              {failed ? (
                <Button size="small" onClick={() => void start()}>
                  {t("settings.packs.retry")}
                </Button>
              ) : ready ? null : info.outdated ? (
                <Button size="small" onClick={() => void start()}>
                  {t("settings.packs.update")}
                </Button>
              ) : (
                <Button size="small" onClick={() => void start()}>
                  {t(`settings.packs.${name}.download`, { size })}
                </Button>
              )}
              {canRemove ? <MenuButton size="sm" menu={menu} label={region} /> : null}
            </div>
          )}
        </div>
      </div>
      {popup}
    </li>
  );
}

/**
 * The "Disegni e Python" card of Settings › Studio: Python's row and the drawings' row, each downloaded, updated and
 * removed on its own. Nothing is fetched until a button here, or the Python page's, is pressed.
 */
export function PackRows() {
  const { t } = useTranslation();
  const { data: jobs = [] } = useJobs();
  // A job that is queued or running has not always begun to fetch, so it keeps the status coming too.
  const working = jobs.some(
    (job) =>
      (job.state === "queued" || job.state === "running") &&
      (job.kind === "local-runtime-download" || job.kind === "local-drawings-download"),
  );
  const status = useQuery({
    queryKey: packStatusKey,
    queryFn: () => invoke("tools.runtime", {}),
    refetchInterval: (query) =>
      working || Object.values(query.state.data?.packs ?? {}).includes("downloading") ? 500 : false,
  });
  // Until the status is there each row keeps its place with its name and what it is for, so a link to a section further
  // down the page, which scrolls once as the page opens, does not end up above the card when the card fills in.
  if (!status.data)
    return (
      <ControlList aria-busy="true">
        {(["pyodide", "drawing"] as const).map((pack) => {
          const name = pack === "pyodide" ? "python" : "drawings";
          return (
            <li key={pack} data-pack={pack} data-phase="loading">
              <div className="px-ctl-row px-pack-row">
                <div className="px-ctl-text">
                  <span className="px-ctl-title">{t(`settings.packs.${name}.title`)}</span>
                  <span className="px-ctl-description">{t(`settings.packs.${name}.about`)}</span>
                  {pack === "drawing" ? <span className="px-ctl-description">&nbsp;</span> : null}
                  <span className="px-pack-line">&nbsp;</span>
                </div>
              </div>
            </li>
          );
        })}
      </ControlList>
    );
  return (
    <ControlList>
      <PackRow pack="pyodide" status={status.data} />
      <PackRow pack="drawing" status={status.data} />
    </ControlList>
  );
}
