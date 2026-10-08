import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import { EngineNoticePanel, unacknowledged } from "../../components/EngineNotice";
import { EngineRow } from "../../components/EngineRow";
import { Icon } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { invoke, onBroadcast } from "../../lib/ipc";
import {
  docs,
  engineSummaryLines,
  engineSummaryText,
} from "../settings/EnginesPanel";
import "../settings/EnginesPanel.css";

type Engine = RequestOutput<"engines.overview">[number];

/**
 * What Pyxis found on this computer, in plain words, with the sign-in or install action for an engine that is not ready
 * yet. It never calls a model: it reads the installed engines and lets core pick the models (`engines.autoConfigure`).
 * `onReady` tells the page whether to offer "Continue" or "I'll do it later".
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
  const rows = (overview.data ?? []).filter((row) => !row.disabled);
  const readyRows = rows.filter((row) => row.installed && row.loggedIn);
  const nothingReady = overview.isSuccess && readyRows.length === 0;
  const installedCli = rows.filter(
    (row) => row.kind === "cli" && row.installed,
  );
  // Engines that still need an action. When nothing is ready the installable programs are listed too.
  const pending = rows.filter(
    (row) =>
      row.kind === "cli" &&
      !(row.installed && row.loggedIn) &&
      (row.installed || nothingReady),
  );
  const readyKey = readyRows.map((row) => row.id).join(",");
  // One notice for every engine found, shown here so no task ever has to ask.
  const toAcknowledge = unacknowledged(readyRows);

  useEffect(() => {
    if (overview.isSuccess) onReady(readyKey !== "" && toAcknowledge.length === 0);
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

  const names = (list: Engine[]) =>
    new Intl.ListFormat(i18n.language.startsWith("it") ? "it" : "en-GB", {
      style: "long",
      type: "conjunction",
    }).format(list.map((row) => row.name));
  const login = useEngineSignIn(() => {
    for (const queryKey of [["engines"], ["engine-features"]])
      void client.invalidateQueries({ queryKey });
  });
  const summaryInput = {
    t,
    language: i18n.language,
    overview: overview.data,
    features: features.data,
    nothingReady,
  };
  const summary = engineSummaryText(summaryInput);
  const summaryLines = engineSummaryLines(summaryInput);

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
      {pending.length > 0 ? (
        <div className="engines-list">
          {pending.map((row) => (
            <EngineRow
              key={row.id}
              kind={row.kind}
              name={row.name}
              model={row.version || row.id}
              status={row.installed ? "warn" : "idle"}
              statusText={row.installed ? undefined : t("engines.notInstalled")}
              actionLabel={
                row.installed ? t("engines.signIn") : t("engines.install")
              }
              onAction={() =>
                row.installed
                  ? login.start(row.id)
                  : void window.pyxis.openExternal(docs)
              }
            />
          ))}
        </div>
      ) : null}
      {login.status ? (
        <p className="small" role="status">
          {login.status}
        </p>
      ) : null}
      {login.extra}
      {nothingReady ? (
        <Notice
          tone="info"
          action={{
            label: t("engines.installHelpLink"),
            onClick: () => void window.pyxis.openExternal(docs),
          }}
        >
          {t("engines.installHelp")}
        </Notice>
      ) : null}
      {toAcknowledge.length > 0 ? (
        <EngineNoticePanel
          engines={toAcknowledge}
          onDone={() => void client.invalidateQueries({ queryKey: ["engines"] })}
        />
      ) : readyRows.length === 0 ? (
        <p className="small engines-hint">{t("onboarding.engines.disclosure")}</p>
      ) : null}
    </div>
  );
}

/**
 * The same sign-in flow the engines screen runs: open the browser, take a pasted code, or show the command to run in a
 * terminal. `done` is called when core reports that the engine is signed in.
 */
function useEngineSignIn(done: () => void) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string | null>(null);
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [terminal, setTerminal] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function handle(
    event: {
      provider?: string;
      type: string;
      url?: string;
      command?: string[];
    },
    provider?: string,
  ) {
    if (event.type === "open-url" && event.url) {
      void window.pyxis.openExternal(event.url);
      setStatus(t("engines.waitingSignIn"));
    }
    if (event.type === "code-prompt")
      setCodeFor(event.provider ?? provider ?? null);
    if (event.type === "needs-terminal" && event.command)
      setTerminal(event.command.join(" "));
    if (event.type === "done") {
      setStatus(null);
      setCodeFor(null);
      setTerminal(null);
      done();
    }
    if (event.type === "error") setStatus(t("engines.signInFailed"));
  }
  useEffect(() => onBroadcast("engine.login", (event) => handle(event)));

  function start(provider: string) {
    setNote(null);
    setStatus(t("engines.waitingSignIn"));
    void invoke("engines.login", { provider }).then(
      (event) => handle(event, provider),
      () => setStatus(t("engines.signInFailed")),
    );
  }

  const extra = (
    <>
      {codeFor ? (
        <form
          className="px-form-inline"
          onSubmit={(event) => {
            event.preventDefault();
            void invoke("engines.sendCode", { provider: codeFor, code }).catch(
              () => setStatus(t("engines.signInFailed")),
            );
            setCodeFor(null);
            setCode("");
          }}
        >
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-label={t("engines.code")}
          />
          <Button htmlType="submit" shape="round" disabled={!code.trim()}>
            {t("engines.sendCode")}
          </Button>
        </form>
      ) : null}
      {terminal ? (
        <div className="engines-terminal">
          <p className="small">{t("engines.terminalInstructions")}</p>
          <code>{terminal}</code>
          <Button
            onClick={() => {
              void window.pyxis
                .openTerminal()
                .catch(() => setNote(t("engines.terminalUnavailable")));
            }}
          >
            {t("engines.openTerminal")}
          </Button>
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(terminal).then(
                () => setNote(t("engines.copiedCommand")),
                () => setNote(t("engines.copyFailed")),
              );
            }}
          >
            {t("engines.copyCommand")}
          </Button>
        </div>
      ) : null}
      {note ? (
        <p className="small" role="status">
          {note}
        </p>
      ) : null}
    </>
  );
  return { status, extra, start };
}
