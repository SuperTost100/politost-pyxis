import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import {
  isInstallable,
  offersPage,
  type InstallableProvider,
} from "@shared/installers";
import {
  EngineNoticePanel,
  unacknowledged,
} from "../../components/EngineNotice";
import { EngineRow } from "../../components/EngineRow";
import { Icon } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { ProviderSetup } from "../../components/ProviderSetup";
import { invoke, onBroadcast } from "../../lib/ipc";
import {
  engineSummaryLines,
  engineSummaryText,
} from "../settings/EnginesPanel";
import "../settings/EnginesPanel.css";

type Engine = RequestOutput<"engines.overview">[number];

/** What the student already pays for decides the engine: Pyxis signs in with that account, so it costs nothing more. */
const plans = [
  { id: "chatgpt", engine: "codex" },
  { id: "claude", engine: "claude" },
  { id: "google", engine: "antigravity" },
  { id: "cursor", engine: "agent" },
  { id: "none", engine: "antigravity" },
] as const satisfies ReadonlyArray<{ id: string; engine: InstallableProvider }>;
type Plan = (typeof plans)[number]["id"];

/**
 * Asks which AI the student already pays for, then installs and signs in to the matching engine. It also says what
 * Pyxis found on this computer. It never calls a model: it reads the installed engines and lets core pick the models
 * (`engines.autoConfigure`). `onReady` tells the page whether to offer "Continue" or "I'll do it later".
 */
export function EnginesStep({
  onReady,
}: {
  onReady: (ready: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const overview = useQuery({
    queryKey: ["engines"],
    queryFn: () => invoke("engines.overview", {}),
    refetchOnWindowFocus: true,
  });
  const features = useQuery({
    queryKey: ["engine-features"],
    queryFn: () => invoke("engines.features", {}),
  });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [picked, setPicked] = useState<InstallableProvider | null>(null);
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const rows = (overview.data ?? []).filter((row) => !row.disabled);
  const readyRows = rows.filter((row) => row.installed && row.loggedIn);
  const nothingReady = overview.isSuccess && readyRows.length === 0;
  const cliRows = rows.filter(
    (row): row is Engine & { id: InstallableProvider } =>
      row.kind === "cli" && isInstallable(row.id),
  );
  const installedCli = cliRows.filter((row) => row.installed);
  const readyKey = readyRows.map((row) => row.id).join(",");
  // One notice for every engine found, shown here so no task ever has to ask.
  const toAcknowledge = unacknowledged(readyRows);
  // An engine that is installed but signed out is most likely the one the student uses, so it is offered first.
  const signedOut = installedCli.find((row) => !row.loggedIn)?.id ?? null;
  const engine =
    picked ??
    (plan ? plans.find((item) => item.id === plan)!.engine : null) ??
    (nothingReady ? signedOut : null);
  // Once the student has picked something the choices stay, so the screen does not jump when the engine is ready.
  const picking = nothingReady || adding || plan !== null || picked !== null;

  useEffect(() => {
    if (overview.isSuccess)
      onReady(readyKey !== "" && toAcknowledge.length === 0);
  }, [overview.isSuccess, readyKey, toAcknowledge.length, onReady]);

  // Let core choose the models once the set of ready engines is known, and again when it changes.
  useEffect(() => {
    if (!overview.isSuccess) return;
    let live = true;
    void invoke("engines.autoConfigure", {})
      .then(() => {
        if (live)
          void client.invalidateQueries({ queryKey: ["engine-features"] });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [overview.isSuccess, readyKey, client]);

  // Core recomputes the choices after the notice is confirmed.
  useEffect(
    () =>
      onBroadcast("engine.auto", () => {
        void client.invalidateQueries({ queryKey: ["engine-features"] });
      }),
    [client],
  );

  const refresh = () => {
    for (const queryKey of [["engines"], ["engine-features"]])
      void client.invalidateQueries({ queryKey });
  };
  const names = (list: Engine[]) =>
    new Intl.ListFormat(i18n.language.startsWith("it") ? "it" : "en-GB", {
      style: "long",
      type: "conjunction",
    }).format(list.map((row) => row.name));
  const nameOf = (id: InstallableProvider) =>
    rows.find((row) => row.id === id)?.name ?? id;
  const summaryInput = {
    t,
    language: i18n.language,
    overview: overview.data,
    features: features.data,
    nothingReady,
  };
  const summary = engineSummaryText(summaryInput);
  const summaryLines = engineSummaryLines(summaryInput);
  const openOffers = () =>
    void window.pyxis.openExternal(offersPage(i18n.language));

  let found: string | null = null;
  if (overview.isSuccess) {
    if (readyRows.length > 0) {
      found = t("onboarding.engines.found", { names: names(readyRows) });
    } else if (installedCli.length > 0) {
      found = t("onboarding.engines.foundSignedOut", {
        names: names(installedCli),
      });
    } else {
      found = t("onboarding.engines.foundNone");
    }
  }

  return (
    <div className="px-onboarding-engines">
      {overview.isPending ? (
        <p className="body" role="status">
          {t("engines.loading")}
        </p>
      ) : null}
      {overview.isError ? (
        <Notice tone="danger">{t("engines.loadFailed")}</Notice>
      ) : null}
      {found ? (
        <p className="body-strong" role="status">
          {found}
        </p>
      ) : null}
      {readyRows.length > 0 && summary ? (
        <div className="px-card engines-summary">
          <span className="px-engine-ico">
            <Icon name="cpu" size={18} />
          </span>
          <div className="engines-summary-body">
            <h2 className="engines-summary-title">{t("engines.auto.title")}</h2>
            <p>{summary}</p>
            {summaryLines.length ? (
              <ul className="engines-summary-split">
                {summaryLines.map((line) => (
                  <li key={line.id}>
                    <span className="body-strong">{line.name}</span>:{" "}
                    {line.tasks}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="small engines-hint">{t("engines.auto.cheap")}</p>
          </div>
        </div>
      ) : null}
      {toAcknowledge.length > 0 ? (
        <EngineNoticePanel
          engines={toAcknowledge}
          onDone={() =>
            void client.invalidateQueries({ queryKey: ["engines"] })
          }
        />
      ) : null}
      {overview.isSuccess && !picking ? (
        <div className="px-onboarding-inline">
          <Button shape="round" onClick={() => setAdding(true)}>
            {t("onboarding.engines.addAnother")}
          </Button>
        </div>
      ) : null}
      {overview.isSuccess && picking ? (
        <>
          <fieldset className="px-onboarding-plans">
            <legend className="title-3">
              {t("onboarding.engines.question")}
            </legend>
            <p className="small px-onboarding-note">
              {t("onboarding.engines.questionHint")}
            </p>
            <div className="choice-list">
              {plans.map((item) => {
                const selected = picked === null && plan === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={selected ? "choice is-selected" : "choice"}
                    aria-pressed={selected}
                    onClick={() => {
                      setPlan(item.id);
                      setPicked(null);
                    }}
                  >
                    <span className="body-strong">
                      {t(`onboarding.engines.plans.${item.id}`)}
                    </span>
                    <span className="meta px-onboarding-note">
                      {item.id === "none"
                        ? t("onboarding.engines.startFree")
                        : nameOf(item.engine)}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
          {plan === "none" && picked === null ? (
            <Notice
              tone="info"
              action={{
                label: t("onboarding.engines.offers"),
                onClick: openOffers,
              }}
            >
              {t("onboarding.engines.noneBody")}
            </Notice>
          ) : (
            <div className="px-onboarding-inline">
              <Button
                type="link"
                className="px-onboarding-link"
                onClick={openOffers}
              >
                {t("onboarding.engines.offersLink")}
              </Button>
            </div>
          )}
          {engine ? (
            <ProviderSetup
              key={engine}
              provider={engine}
              row={rows.find((row) => row.id === engine)}
              onChanged={refresh}
            />
          ) : null}
          <div className="px-onboarding-inline">
            <Button
              type="link"
              className="px-onboarding-link"
              aria-expanded={showAll}
              onClick={() => setShowAll((value) => !value)}
            >
              {t(
                showAll
                  ? "onboarding.engines.hideAll"
                  : "onboarding.engines.showAll",
              )}
            </Button>
          </div>
          {showAll ? (
            <div className="engines-list">
              {cliRows.map((row) => (
                <EngineRow
                  key={row.id}
                  kind={row.kind}
                  name={row.name}
                  model={row.version || row.id}
                  status={
                    row.installed && row.loggedIn
                      ? "ok"
                      : row.installed
                        ? "warn"
                        : "idle"
                  }
                  statusText={
                    row.installed ? undefined : t("engines.notInstalled")
                  }
                  actionLabel={t("onboarding.engines.setUp")}
                  actionDisabled={engine === row.id}
                  onAction={() => setPicked(row.id)}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {readyRows.length === 0 ? (
        <p className="small engines-hint">
          {t("onboarding.engines.disclosure")}
        </p>
      ) : null}
    </div>
  );
}
