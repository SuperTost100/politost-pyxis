import { useEffect, useState } from "react";
import "./UpdatesPanel.css";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { App, Button, Progress } from "antd";
import { useTranslation } from "react-i18next";
import type { UpdateInstallView } from "@shared/updates";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";

/** The next fetch comes from the student pressing a button, so it skips the cache. Automatic fetches keep it. */
let forceNext = false;

/** Check for updates now: the Settings button and Help > Check for updates. Main still limits how often GitHub is asked. */
export function checkUpdatesNow(client: QueryClient): Promise<void> {
  forceNext = true;
  return client.refetchQueries({ queryKey: ["updates"] }).finally(() => {
    forceNext = false;
  });
}

function useUpdates() {
  return useQuery({
    queryKey: ["updates"],
    queryFn: () => {
      const force = forceNext;
      forceNext = false;
      return window.pyxis.checkUpdates(force);
    },
    retry: false,
    staleTime: 24 * 60 * 60 * 1000,
  });
}

/** The download state lives in main, so the banner and Settings show the same download. */
function useUpdateInstall(): UpdateInstallView {
  const [view, setView] = useState<UpdateInstallView>({ state: "idle" });
  useEffect(() => {
    let live = true;
    const off = window.pyxis.onUpdateState(setView);
    void window.pyxis.updateState().then((current) => {
      if (live) setView(current);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return view;
}

/**
 * Download and install, its progress and the hand-over for this computer. Nothing downloads until the student presses
 * the button, and the release page stays one click away whenever something goes wrong.
 */
function UpdateInstall({ releaseUrl }: { releaseUrl: string }) {
  const { t, i18n } = useTranslation();
  const { modal } = App.useApp();
  const view = useUpdateInstall();
  const [problem, setProblem] = useState<
    "workspaceBusy" | "finishFailed" | null
  >(null);
  const megabytes = (bytes: number) =>
    `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(bytes / 1e6)} MB`;
  const releasePage = (
    <Button
      shape="round"
      onClick={() => void window.pyxis.openExternal(releaseUrl)}
    >
      {t("updates.download")}
    </Button>
  );

  async function finish(confirmed: boolean) {
    setProblem(null);
    try {
      const jobs = await invoke("jobs.list", {});
      const activeJobs = jobs.filter(
        (job) => job.state === "running" || job.state === "queued",
      ).length;
      const result = await window.pyxis.finishUpdate({ activeJobs, confirmed });
      if (result === "workspace-busy") setProblem("workspaceBusy");
      if (result === "jobs-running")
        modal.confirm({
          title: t("updates.install.jobsTitle"),
          content: t("updates.install.jobsBody", { count: activeJobs }),
          okText: t("updates.install.jobsConfirm"),
          cancelText: t("updates.install.jobsWait"),
          onOk: () => finish(true),
        });
    } catch {
      setProblem("finishFailed");
    }
  }

  const problemNotice = problem ? (
    <Notice tone="warning">{t(`updates.install.${problem}`)}</Notice>
  ) : null;

  if (view.state === "downloading") {
    const label = view.version
      ? t("updates.install.downloading", { version: view.version })
      : t("updates.install.preparing");
    const percent = view.total
      ? Math.floor((view.received / view.total) * 100)
      : 0;
    return (
      <div className="px-update-install">
        <Progress
          percent={percent}
          showInfo={false}
          aria-label={label}
          size="small"
          strokeColor="var(--primary)"
        />
        <p className="small" role="status">
          {view.total
            ? `${label}. ${t("updates.install.progress", {
                received: megabytes(view.received),
                total: megabytes(view.total),
                percent,
              })}`
            : label}
        </p>
        <div className="px-update-actions">
          <Button
            shape="round"
            onClick={() => void window.pyxis.cancelUpdate()}
          >
            {t("updates.install.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  if (view.state === "verified") {
    const primary =
      view.handover === "dmg-opened" || view.handover === "app-opened"
        ? "quit"
        : view.handover === "exe-ready"
          ? "install"
          : view.handover === "appimage-replaced"
            ? "restart"
            : null;
    const again =
      view.handover === "dmg-opened"
        ? "openImage"
        : view.handover === "app-opened"
          ? "openFolder"
          : view.handover === "deb-shown" || view.handover === "appimage-folder"
            ? "showFile"
            : null;
    return (
      <div className="px-update-install">
        <p className="small" role="status">
          {t(`updates.install.verified.${view.handover}`, {
            version: view.version,
          })}
        </p>
        {problemNotice}
        <div className="px-update-actions">
          {primary ? (
            <Button
              shape="round"
              type="primary"
              onClick={() => void finish(false)}
            >
              {t(`updates.install.${primary}`)}
            </Button>
          ) : null}
          {again ? (
            <Button
              shape="round"
              onClick={() =>
                void window.pyxis
                  .revealUpdate()
                  .catch(() => setProblem("finishFailed"))
              }
            >
              {t(`updates.install.${again}`)}
            </Button>
          ) : null}
          {view.handover === "appimage-folder" ? releasePage : null}
        </div>
      </div>
    );
  }

  return (
    <div className="px-update-install">
      {view.state === "failed" ? (
        <Notice tone="danger">
          {t(`updates.install.errors.${view.error}`)}
        </Notice>
      ) : (
        <p className="small section-hint">{t("updates.install.startHint")}</p>
      )}
      <div className="px-update-actions">
        <Button
          shape="round"
          type="primary"
          onClick={() => void window.pyxis.installUpdate()}
        >
          {t(
            view.state === "failed"
              ? "updates.install.retry"
              : "updates.install.start",
          )}
        </Button>
        {releasePage}
      </div>
    </div>
  );
}

export function UpdateNotice() {
  const { t } = useTranslation();
  const { data } = useUpdates();
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem("pyxis-dismissed-release");
    } catch {
      return null;
    }
  });
  if (
    data?.state !== "available" ||
    !data.release ||
    dismissed === data.release.version
  )
    return null;
  return (
    <aside className="px-update-notice" aria-label={t("updates.title")}>
      <Notice tone="info" details={data.release.notes}>
        {t("updates.available", { version: data.release.version })}
      </Notice>
      <UpdateInstall releaseUrl={data.release.url} />
      <Button
        type="text"
        size="small"
        onClick={() => {
          setDismissed(data.release!.version);
          try {
            localStorage.setItem(
              "pyxis-dismissed-release",
              data.release!.version,
            );
          } catch {
            /* In-memory dismissal still works. */
          }
        }}
      >
        {t("updates.dismiss")}
      </Button>
    </aside>
  );
}

export function UpdatesPanel() {
  const { t, i18n } = useTranslation();
  const query = useUpdates();
  const client = useQueryClient();
  const state = query.isError ? "failed" : query.data?.state;
  return (
    <section className="px-updates" aria-labelledby="updates-heading">
      <h2 id="updates-heading" className="visually-hidden">
        {t("updates.title")}
      </h2>
      <p className="small section-hint" role="status">
        {query.isFetching
          ? t("updates.checking")
          : state === "available"
            ? t("updates.available", { version: query.data?.release?.version })
            : state
              ? t(`updates.${state}`)
              : t("updates.checking")}
      </p>
      {query.data ? (
        <p className="small section-hint">
          {t("updates.installed", { version: query.data.current })}
        </p>
      ) : null}
      {query.data?.checkedAt ? (
        <p className="small section-hint">
          {t("updates.checked", {
            at: new Date(query.data.checkedAt).toLocaleString(i18n.language),
          })}
        </p>
      ) : null}
      <Button
        shape="round"
        loading={query.isFetching}
        onClick={() => void checkUpdatesNow(client)}
      >
        {t("updates.check")}
      </Button>
      {query.data?.release ? (
        <>
          <UpdateInstall releaseUrl={query.data.release.url} />
          <details>
            <summary>{t("updates.notes")}</summary>
            <p className="small" style={{ whiteSpace: "pre-wrap" }}>
              {query.data.release.notes}
            </p>
          </details>
        </>
      ) : null}
      <p className="small section-hint">{t("updates.hint")}</p>
    </section>
  );
}
