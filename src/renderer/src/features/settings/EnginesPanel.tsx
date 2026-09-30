import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { EngineRow } from "../../components/EngineRow";
import { Notice } from "../../components/Notice";
import { invoke, onBroadcast } from "../../lib/ipc";

function messageKey(err: unknown): string {
  if (err && typeof err === "object" && "messageKey" in err) {
    const key = (err as { messageKey: unknown }).messageKey;
    if (typeof key === "string") return key;
  }
  return "engines.testFailed";
}

function detailOf(err: unknown): string {
  if (err && typeof err === "object" && "detail" in err) {
    const detail = (err as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return "";
}

export function EnginesPanel() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const overview = useQuery({
    queryKey: ["engines"],
    queryFn: () => invoke("engines.overview", {}),
  });
  const codexModels = useQuery({
    queryKey: ["engine-models", "codex"],
    queryFn: () => invoke("engines.models", { provider: "codex" }),
  });
  const claudeModels = useQuery({
    queryKey: ["engine-models", "claude"],
    queryFn: () => invoke("engines.models", { provider: "claude" }),
  });
  const features = useQuery({
    queryKey: ["engine-features"],
    queryFn: () => invoke("engines.features", {}),
  });
  const [result, setResult] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [openAiKey, setOpenAiKey] = useState("");
  const [probe, setProbe] = useState("");
  useEffect(
    () =>
      onBroadcast("engine.login", (event) => {
        if (event.type === "open-url" && event.url) {
          void window.pyxis.openExternal(event.url);
        }
        if (event.type === "code-prompt") setCodeFor(event.provider);
        if (event.type === "done") {
          void client.invalidateQueries({ queryKey: ["engines"] });
        }
      }),
    [client],
  );
  const [acked, setAcked] = useState(
    () => localStorage.getItem("pyxis.engineDisclosure") === "1",
  );

  const test = useMutation({
    mutationFn: (provider: string) => invoke("engines.test", { provider }),
    onSuccess: (value) => {
      setResult(
        t("engines.tested", {
          ms: value.latencyMs,
          model: value.model,
          tokens: value.inputTokens,
        }),
      );
    },
  });

  const grading = features.data?.grading;
  const vision = features.data?.vision;
  const gradingChoices = [
    codexModels.data?.[0],
    claudeModels.data?.find((model) => model.id.startsWith("claude-sonnet")) ??
      claudeModels.data?.[0],
  ].flatMap((model) =>
    model
      ? [
          {
            provider: model.id.startsWith("claude") ? "claude" : "codex",
            model: model.id,
          },
        ]
      : [],
  );

  return (
    <div>
      <div className="label section-label">{t("engines.title")}</div>
      <p className="small section-hint">{t("engines.terms")}</p>
      {acked ? null : (
        <Notice tone="warning">
          {t("engines.disclosure")}{" "}
          <button
            type="button"
            onClick={() => {
              localStorage.setItem("pyxis.engineDisclosure", "1");
              setAcked(true);
            }}
          >
            {t("engines.acknowledge")}
          </button>
        </Notice>
      )}
      {overview.isPending ? (
        <p className="small section-hint">{t("engines.loading")}</p>
      ) : null}
      {overview.isError ? <Notice tone="danger">{t("engines.loadFailed")}</Notice> : null}
      {(overview.data ?? []).map((row) => (
        <div key={row.id} className="engine-gap">
          <EngineRow
            kind={row.kind === "api" ? "api" : "cli"}
            name={row.name}
            model={row.version || row.id}
            status={row.disabled ? "error" : row.loggedIn ? "ok" : "warn"}
            statusText={row.disabled ? t("engines.disabled") : undefined}
            actionDisabled={row.disabled || !acked}
            actionLabel={row.loggedIn ? t("engines.test") : t("engines.signIn")}
            onAction={() => {
              if (row.loggedIn || row.kind === "api") {
                setResult(null);
                test.mutate(row.id);
                return;
              }
              void invoke("engines.login", { provider: row.id }).then((event) => {
                if (event.type === "open-url" && typeof event.url === "string") {
                  void window.pyxis.openExternal(event.url);
                }
                if (event.type === "code-prompt") setCodeFor(row.id);
              });
            }}
          />
        </div>
      ))}
      {codeFor ? (
        <form
          className="engine-key"
          onSubmit={(event) => {
            event.preventDefault();
            void invoke("engines.sendCode", { provider: codeFor, code });
            setCodeFor(null);
            setCode("");
          }}
        >
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-label={t("engines.code")}
          />
          <button type="submit">{t("engines.sendCode")}</button>
        </form>
      ) : null}
      {result ? <p className="small section-hint">{result}</p> : null}
      {test.error ? (
        <Notice tone="danger">
          {t(messageKey(test.error))}
          <details>
            <summary>{t("engines.details")}</summary>
            {detailOf(test.error)}
          </details>
        </Notice>
      ) : null}

      <div className="label section-label">{t("engines.grading")}</div>
      <div className="choice-list">
        {gradingChoices.map((item) => (
          <button
            key={item.provider}
            type="button"
            className={
              grading?.provider === item.provider ? "choice is-selected" : "choice"
            }
            onClick={() => {
              void invoke("engines.setFeature", {
                feature: "grading",
                provider: item.provider,
                model: item.model,
              }).then(() => client.invalidateQueries({ queryKey: ["engine-features"] }));
            }}
          >
            <span className="body-strong">{item.model}</span>
          </button>
        ))}
      </div>

      <div className="label section-label">{t("engines.vision")}</div>
      <div className="choice-list">
        {gradingChoices.map((item) => (
          <button
            key={item.model}
            type="button"
            className={vision?.model === item.model ? "choice is-selected" : "choice"}
            onClick={() => {
              void invoke("engines.setFeature", {
                feature: "vision",
                provider: item.provider,
                model: item.model,
              }).then((value) => {
                setWarning(value.warning);
                void client.invalidateQueries({ queryKey: ["engine-features"] });
              });
            }}
          >
            <span className="body-strong">{item.model}</span>
          </button>
        ))}
      </div>
      {warning ? <Notice tone="warning">{t(warning)}</Notice> : null}
      <form
        className="engine-key"
        onSubmit={(event) => {
          event.preventDefault();
          void invoke("engines.capability", { model: probe, need: "vision" }).then(
            (value) => setWarning(value.warning),
          );
        }}
      >
        <input
          value={probe}
          aria-label={t("engines.capabilityCheck")}
          placeholder={t("engines.capabilityCheck")}
          onChange={(event) => setProbe(event.target.value)}
        />
        <button type="submit">{t("engines.check")}</button>
      </form>

      <div className="label section-label">{t("engines.anthropicKey")}</div>
      <form
        className="engine-key"
        onSubmit={(event) => {
          event.preventDefault();
          void window.pyxis.keys.set("anthropic", keyValue).then(() => {
            setKeyValue("");
            setResult(t("engines.keySaved"));
            void client.invalidateQueries({ queryKey: ["engines"] });
          });
        }}
      >
        <input
          type="password"
          value={keyValue}
          autoComplete="off"
          aria-label={t("engines.anthropicKey")}
          onChange={(event) => setKeyValue(event.target.value)}
        />
        <button type="submit">{t("engines.saveKey")}</button>
      </form>
      <div className="label section-label">{t("engines.openaiKey")}</div>
      <form
        className="engine-key"
        onSubmit={(event) => {
          event.preventDefault();
          void window.pyxis.keys.set("openai", openAiKey).then(() => {
            setOpenAiKey("");
            setResult(t("engines.keySaved"));
            void client.invalidateQueries({ queryKey: ["engines"] });
          });
        }}
      >
        <input
          type="password"
          value={openAiKey}
          autoComplete="off"
          aria-label={t("engines.openaiKey")}
          onChange={(event) => setOpenAiKey(event.target.value)}
        />
        <button type="submit">{t("engines.saveKey")}</button>
      </form>
    </div>
  );
}
