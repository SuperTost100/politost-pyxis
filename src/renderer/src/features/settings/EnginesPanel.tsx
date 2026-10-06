import {
  Button,
  Drawer,
  Input,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Tabs,
} from "antd";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { engineProviders as providers, type RequestOutput } from "@shared/ipc";
import { EngineRow } from "../../components/EngineRow";
import { Notice } from "../../components/Notice";
import { invoke, onBroadcast } from "../../lib/ipc";
import "./EnginesPanel.css";

const featureNames = [
  "default",
  "chat",
  "plan",
  "lesson",
  "grading",
  "map",
  "vision",
] as const;
type Feature = (typeof featureNames)[number];
type Engine = RequestOutput<"engines.overview">[number];
type Model = RequestOutput<"engines.models">[number];
const docs = "https://github.com/SuperTost100/cli-funnel#quickstart";
function messageKey(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "messageKey" in err &&
    typeof err.messageKey === "string"
  )
    return err.messageKey;
  return "engines.testFailed";
}
function detailOf(err: unknown): string {
  return err &&
    typeof err === "object" &&
    "detail" in err &&
    typeof err.detail === "string"
    ? err.detail
    : "";
}

export function EnginesPanel() {
  const { t } = useTranslation();
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
  const keys = useQuery({
    queryKey: ["engine-key-status"],
    queryFn: () => window.pyxis.keys.status(),
  });
  const modelQueries = useQueries({
    queries: providers.map((provider) => ({
      queryKey: ["engine-models", provider],
      retry: false,
      enabled:
        !provider.endsWith("-api") ||
        !!keys.data?.configured.includes(
          provider === "anthropic-api" ? "anthropic" : "openai",
        ),
      queryFn: () => invoke("engines.models", { provider }),
    })),
  });
  const modelsByProvider = Object.fromEntries(
    providers.map((provider, index) => [
      provider,
      modelQueries[index]?.data ?? [],
    ]),
  ) as Record<string, Model[]>;
  const choices = providers.flatMap((provider) =>
    modelsByProvider[provider]!.map((model) => ({
      value: JSON.stringify([provider, model.id]),
      label: `${provider} · ${model.name}`,
    })),
  );
  const [result, setResult] = useState<string | null>(null);
  const visionModel =
    features.data?.vision?.model ?? features.data?.default?.model;
  const visionCapability = useQuery({
    queryKey: ["engine-capability", "vision", visionModel],
    enabled: !!visionModel,
    queryFn: () =>
      invoke("engines.capability", { model: visionModel!, need: "vision" }),
  });
  const [drawer, setDrawer] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [effort, setEffort] = useState<string | undefined>();
  const [fast, setFast] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addPath, setAddPath] = useState("cli");
  const [keyProvider, setKeyProvider] = useState<"anthropic" | "openai">(
    "anthropic",
  );
  const [keyValue, setKeyValue] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [loginStatus, setLoginStatus] = useState<string | null>(null);
  const [terminalCommand, setTerminalCommand] = useState<string | null>(null);
  const engine = overview.data?.find((row) => row.id === drawer);
  const models = modelsByProvider[drawer ?? ""] ?? [];
  const model = models.find((row) => row.id === selectedModel);
  const available = (overview.data ?? []).filter(
    (row) =>
      row.kind === "cli" ||
      keys.data?.configured.includes(
        row.id === "anthropic-api" ? "anthropic" : "openai",
      ),
  );
  function refresh() {
    for (const queryKey of [
      ["engines"],
      ["engine-features"],
      ["engine-models"],
      ["engine-key-status"],
    ])
      void client.invalidateQueries({ queryKey });
  }
  function loginEvent(
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
      setLoginStatus(t("engines.waitingSignIn"));
    }
    if (event.type === "code-prompt")
      setCodeFor(event.provider ?? provider ?? null);
    if (event.type === "needs-terminal" && event.command)
      setTerminalCommand(event.command.join(" "));
    if (event.type === "done") {
      setLoginStatus(null);
      setCodeFor(null);
      refresh();
    }
    if (event.type === "error") setLoginStatus(t("engines.signInFailed"));
  }
  useEffect(
    () => onBroadcast("engine.login", (event) => loginEvent(event)),
    [client, t],
  );
  const test = useMutation({
    mutationFn: ({
      provider,
      model,
      effort,
      fast,
    }: {
      provider: string;
      model?: string;
      effort?: string;
      fast?: boolean;
    }) => invoke("engines.test", { provider, model, effort, fast }),
    onSuccess: (value) => {
      refresh();
      setResult(
        t("engines.tested", {
          ms: value.latencyMs,
          model: value.model,
          tokens: value.inputTokens,
        }),
      );
    },
  });
  const configure = useMutation({
    mutationFn: async ({
      feature,
      value,
      effort,
      fast,
    }: {
      feature: Feature;
      value: string;
      effort?: string;
      fast?: boolean;
    }) => {
      if (!value && feature !== "default")
        return invoke("engines.clearFeature", { feature });
      const [provider, model] = JSON.parse(value) as [string, string];
      const response = await invoke("engines.setFeature", {
        feature,
        provider,
        model,
        effort,
        fast,
      });
      return response;
    },
    onSuccess: refresh,
  });
  const manage = useMutation({
    mutationFn: async ({
      provider,
      action,
    }: {
      provider: string;
      action: "logout" | "update" | "remove";
    }) => {
      if (action === "remove" && provider.endsWith("-api")) {
        await window.pyxis.keys.remove(
          provider === "anthropic-api" ? "anthropic" : "openai",
        );
        setResult(t("engines.keyRemoved"));
        return;
      }
      if (action === "update") {
        const value = await invoke("engines.update", { provider });
        setResult(
          t(value.changed ? "engines.updated" : "engines.upToDate", {
            version: value.version,
          }),
        );
        return;
      }
      await invoke(action === "logout" ? "engines.logout" : "engines.remove", {
        provider,
      });
      setResult(
        t(action === "logout" ? "engines.signedOut" : "engines.removed"),
      );
    },
    onSuccess: refresh,
  });
  function openEngine(row: Engine) {
    const selection =
      features.data?.default?.provider === row.id
        ? features.data.default
        : Object.values(features.data ?? {}).find(
            (value) => value.provider === row.id,
          );
    const chosen = selection?.model ?? modelsByProvider[row.id]?.[0]?.id ?? "";
    setSelectedModel(chosen);
    setEffort(
      selection?.effort ??
        modelsByProvider[row.id]?.find((model) => model.id === chosen)
          ?.defaultEffort,
    );
    setFast(selection?.fast ?? false);
    setAdding(false);
    setDrawer(row.id);
    setResult(null);
    test.reset();
    manage.reset();
  }
  function act(row: Engine) {
    if (!row.installed && row.kind === "cli") {
      void window.pyxis.openExternal(docs);
      return;
    }
    if (row.loggedIn || row.kind === "api") {
      setResult(null);
      const selection =
        features.data?.default?.provider === row.id
          ? features.data.default
          : undefined;
      test.mutate({
        provider: row.id,
        model: selection?.model,
        effort: selection?.effort,
        fast: selection?.fast,
      });
    } else {
      setAdding(false);
      setLoginStatus(t("engines.waitingSignIn"));
      void invoke("engines.login", { provider: row.id }).then(
        (event) => loginEvent(event, row.id),
        () => setLoginStatus(t("engines.signInFailed")),
      );
    }
  }
  async function saveKey(event: React.FormEvent) {
    event.preventDefault();
    if (keyBusy || !keyValue.trim()) return;
    setKeyBusy(true);
    try {
      await window.pyxis.keys.set(keyProvider, keyValue.trim());
      setKeyValue("");
      refresh();
      setResult(t("engines.keySaved"));
      test.mutate({
        provider: `${keyProvider === "anthropic" ? "anthropic" : "openai"}-api`,
      });
    } catch {
      setResult(t("engines.keyFailed"));
    } finally {
      setKeyBusy(false);
    }
  }
  function renderRow(row: Engine) {
    return (
      <div
        key={row.id}
        className={`engines-row${row.disabled ? " is-disabled" : ""}`}
      >
        <EngineRow
          kind={row.kind}
          name={row.name}
          model={
            features.data?.default?.provider === row.id
              ? features.data.default.model
              : row.version || row.id
          }
          isDefault={features.data?.default?.provider === row.id}
          status={
            row.disabled || !row.installed
              ? "idle"
              : row.loggedIn
                ? "ok"
                : "warn"
          }
          statusText={
            row.disabled
              ? t("engines.unavailable")
              : !row.installed
                ? t("engines.notInstalled")
                : undefined
          }
          onDetails={() => openEngine(row)}
          actionDisabled={row.disabled || test.isPending || manage.isPending}
          actionLabel={
            !row.installed && row.kind === "cli"
              ? t("engines.install")
              : row.loggedIn || row.kind === "api"
                ? t("engines.test")
                : t("engines.signIn")
          }
          onAction={() => act(row)}
        />
        {row.disabled ? (
          <p className="small engines-disabled-reason">
            {t("engines.disabled")}{" "}
            <a
              href={docs}
              onClick={(event) => {
                event.preventDefault();
                void window.pyxis.openExternal(docs);
              }}
            >
              {t("engines.cliDocs")}
            </a>
          </p>
        ) : null}
      </div>
    );
  }
  const feedback = (
    <>
      {result ? (
        <p className="small engines-result" role="status">
          {result}
        </p>
      ) : null}
      {test.error || manage.error ? (
        <Notice tone="danger" details={detailOf(test.error ?? manage.error)}>
          {t(messageKey(test.error ?? manage.error))}
        </Notice>
      ) : null}
    </>
  );
  return (
    <section className="engines-panel">
      <Notice tone="info">
        {t("engines.disclosure")}{" "}
        <a
          href="#engine-terms"
          onClick={(event) => {
            event.preventDefault();
            document
              .getElementById("engine-terms")
              ?.scrollIntoView({ behavior: "instant", block: "start" });
          }}
        >
          {t("engines.termsLink")}
        </a>
      </Notice>
      <div className="engines-heading">
        <h2 className="title-3">{t("engines.title")}</h2>
        <Button type="primary" shape="round" onClick={() => setAdding(true)}>
          {t("engines.add")}
        </Button>
      </div>
      {overview.isPending ? (
        <p className="small" role="status">
          {t("engines.loading")}
        </p>
      ) : null}
      {overview.isError ? (
        <Notice tone="danger">{t("engines.loadFailed")}</Notice>
      ) : null}
      <div className="engines-list">{available.map(renderRow)}</div>
      {loginStatus ? (
        <p className="small" role="status">
          {loginStatus}
        </p>
      ) : null}
      {codeFor ? (
        <form
          className="px-form-inline"
          onSubmit={(event) => {
            event.preventDefault();
            void invoke("engines.sendCode", { provider: codeFor, code }).catch(
              () => setLoginStatus(t("engines.signInFailed")),
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
      {terminalCommand ? (
        <div className="engines-terminal">
          <p className="small">{t("engines.terminalInstructions")}</p>
          <code>{terminalCommand}</code>
          <Button
            onClick={() => {
              void window.pyxis
                .openTerminal()
                .catch(() => setResult(t("engines.terminalUnavailable")));
            }}
          >
            {t("engines.openTerminal")}
          </Button>
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(terminalCommand).then(
                () => setResult(t("engines.copiedCommand")),
                () => setResult(t("engines.copyFailed")),
              );
            }}
          >
            {t("engines.copyCommand")}
          </Button>
        </div>
      ) : null}
      {!drawer && !adding ? feedback : null}
      <h2 className="title-3">{t("engines.perFeature")}</h2>
      <div className="engines-feature-table">
        {featureNames.map((feature) => {
          const selection = features.data?.[feature];
          const value = selection
            ? JSON.stringify([selection.provider, selection.model])
            : "";
          return (
            <div className="engines-feature-row" key={feature}>
              <label htmlFor={`engine-${feature}`}>
                {t(`engines.feature.${feature}`)}
              </label>
              <div>
                <Select
                  id={`engine-${feature}`}
                  aria-label={t(`engines.feature.${feature}`)}
                  showSearch
                  optionFilterProp="label"
                  disabled={configure.isPending}
                  value={value || undefined}
                  placeholder={t(
                    feature === "default"
                      ? "engines.chooseEngine"
                      : "engines.inherit",
                  )}
                  options={[
                    ...(feature === "default"
                      ? []
                      : [{ value: "", label: t("engines.inherit") }]),
                    ...(selection &&
                    !choices.some((choice) => choice.value === value)
                      ? [
                          {
                            value,
                            label: `${overview.data?.find((row) => row.id === selection.provider)?.name ?? selection.provider} · ${selection.model}`,
                          },
                        ]
                      : []),
                    ...choices,
                  ]}
                  onChange={(value) => configure.mutate({ feature, value })}
                />
                {feature === "vision" && visionCapability.data?.warning ? (
                  <p className="small engines-warning">
                    {t(visionCapability.data.warning)}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <p className="small engines-hint">{t("engines.modelAdvice")}</p>
      {configure.error ? (
        <Notice tone="danger">{t(messageKey(configure.error))}</Notice>
      ) : null}
      <details className="engines-diagnostics">
        <summary>{t("engines.diagnostics")}</summary>
        <div
          className="engines-diagnostics-scroll"
          tabIndex={0}
          aria-label={t("engines.diagnostics")}
        >
          <table>
            <thead>
              <tr>
                <th>{t("engines.provider")}</th>
                <th>{t("engines.version")}</th>
                <th>{t("engines.detectedPath")}</th>
                <th>{t("engines.status")}</th>
              </tr>
            </thead>
            <tbody>
              {(overview.data ?? []).map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{row.version || t("engines.notDetected")}</td>
                  <td>
                    <code>{row.path || t("engines.notDetected")}</code>
                  </td>
                  <td>
                    {row.disabled
                      ? t("engines.unavailable")
                      : row.loggedIn
                        ? t("components.engine.statusOk")
                        : t("components.engine.statusWarn")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small">{t("engines.searchFoldersUnavailable")}</p>
      </details>
      <p className="small engines-terms" id="engine-terms">
        {t("engines.terms")} {t("engines.termsDetail")}
      </p>
      <Drawer
        title={engine?.name ?? t("engines.details")}
        open={!!drawer}
        onClose={() => setDrawer(null)}
        width={440}
      >
        {engine?.disabled ? (
          <Notice tone="info">{t("engines.disabled")}</Notice>
        ) : (
          <div className="engines-drawer">
            <div className="px-form-field">
              <label htmlFor="engine-detail-model">{t("engines.model")}</label>
              <Select
                id="engine-detail-model"
                aria-label={t("engines.model")}
                showSearch
                optionFilterProp="label"
                value={selectedModel || undefined}
                options={models.map((model) => ({
                  value: model.id,
                  label: model.name,
                }))}
                onChange={(value) => {
                  setSelectedModel(value);
                  setEffort(
                    models.find((model) => model.id === value)?.defaultEffort,
                  );
                  setFast(false);
                }}
              />
            </div>
            {engine?.capabilities.effort && !!model?.efforts.length ? (
              <div className="px-form-field">
                <label htmlFor="engine-detail-effort">
                  {t("engines.effort")}
                </label>
                <Select
                  id="engine-detail-effort"
                  aria-label={t("engines.effort")}
                  value={effort}
                  allowClear
                  placeholder={t("engines.effortDefault")}
                  options={model.efforts.map((option) => ({
                    value: option.id,
                    label: option.label,
                  }))}
                  onChange={setEffort}
                />
              </div>
            ) : null}
            {engine?.capabilities.fast && model?.fast ? (
              <label className="engines-fast">
                <span>{t("engines.fast")}</span>
                <Switch
                  checked={fast}
                  onChange={setFast}
                  aria-label={t("engines.fast")}
                />
              </label>
            ) : null}
            <div className="engines-actions">
              <Button
                type="primary"
                shape="round"
                loading={test.isPending}
                disabled={!selectedModel}
                onClick={() => {
                  if (drawer)
                    test.mutate({
                      provider: drawer,
                      model: selectedModel,
                      effort: engine?.capabilities.effort ? effort : undefined,
                      fast:
                        engine?.capabilities.fast && model?.fast
                          ? fast
                          : undefined,
                    });
                }}
              >
                {t("engines.test")}
              </Button>
              <Button
                shape="round"
                disabled={!selectedModel || configure.isPending}
                onClick={() => {
                  if (drawer)
                    configure.mutate({
                      feature: "default",
                      value: JSON.stringify([drawer, selectedModel]),
                      effort: engine?.capabilities.effort ? effort : undefined,
                      fast:
                        engine?.capabilities.fast && model?.fast
                          ? fast
                          : undefined,
                    });
                }}
              >
                {t("engines.useDefault")}
              </Button>
            </div>
            {feedback}
            {engine?.kind === "cli" ? (
              <div className="engines-actions">
                <Button
                  disabled={!engine.installed || manage.isPending}
                  onClick={() =>
                    drawer &&
                    manage.mutate({ provider: drawer, action: "logout" })
                  }
                >
                  {t("engines.signOut")}
                </Button>
                <Button
                  disabled={!engine.installed || manage.isPending}
                  onClick={() =>
                    drawer &&
                    manage.mutate({ provider: drawer, action: "update" })
                  }
                >
                  {t("engines.update")}
                </Button>
              </div>
            ) : null}
            <Popconfirm
              title={t("engines.removeConfirm")}
              onConfirm={async () => {
                if (drawer) {
                  await manage.mutateAsync({
                    provider: drawer,
                    action: "remove",
                  });
                  setDrawer(null);
                }
              }}
              okText={t("engines.remove")}
              cancelText={t("engines.cancel")}
            >
              <Button danger disabled={manage.isPending}>
                {engine?.kind === "api"
                  ? t("engines.removeKey")
                  : t("engines.clearChoices", { name: engine?.name })}
              </Button>
            </Popconfirm>
          </div>
        )}
      </Drawer>
      <Modal
        title={t("engines.add")}
        open={adding}
        footer={null}
        onCancel={() => {
          setAdding(false);
          setKeyValue("");
        }}
      >
        <Tabs
          activeKey={addPath}
          onChange={setAddPath}
          items={[
            {
              key: "cli",
              label: t("engines.cliPath"),
              children: (
                <div className="engines-add-list">
                  {available.some((row) => row.kind === "cli") ? (
                    available.filter((row) => row.kind === "cli").map(renderRow)
                  ) : (
                    <Notice tone="info">{t("engines.allCliAdded")}</Notice>
                  )}
                </div>
              ),
            },
            {
              key: "api",
              label: t("engines.apiPath"),
              children: keys.isPending ? (
                <p className="small">{t("engines.checkingKeyring")}</p>
              ) : !keys.data?.canSave ? (
                <Notice tone="info">{t("engines.keyringUnavailable")}</Notice>
              ) : (
                <form className="engines-key-form" onSubmit={saveKey}>
                  <label htmlFor="engine-key-provider">
                    {t("engines.provider")}
                  </label>
                  <Select
                    id="engine-key-provider"
                    aria-label={t("engines.provider")}
                    value={keyProvider}
                    onChange={setKeyProvider}
                    options={[
                      { value: "anthropic", label: "Anthropic" },
                      { value: "openai", label: "OpenAI" },
                    ]}
                  />
                  <label htmlFor="engine-api-key">{t("engines.apiKey")}</label>
                  <Input.Password
                    id="engine-api-key"
                    autoComplete="off"
                    value={keyValue}
                    onChange={(event) => setKeyValue(event.target.value)}
                  />
                  <Button
                    type="primary"
                    shape="round"
                    htmlType="submit"
                    loading={keyBusy || test.isPending}
                    disabled={!keyValue.trim()}
                  >
                    {t("engines.saveAndTest")}
                  </Button>
                </form>
              ),
            },
          ]}
        />
        {feedback}
      </Modal>
    </section>
  );
}
