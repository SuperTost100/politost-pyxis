import { useState } from "react";
import "./UpdatesPanel.css";
import { useQuery } from "@tanstack/react-query";
import { Button } from "antd";
import { useTranslation } from "react-i18next";
import { Notice } from "../../components/Notice";

function useUpdates() {
  return useQuery({
    queryKey: ["updates"],
    queryFn: () => window.pyxis.checkUpdates(),
    retry: false,
    staleTime: 24 * 60 * 60 * 1000,
  });
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
      <Notice
        tone="info"
        action={{
          label: t("updates.download"),
          onClick: () => void window.pyxis.openExternal(data.release!.url),
        }}
        details={data.release.notes}
      >
        {t("updates.available", { version: data.release.version })}
      </Notice>
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
  const { t } = useTranslation();
  const query = useUpdates();
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
            at: new Date(query.data.checkedAt).toLocaleString(),
          })}
        </p>
      ) : null}
      <Button
        shape="round"
        loading={query.isFetching}
        onClick={() => void query.refetch()}
      >
        {t("updates.check")}
      </Button>
      {query.data?.release ? (
        <>
          <Button
            shape="round"
            type="primary"
            onClick={() =>
              void window.pyxis.openExternal(query.data!.release!.url)
            }
          >
            {t("updates.download")}
          </Button>
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
