import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Progress, Switch } from "antd";
import { useEffect, useId } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { RequestOutput } from "@shared/ipc";
import { invoke, onBroadcast } from "../lib/ipc";
import { Icon } from "./Icon";
import { Notice } from "./Notice";
import "./LocalModel.css";
import { formatBytes } from "@shared/format-bytes";

type LocalState = RequestOutput<"engines.local">;
export const localQueryKey = ["engine-local"];

/** The local model state from core. The hardware check runs once per launch, so this is cheap to ask again. */
export function useLocalModel() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: localQueryKey,
    queryFn: () => invoke("engines.local", {}),
    refetchOnWindowFocus: true,
  });
  useEffect(
    () =>
      onBroadcast("engine.local", (event) => {
        if (event.phase === "pull" && event.total)
          client.setQueryData<LocalState>(localQueryKey, (state) =>
            state
              ? {
                  ...state,
                  task: {
                    phase: "pull",
                    completed: event.completed ?? 0,
                    total: event.total ?? 0,
                  },
                }
              : state,
          );
        else void client.invalidateQueries({ queryKey: localQueryKey });
        if (event.phase === "done")
          for (const queryKey of [["engines"], ["engine-features"]])
            void client.invalidateQueries({ queryKey });
      }),
    [client],
  );
  return query;
}

const GIB = 1024 ** 3;
const pciName = /^[0-9a-f]{4}:[0-9a-f]{4}$/i;

function formatters(language: string) {
  const number = (digits: number) =>
    new Intl.NumberFormat(language, { maximumFractionDigits: digits });
  return {
    /** Memory as the system counts it: 16 GiB reads "16 GB". */
    memory: (bytes: number) => `${number(0).format(bytes / GIB)} GB`,
    /** Downloads and disk space in decimal units, as Ollama shows them. */
    size: (bytes: number) => formatBytes(bytes, language),
    speed: (value: number) => number(1).format(value),
  };
}

function hardwareLine(state: LocalState, t: TFunction, language: string) {
  const format = formatters(language);
  const { gpu, ramBytes, freeDiskBytes } = state.hardware;
  const parts: string[] = [];
  if (gpu?.unified)
    parts.push(
      t("engines.local.gpuUnified", {
        name: gpu.name,
        memory: format.memory(gpu.vramBytes ?? ramBytes),
      }),
    );
  else if (gpu)
    parts.push(
      t("engines.local.gpuCard", {
        name:
          gpu.name && !pciName.test(gpu.name)
            ? gpu.name
            : t("engines.local.vendorCard", {
                vendor: gpu.vendor === "nvidia" ? "NVIDIA" : "AMD",
              }),
        memory: format.memory(gpu.vramBytes ?? 0),
      }),
    );
  if (!gpu?.unified)
    parts.push(t("engines.local.ramPart", { size: format.memory(ramBytes) }));
  if (freeDiskBytes != null)
    parts.push(
      t("engines.local.diskPart", { size: format.size(freeDiskBytes) }),
    );
  return t("engines.local.hardware", {
    parts: new Intl.ListFormat(language, { type: "conjunction" }).format(parts),
  });
}

/**
 * Suggests, downloads and checks a model that runs on this computer through Ollama. The suggestion appears only when
 * core's hardware check says the computer runs a model good enough for Pyxis at a usable speed. In Settings a computer
 * that cannot gets a closed "why not" section instead; onboarding shows nothing. Nothing downloads until the student
 * presses Download, and the model takes tasks only after its check passed.
 */
export function LocalModelCard({
  place,
}: {
  place: "settings" | "onboarding";
}) {
  const { t, i18n } = useTranslation();
  // In setup the step's own Continue is the one primary button, so this card's actions are secondary there.
  const primaryType = place === "onboarding" ? "default" : "primary";
  const client = useQueryClient();
  const headingId = useId();
  const local = useLocalModel();
  const refresh = () =>
    void client.invalidateQueries({ queryKey: localQueryKey });
  const pull = useMutation({
    mutationFn: () => invoke("engines.localPull", { consent: true }),
    onSettled: refresh,
  });
  const check = useMutation({
    mutationFn: () => invoke("engines.localCheck", {}),
    onSettled: refresh,
  });
  const enable = useMutation({
    mutationFn: (enabled: boolean) =>
      invoke("engines.localEnable", { enabled }),
    onSettled: () => {
      refresh();
      void client.invalidateQueries({ queryKey: ["engine-features"] });
    },
  });
  const state = local.data;
  if (!state) return null;
  const format = formatters(i18n.language);
  const model = state.model;
  const openOllama = () => void window.pyxis.openExternal(state.installUrl);

  if (state.reason && !state.enabled && !state.task) {
    if (place === "onboarding") return null;
    return (
      <details className="px-local-why">
        <summary>{t("engines.local.cannotTitle")}</summary>
        <p className="small">
          {t(`engines.local.cannot.${state.reason}`, {
            model: model?.name ?? "",
            size: format.size(
              (model?.downloadBytes ?? 0) + state.minimum.diskMarginGb * 1e9,
            ),
            min: state.minimum.ramGb,
            vram: state.minimum.vramGb,
            unified: state.minimum.unifiedGb,
          })}
        </p>
        {state.reason !== "unknown" ? (
          <p className="small px-local-muted">
            {hardwareLine(state, t, i18n.language)}
          </p>
        ) : null}
      </details>
    );
  }
  if (!model) return null;

  const name = model.name;
  const task = state.task;
  const last = state.last;
  const result = state.check;

  let body;
  if (task?.phase === "pull") {
    const percent = Math.min(
      100,
      Math.floor((task.completed / Math.max(1, task.total)) * 100),
    );
    body = (
      <>
        <p className="body-strong" id={headingId}>
          {t("engines.local.downloading", { model: name })}
        </p>
        <Progress
          percent={percent}
          showInfo={false}
          size="small"
          strokeColor="var(--primary)"
          aria-label={t("engines.local.downloading", { model: name })}
        />
        <p className="small" role="status">
          {t("engines.local.progress", {
            done: format.size(task.completed),
            total: format.size(task.total),
            percent,
          })}
        </p>
        <div className="px-local-actions">
          <Button
            shape="round"
            onClick={() => void invoke("engines.localCancel", {})}
          >
            {t("engines.local.cancel")}
          </Button>
        </div>
      </>
    );
  } else if (task?.phase === "check") {
    body = (
      <>
        <p className="body-strong" id={headingId}>
          {t("engines.local.checking", { model: name })}
        </p>
        <Progress
          percent={100}
          status="active"
          showInfo={false}
          size="small"
          strokeColor="var(--primary)"
          aria-label={t("engines.local.checking", { model: name })}
        />
        <p className="small" role="status">
          {t("engines.local.checkingBody")}
        </p>
        <div className="px-local-actions">
          <Button
            shape="round"
            onClick={() => void invoke("engines.localCancel", {})}
          >
            {t("engines.local.cancel")}
          </Button>
        </div>
      </>
    );
  } else if (state.downloaded && result) {
    body = (
      <>
        <p className="body-strong" id={headingId}>
          {result.passed
            ? t("engines.local.readyTitle", { model: name })
            : t("engines.local.offTitle", { model: name })}
        </p>
        {result.passed ? (
          <p className="small">
            {t("engines.local.result", {
              speed: format.speed(result.tokensPerSecond),
            })}
          </p>
        ) : (
          <Notice tone="warning">
            {t(`engines.local.failed.${result.failure ?? "error"}`, {
              model: name,
              speed: format.speed(result.tokensPerSecond),
              min: state.minTokensPerSecond,
            })}
          </Notice>
        )}
        {result.passed ? (
          <label className="px-local-switch">
            <span>
              <span className="body-strong">{t("engines.local.use")}</span>
              <span className="small px-local-muted">
                {t("engines.local.useHint")}
              </span>
            </span>
            <Switch
              checked={state.enabled}
              loading={enable.isPending}
              onChange={(value) => enable.mutate(value)}
              aria-label={t("engines.local.use")}
            />
          </label>
        ) : null}
        <div className="px-local-actions">
          <Button
            shape="round"
            loading={check.isPending}
            disabled={!state.ollama.running}
            onClick={() => check.mutate()}
          >
            {t("engines.local.runCheck")}
          </Button>
        </div>
        {!state.ollama.running ? (
          <p className="small px-local-muted">
            {t("engines.local.ollamaClosed")}
          </p>
        ) : null}
      </>
    );
  } else {
    body = (
      <>
        <p className="body-strong" id={headingId}>
          {t("engines.local.suggestTitle")}
        </p>
        <p className="small">
          {t("engines.local.suggestBody", { model: name })}
        </p>
        <p className="small px-local-muted">
          {hardwareLine(state, t, i18n.language)}
        </p>
        {state.ollama.running ? (
          <>
            <p className="small">
              {t(
                state.downloaded
                  ? "engines.local.consentHave"
                  : "engines.local.consent",
                { model: name, size: format.size(model.downloadBytes) },
              )}
            </p>
            <div className="px-local-actions">
              <Button
                type={primaryType}
                shape="round"
                loading={pull.isPending}
                onClick={() => pull.mutate()}
              >
                {state.downloaded
                  ? t("engines.local.checkNow")
                  : t("engines.local.download", {
                      size: format.size(model.downloadBytes),
                    })}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="small">{t("engines.local.ollamaMissing")}</p>
            <div className="px-local-actions">
              <Button type={primaryType} shape="round" onClick={openOllama}>
                {t("engines.local.getOllama")}
              </Button>
              <Button
                shape="round"
                loading={local.isFetching}
                onClick={refresh}
              >
                {t("engines.local.checkAgain")}
              </Button>
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <div className="px-local" role="group" aria-labelledby={headingId}>
      <span className="px-local-ico" aria-hidden>
        <Icon name="hard-drive" size={18} />
      </span>
      <div className="px-local-body">
        {body}
        {last && !task ? (
          <Notice
            tone={last.outcome === "failed" ? "danger" : "info"}
            details={last.detail || undefined}
          >
            {t(
              last.outcome === "failed"
                ? "engines.local.stoppedFailed"
                : "engines.local.stoppedCancelled",
            )}
          </Notice>
        ) : null}
      </div>
    </div>
  );
}
