import { useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { EngineUseChoice, engineBox } from "../../components/EngineUseChoice";
import { LocalModelCard, useLocalModel } from "../../components/LocalModel";
import { Notice } from "../../components/Notice";
import { ProviderSetup } from "../../components/ProviderSetup";
import { engineStatus } from "../../lib/engineStatus";
import { invoke } from "../../lib/ipc";
import { useEngineSetup } from "../settings/useEngineSetup";
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
 * The AI engines on this computer, one row each with its real state (ready, signed out, sign-in expired, not installed)
 * and the model Pyxis gives it. The student lets Pyxis use them all (automatic) or ticks the ones it may use, and signs
 * in or installs from the row. With no engine installed it asks which AI the student already pays for and sets that one
 * up instead. It never calls a model: core picks the models (`engines.autoConfigure`). `onReady` tells the page
 * whether to offer "Continue" or "I'll do it later". On a rerun (`again`) the engines the student already set up stay
 * as they are: Pyxis recomputes the automatic choices only if the set of ready engines changes while the screen is open.
 */
export function EnginesStep({
  onReady,
  again = false,
}: {
  onReady: (ready: boolean) => void;
  again?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const { overview, features, choice, choose, refresh } = useEngineSetup();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [picked, setPicked] = useState<InstallableProvider | null>(null);
  const [showAll, setShowAll] = useState(false);
  const local = useLocalModel();
  const localOn = local.data?.enabled === true;
  const allowed = choice.data?.allowed ?? null;
  const rows = (overview.data ?? []).filter((row) => !row.disabled);
  const readyRows = rows.filter((row) => row.installed && row.loggedIn);
  // The engines Pyxis will really use: ready, and left in by the student.
  const usable = readyRows.filter((row) => row.allowed);
  const cliRows = rows.filter(
    (row): row is Engine & { id: InstallableProvider } =>
      row.kind === "cli" && isInstallable(row.id),
  );
  const installedCli = cliRows.filter((row) => row.installed);
  // With nothing installed the student first says what they pay for. Otherwise every engine gets its own row.
  const noneInstalled =
    overview.isSuccess && installedCli.length === 0 && readyRows.length === 0;
  const usableKey = usable.map((row) => row.id).join(",");
  // One notice for every engine Pyxis may use, shown here so no task ever has to ask.
  const toAcknowledge = unacknowledged(rows);
  // An installed engine that still needs a sign-in is most likely the one the student uses, so it is offered first.
  const signedOut =
    installedCli.find((row) => !row.loggedIn && row.allowed)?.id ?? null;
  const engine =
    picked ??
    (plan ? plans.find((item) => item.id === plan)!.engine : null) ??
    (overview.isSuccess && usable.length === 0 ? signedOut : null);

  useEffect(() => {
    if (overview.isSuccess)
      onReady((usableKey !== "" || localOn) && toAcknowledge.length === 0);
  }, [overview.isSuccess, usableKey, localOn, toAcknowledge.length, onReady]);

  const openedWith = useRef<string | null>(null);
  // Let core choose the models once the set of usable engines is known, and again when it changes.
  useEffect(() => {
    if (!overview.isSuccess) return;
    if (again) {
      openedWith.current ??= usableKey;
      if (usableKey === openedWith.current) return;
    }
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
  }, [overview.isSuccess, usableKey, again, client]);

  const names = (list: Engine[]) =>
    new Intl.ListFormat(i18n.language.startsWith("it") ? "it" : "en-GB", {
      style: "long",
      type: "conjunction",
    }).format(list.map((row) => row.name));
  const nameOf = (id: InstallableProvider) =>
    rows.find((row) => row.id === id)?.name ?? id;
  /** The models the automatic plan gives an engine, as on the Settings rows. */
  function modelsOf(provider: string): string {
    const ids: string[] = [];
    for (const selection of Object.values(features.data ?? {}))
      if (selection.provider === provider && !ids.includes(selection.model))
        ids.push(selection.model);
    return ids.join(" · ");
  }
  const notice =
    toAcknowledge.length > 0 ? (
      <ScrollIntoView>
        <EngineNoticePanel
          engines={toAcknowledge}
          onDone={() =>
            void client.invalidateQueries({ queryKey: ["engines"] })
          }
        />
      </ScrollIntoView>
    ) : null;
  const openOffers = () =>
    void window.pyxis.openExternal(offersPage(i18n.language));
  const setup = engine ? (
    <ProviderSetup
      key={engine}
      provider={engine}
      row={rows.find((row) => row.id === engine)}
      onChanged={refresh}
    />
  ) : null;

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
      {overview.isSuccess && !noneInstalled ? (
        <>
          <EngineUseChoice
            allowed={allowed}
            rows={cliRows}
            disabled={choose.isPending || choice.isPending}
            onChange={(next) => choose.mutate(next)}
          />
          <div
            className="engines-list"
            role="list"
            aria-label={t("onboarding.engines.listLabel")}
          >
            {cliRows.map((row) => {
              const status = engineStatus(row);
              return (
                <div role="listitem" key={row.id}>
                  <EngineRow
                    kind={row.kind}
                    name={row.name}
                    model={row.allowed ? modelsOf(row.id) : ""}
                    status={status.tone}
                    statusText={t(status.label)}
                    use={engineBox(
                      allowed,
                      row.id,
                      (next) => choose.mutate(next),
                      choose.isPending,
                    )}
                    actionLabel={
                      status.fix === "install"
                        ? t("engines.install")
                        : t("engines.signIn")
                    }
                    actionDisabled={engine === row.id}
                    onAction={status.fix ? () => setPicked(row.id) : undefined}
                  />
                </div>
              );
            })}
          </div>
          <p className="small engines-hint">
            {t(
              allowed === null
                ? "onboarding.engines.autoHint"
                : "onboarding.engines.chosenHint",
            )}
          </p>
          {setup}
          {notice}
          {localOn ? <LocalModelCard place="onboarding" /> : null}
        </>
      ) : null}
      {noneInstalled ? (
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
                type="text"
                className="linkish px-onboarding-link"
                onClick={openOffers}
              >
                {t("onboarding.engines.offersLink")}
              </Button>
            </div>
          )}
          {/* Free and private, offered only when the hardware check says this computer runs a model well enough. */}
          {(plan === "none" && picked === null) || localOn ? (
            <LocalModelCard place="onboarding" />
          ) : null}
          {setup}
          {notice}
          <div className="px-onboarding-inline">
            <Button
              type="text"
              className="linkish px-onboarding-link"
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
              {cliRows.map((row) => {
                const status = engineStatus(row);
                return (
                  <EngineRow
                    key={row.id}
                    kind={row.kind}
                    name={row.name}
                    model={row.version || ""}
                    status={status.tone}
                    statusText={t(status.label)}
                    actionLabel={t("onboarding.engines.setUp")}
                    actionDisabled={engine === row.id}
                    onAction={() => setPicked(row.id)}
                  />
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
      {usable.length === 0 ? (
        <p className="small engines-hint">
          {t("onboarding.engines.disclosure")}
        </p>
      ) : null}
    </div>
  );
}

/** Brings a block that just appeared into view, so a notice below the fold is not missed. */
function ScrollIntoView({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return <div ref={ref}>{children}</div>;
}
