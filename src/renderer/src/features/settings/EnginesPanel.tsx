import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { studentEffort } from "@shared/effort";
import type { RequestOutput } from "@shared/ipc";
import { engineProviders as providers } from "@shared/limits";
import { TOOL_PROGRAMS } from "@shared/tool-names";
import { isInstallable, offersPage, type InstallableProvider } from "@shared/installers";
import { Button } from "../../components/Button";
import { ControlList, ControlRow, SwitchRow } from "../../components/Controls";
import { Dialog, useConfirm } from "../../components/Dialog";
import { EngineNoticeDialog, unacknowledged, type NoticeEngine } from "../../components/EngineNotice";
import { MenuButton, MenuItemArea } from "../../components/ItemMenu";
import { LocalModelCard, localQueryKey } from "../../components/LocalModel";
import { Notice } from "../../components/Notice";
import { ProviderSetup } from "../../components/ProviderSetup";
import { Working } from "../../components/Working";
import { engineStatus, keyStatus, manualChoice } from "../../lib/engineStatus";
import { invoke } from "../../lib/ipc";
import { engineChoiceQuery, engineFeaturesQuery, enginesQuery } from "../../lib/queries";
import { isConnected, limitWhen, movedOrder, shownOrder, toggledUse } from "../../lib/toolOrder";
import { useEngineNames } from "../../lib/useEngineNames";
import { useStillHere } from "../../lib/useStillHere";
import { DebugSwitch, debugQuery } from "./DebugSwitch";
import { disclosureText } from "./disclosure";
import { EngineTasks, featureNames, type Feature } from "./EngineTasks";
import { EngineUsage } from "./EngineUsage";
import { ToolList, type Tool, type ToolMenu } from "./ToolList";
import { useEngineSetup } from "./useEngineSetup";
import "./EnginesPanel.css";

const advancedKey = "pyxis.engines.advanced";
type Engine = RequestOutput<"engines.overview">[number];
type Model = RequestOutput<"engines.models">[number];
const docs = "https://github.com/SuperTost100/cli-funnel#quickstart";
const vendorOf = (provider: string) => (provider === "anthropic-api" ? "anthropic" : "openai");

function messageKey(err: unknown): string {
  if (err && typeof err === "object" && "messageKey" in err && typeof err.messageKey === "string")
    return err.messageKey;
  return "engines.testFailed";
}
/** Failures whose usual wording sends the student to this page, said here with the engine's name instead. */
const testErrors: Record<string, string> = {
  "engines.errors.not-logged-in": "engines.errors.signedOutNamed",
  "engines.errors.model-not-included": "engines.testErrors.modelNotIncluded",
  "engines.errors.quota": "engines.testErrors.quota",
};

/** What a failed test says on the engines page: always with the engine's name. */
function testMessage(t: TFunction, key: string, name: string): string {
  const own = testErrors[key];
  return own ? t(own, { name }) : t("engines.testErrors.other", { name, message: t(key) });
}
/** Advanced is open until the student closes it, and then stays as they left it. */
function readAdvanced(): boolean {
  try {
    return localStorage.getItem(advancedKey) !== "0";
  } catch {
    return true;
  }
}
function detailOf(err: unknown): string {
  return err && typeof err === "object" && "detail" in err && typeof err.detail === "string" ? err.detail : "";
}

/**
 * When a tool that is out of requests has them again, as its row says it: at a time today, tomorrow at a time, or on
 * a day for a limit that lasts longer, such as a weekly one.
 */
export function limitText(t: TFunction, language: string, until: number, now = Date.now()): string {
  const when = limitWhen(until, now);
  const time = new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(until);
  if (when !== "later") return t(`engines.limit.${when}`, { time });
  return t("engines.limit.later", {
    day: new Intl.DateTimeFormat(language, { weekday: "long", day: "numeric", month: "long" }).format(until),
  });
}

/** Order in which tasks are named in the plain-words summary. */
const summaryTasks = ["chat", "map", "plan", "lesson", "cards", "vision", "grading"] as const;
type Features = RequestOutput<"engines.features">;
type SummaryInput = {
  t: TFunction;
  language: string;
  overview: Engine[] | undefined;
  features: Features | undefined;
  nothingReady: boolean;
};

/**
 * The plain-words sentence for the automatic choice: the engines Pyxis picks from, by the names the student sees on the
 * page, for example "Pyxis picks the right tool for each job by itself, out of ChatGPT and Claude, …". Which engine
 * does which job is left to the advanced options.
 */
export function engineSummaryText(input: SummaryInput): string | null {
  const { t, overview, features } = input;
  if (input.nothingReady) return t("engines.auto.none");
  const engines = [...new Set(summaryTasks.flatMap((task) => features?.[task]?.provider ?? []))];
  const name = (id: string) => overview?.find((row) => row.id === id)?.name ?? (id === "ollama" ? "Ollama" : id);
  if (engines.length === 1) return t("engines.auto.single", { name: name(engines[0]!) });
  if (engines.length > 1)
    return t("engines.auto.summary", {
      names: new Intl.ListFormat(input.language.startsWith("it") ? "it" : "en-GB", {
        style: "long",
        type: "conjunction",
      }).format(engines.map(name)),
    });
  return null;
}

/**
 * The line under the page's title: what Pyxis does with the tools below. With an order and two or more tools in use
 * it uses the first of the list and goes on with the next. Otherwise it names the tools it shares the work among, or
 * the one that does everything.
 */
export function EnginesIntro() {
  const { t, i18n } = useTranslation();
  const choice = useQuery(engineChoiceQuery);
  const overview = useQuery(enginesQuery);
  const features = useQuery(engineFeaturesQuery);
  const local = useQuery({ queryKey: localQueryKey, queryFn: () => invoke("engines.local", {}) });
  const allowed = choice.data?.allowed ?? null;
  const ready = (overview.data ?? []).filter(
    (row) => row.installed && row.loggedIn && !row.disabled && (allowed === null || allowed.includes(row.id)),
  );
  const listed = !!choice.data?.order && ready.filter(isConnected).length > 1;
  const text = listed
    ? t("engines.intro.listed")
    : engineSummaryText({
        t,
        language: i18n.language,
        overview: overview.data,
        features: features.data,
        nothingReady: overview.isSuccess && ready.length === 0 && !local.data?.enabled,
      });
  return <span className="engines-summary">{text ?? t("settings.pageIntro.engines")}</span>;
}

/**
 * Settings > AI tools. "Collegati" lists the tools the student is signed in to, in the order Pyxis uses them: the
 * first one that has requests left does the work, and the next takes over when it runs out. "Da collegare" has the
 * tools still to install or sign in to. "Avanzate" keeps the model on this computer, the API keys, the model of each
 * task and the technical details.
 */
export function EnginesPanel() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [advanced, setAdvancedState] = useState(readAdvanced);
  const debug = useQuery(debugQuery);
  function setAdvanced(value: boolean) {
    setAdvancedState(value);
    try {
      localStorage.setItem(advancedKey, value ? "1" : "0");
    } catch {
      // The choice still applies until the window closes.
    }
  }
  const client = useQueryClient();
  const engines = useEngineSetup();
  const names = useEngineNames();
  const { overview, features, choice, choose, reorder } = engines;
  const allowed = choice.data?.allowed ?? null;
  const order = choice.data?.order ?? null;
  const engineName = (id: string) =>
    overview.data?.find((row) => row.id === id)?.name ?? (id === "ollama" ? "Ollama" : id);
  const keys = useQuery({
    queryKey: ["engine-key-status"],
    queryFn: () => window.pyxis.keys.status(),
  });
  const modelQueries = useQueries({
    queries: providers.map((provider) => ({
      queryKey: ["engine-models", provider],
      retry: false,
      enabled: !provider.endsWith("-api") || !!keys.data?.configured.includes(vendorOf(provider)),
      queryFn: () => invoke("engines.models", { provider }),
    })),
  });
  const modelsByProvider = Object.fromEntries(
    providers.map((provider, index) => [provider, modelQueries[index]?.data ?? []]),
  ) as Record<string, Model[]>;
  const local = useQuery({
    queryKey: localQueryKey,
    queryFn: () => invoke("engines.local", {}),
  });
  // Models of the engines the student lets Pyxis use, each named with its engine as the student knows it.
  const choices = [
    ...providers
      .filter((provider) => allowed === null || allowed.includes(provider))
      .flatMap((provider) =>
        modelsByProvider[provider]!.map((model) => ({
          value: JSON.stringify([provider, model.id]),
          label: `${engineName(provider)} · ${model.name}`,
        })),
      ),
    // The local model can be pinned to a task once its check passed and the student turned it on.
    ...(local.data?.enabled && local.data.model
      ? [
          {
            value: JSON.stringify(["ollama", local.data.model.id]),
            label: `Ollama · ${local.data.model.name}`,
          },
        ]
      : []),
  ];
  // A Prova that answered is kept as data and worded when shown, so a model name core learns later, or a language
  // change, reaches the message. Every other result is already a sentence.
  const [result, setResult] = useState<string | { provider: string; model: string; ms: number; tokens: number } | null>(
    null,
  );
  const visionModel = features.data?.vision?.model ?? features.data?.default?.model;
  const visionCapability = useQuery({
    queryKey: ["engine-capability", "vision", visionModel],
    enabled: !!visionModel,
    queryFn: () => invoke("engines.capability", { model: visionModel!, need: "vision" }),
  });
  const [details, setDetails] = useState<string | null>(null);
  // What the details dialog shows stays while it shrinks away, when `details` is already null.
  const lastDetails = useRef(details);
  if (details) lastDetails.current = details;
  const shownDetails = lastDetails.current;
  const [selectedModel, setSelectedModel] = useState("");
  const [effort, setEffort] = useState<string | undefined>();
  const [fast, setFast] = useState(false);
  const [addingKey, setAddingKey] = useState(false);
  const [keyProvider, setKeyProvider] = useState<"anthropic" | "openai">("anthropic");
  const [keyValue, setKeyValue] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  // A CLI that still needs installing or a sign-in, shown in the same setup card as first setup. "Sign in to …" on an
  // engine error elsewhere opens this page with `?signIn=<engine>`, which opens that engine's sign-in at once.
  const [searchParams, setSearchParams] = useSearchParams();
  const stillHere = useStillHere();
  const signInParam = searchParams.get("signIn");
  const [setupFor, setSetupFor] = useState<InstallableProvider | null>(null);
  // What the setup dialog shows stays while it shrinks away, when `setupFor` is already null.
  const lastSetup = useRef(setupFor);
  if (setupFor) lastSetup.current = setupFor;
  const shownSetup = lastSetup.current;
  useEffect(() => {
    if (!signInParam) return;
    if (isInstallable(signInParam)) setSetupFor(signInParam);
    if (stillHere()) setSearchParams({}, { replace: true });
  }, [signInParam, setSearchParams]);
  // The notice for engines that are ready but not acknowledged. `then` runs the action the student was after.
  const [notice, setNotice] = useState<{ engines: NoticeEngine[]; then?: () => void } | null>(null);
  const [noticeLater, setNoticeLater] = useState(false);
  // An engine the student enables or adds needs its notice before anything is sent to it.
  function withNotice(provider: string, action: () => void) {
    const row = overview.data?.find((item) => item.id === provider);
    if (!row || row.acknowledged) action();
    else setNotice({ engines: [row], then: action });
  }
  const levelLabel = (id: string) => t(`engines.effortLevel.${id}`, { defaultValue: id });
  const engine = overview.data?.find((row) => row.id === shownDetails);
  const models = modelsByProvider[shownDetails ?? ""] ?? [];
  const model = models.find((row) => row.id === selectedModel);
  const rows = overview.data ?? [];
  // The tools the student can turn on or off: every CLI of this build and each API provider whose key is saved. Until
  // the keys are read the list cannot know the keyed ones, so turning a tool off waits: a pick without them would drop
  // them and their tasks.
  const manual = manualChoice(rows, keyStatus(keys));
  const readyRows = rows.filter((row) => row.installed && row.loggedIn && !row.disabled);
  const ready = readyRows.map((row) => row.id);
  const inUse = (row: Engine) => allowed === null || allowed.includes(row.id);
  // The connected tools in the order Pyxis uses them, and the rest of the CLIs, still to install or sign in to.
  const connected = shownOrder(rows.filter(isConnected), order);
  const toConnect = rows.filter((row) => row.kind === "cli" && !isConnected(row));
  const keyed = rows.filter((row) => row.kind === "api" && keys.data?.configured.includes(vendorOf(row.id)));
  function refresh() {
    engines.refresh();
    for (const queryKey of [["engine-models"], ["engine-key-status"]]) void client.invalidateQueries({ queryKey });
  }
  // A tool that has requests again changes its row without a broadcast: the row is read again when its limit ends.
  const nextReset = Math.min(...rows.flatMap((row) => (row.limitedUntil ? [row.limitedUntil] : [])));
  useEffect(() => {
    if (!Number.isFinite(nextReset)) return;
    // setTimeout holds at most about 24 days; a longer wait is read again then.
    const timer = setTimeout(
      () => void client.invalidateQueries({ queryKey: enginesQuery.queryKey }),
      Math.min(Math.max(nextReset - Date.now(), 0) + 1000, 2 ** 31 - 1),
    );
    return () => clearTimeout(timer);
  }, [nextReset, client]);
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
    // A refused sign-in turns the engine's row to signed out, so the list is read again either way.
    onError: refresh,
    onSuccess: (value, variables) => {
      refresh();
      setResult({
        provider: variables.provider,
        model: value.model,
        ms: value.latencyMs,
        tokens: value.inputTokens,
      });
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
      const [provider, model] = JSON.parse(value) as [string, string];
      return invoke("engines.setFeature", { feature, provider, model, effort, fast });
    },
    onSuccess: refresh,
  });
  // The student's reasoning effort for one task. No effort returns the task to its automatic level.
  const setEffortFor = useMutation({
    mutationFn: ({ feature, effort }: { feature: Feature; effort?: string }) =>
      invoke("engines.setEffort", { feature, effort }),
    onSuccess: refresh,
  });
  // Returns one feature, or all of them, to Pyxis's own choice.
  const automatic = useMutation({
    mutationFn: (feature?: Feature) =>
      invoke("engines.autoConfigure", {
        reset: true,
        ...(feature ? { features: [feature] } : {}),
      }),
    onSuccess: refresh,
  });
  const manage = useMutation({
    mutationFn: async ({ provider, action }: { provider: string; action: "logout" | "update" | "remove" }) => {
      if (action === "remove" && provider.endsWith("-api")) {
        await window.pyxis.keys.remove(vendorOf(provider));
        setResult(t("engines.keyRemoved"));
        return;
      }
      if (action === "update") {
        const value = await invoke("engines.update", { provider });
        setResult(t(value.changed ? "engines.updated" : "engines.upToDate", { version: value.version }));
        return;
      }
      await invoke(action === "logout" ? "engines.logout" : "engines.remove", { provider });
      setResult(t(action === "logout" ? "engines.signedOut" : "engines.removed"));
    },
    onSuccess: refresh,
  });
  function openDetails(row: Engine) {
    const selection =
      features.data?.default?.provider === row.id
        ? features.data.default
        : Object.values(features.data ?? {}).find((value) => value.provider === row.id);
    setSelectedModel(selection?.model ?? modelsByProvider[row.id]?.[0]?.id ?? "");
    setEffort(studentEffort(selection));
    setFast(selection?.fast ?? false);
    setDetails(row.id);
    setResult(null);
    test.reset();
    manage.reset();
  }
  /** Opens the install and sign-in of a tool. One the student turned off is in use again: connecting it says so. */
  function connect(row: Engine) {
    if (!isInstallable(row.id)) return;
    if (allowed !== null && !allowed.includes(row.id)) {
      const next = toggledUse(allowed, ready, row.id, true);
      if (next !== undefined) choose.mutate(next);
    }
    setSetupFor(row.id);
  }
  function runTest(row: Engine) {
    setResult(null);
    manage.reset();
    // The row's test only checks that the engine answers, so core runs it on the cheapest model. The details dialog
    // tests the model the student picks there.
    withNotice(row.id, () => test.mutate({ provider: row.id }));
  }
  /** Opens the sign-in for an engine whose test was refused, from the message that says so. */
  function signInAgain(provider: string) {
    test.reset();
    setDetails(null);
    if (isInstallable(provider)) setSetupFor(provider);
  }
  async function signOut(row: Engine) {
    const answer = await confirm({
      title: t("engines.signOutConfirm.title", { name: row.name }),
      body: t("engines.signOutConfirm.body", { name: row.name }),
      confirm: t("engines.disconnect"),
    });
    if (answer !== "confirm") return;
    setResult(null);
    test.reset();
    manage.mutate({ provider: row.id, action: "logout" });
  }
  async function remove(row: Engine) {
    const answer = await confirm({
      title: row.kind === "api" ? t("engines.removeKey") : t("engines.clearChoices", { name: row.name }),
      body: t("engines.removeConfirm"),
      confirm: t("engines.remove"),
      tone: "danger",
    });
    if (answer !== "confirm") return;
    test.reset();
    setDetails(null);
    manage.mutate({ provider: row.id, action: "remove" });
  }
  async function saveKey() {
    if (keyBusy || !keyValue.trim()) return;
    setKeyBusy(true);
    try {
      await window.pyxis.keys.set(keyProvider, keyValue.trim());
      setKeyValue("");
      setAddingKey(false);
      refresh();
      setResult(t("engines.keySaved"));
      const provider = `${keyProvider}-api`;
      withNotice(provider, () => test.mutate({ provider }));
    } catch {
      setResult(t("engines.keyFailed"));
    } finally {
      setKeyBusy(false);
    }
  }
  const pinnedCount = featureNames.filter(
    (feature) => features.data?.[feature] && !features.data[feature]!.auto,
  ).length;
  // Returning to automatic also undoes efforts the student picked on tasks Pyxis chose the model for.
  const customised =
    pinnedCount > 0 || featureNames.some((feature) => !!features.data?.[feature]?.effortChoice);
  const toAcknowledge = unacknowledged(readyRows);
  const toAcknowledgeKey = toAcknowledge.map((row) => row.id).join(",");
  useEffect(() => {
    // Not while the list reloads after a confirmation, or the notice would come straight back.
    if (!noticeLater && !notice && toAcknowledgeKey && !overview.isFetching) setNotice({ engines: toAcknowledge });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticeLater, notice, toAcknowledgeKey, overview.isFetching]);
  // A local model the student turned on is an engine too.
  const nothingReady = overview.isSuccess && !readyRows.some(inUse) && !local.data?.enabled;

  // A move made from a row's menu is said here; a drag is announced by the list itself.
  const [said, setSaid] = useState("");
  function move(from: number, to: number) {
    const moved = connected[from];
    if (!moved || to < 0 || to >= connected.length || from === to) return;
    reorder.mutate(
      movedOrder(
        connected.map((row) => row.id),
        from,
        to,
        order,
      ),
    );
    return moved;
  }
  function moveByMenu(from: number, to: number) {
    const moved = move(from, to);
    if (moved) setSaid(t("engines.order.dropped", { name: moved.name, position: to + 1, count: connected.length }));
  }
  function setUse(row: Engine, use: boolean) {
    const next = toggledUse(allowed, ready, row.id, use);
    if (next !== undefined) choose.mutate(next);
  }
  /** The actions a tool shares in the list and under Advanced: test it, use it or not, open its details. */
  function sharedItems(row: Engine): NonNullable<ToolMenu["items"]> {
    const using = inUse(row);
    // One tool has to stay in use, and the list of the keyed ones has to be read before a tool can be left out.
    const last = using && toggledUse(allowed, ready, row.id, false) === undefined;
    return [
      { key: "test", label: t("engines.test"), disabled: test.isPending || manage.isPending },
      {
        key: "use",
        label: t(using ? "engines.tool.stopUsing" : "engines.tool.useAgain"),
        disabled: choose.isPending || manual.state !== "ready" || last,
      },
      { key: "details", label: t("engines.details") },
    ];
  }
  function sharedChoice(row: Engine, key: string) {
    if (key === "test") runTest(row);
    if (key === "use") setUse(row, !inUse(row));
    if (key === "details") openDetails(row);
  }
  function stateOf(row: Engine): Tool["state"] {
    if (!inUse(row)) return { tone: "idle", text: t("engines.tool.off") };
    if (isLimited(row)) return { tone: "warn", text: t("engines.state.outOfRequests") };
    if (row.refusedModels.length) return { tone: "warn", text: t("engines.state.limited") };
    return { tone: "ok", text: t("engines.state.connected") };
  }
  const isLimited = (row: Engine) => !!row.limitedUntil && row.limitedUntil > Date.now();
  /**
   * The line under a tool's name: the program the student installed, then the models it works on. A tool that is out
   * of requests says when they are back instead, which is what the student needs to know about it now.
   */
  const detailOfTool = (row: Engine) =>
    inUse(row) && isLimited(row)
      ? limitText(t, i18n.language, row.limitedUntil!)
      : [
          row.kind === "cli" ? TOOL_PROGRAMS[row.id] : undefined,
          names.modelsLine(row.id, features.data, row.refusedModels, inUse(row)) || row.version,
        ]
          .filter(Boolean)
          .join(" · ") || row.id;
  const workingOn = (row: Engine) =>
    test.isPending && test.variables?.provider === row.id
      ? t("engines.testing")
      : manage.isPending && manage.variables?.provider === row.id && manage.variables.action === "logout"
        ? t("engines.disconnecting")
        : undefined;
  // The place of each tool among the ones in use, shown once the student has set an order.
  let place = 0;
  const tools: Tool[] = connected.map((row, index) => {
    const using = inUse(row);
    if (using) place += 1;
    return {
      id: row.id,
      name: row.name,
      detail: detailOfTool(row),
      position: order && using ? place : undefined,
      state: stateOf(row),
      working: workingOn(row),
      off: !using,
      menu: {
        items: [
          ...sharedItems(row),
          { type: "divider" },
          { key: "up", label: t("engines.order.up"), disabled: index === 0 || reorder.isPending },
          {
            key: "down",
            label: t("engines.order.down"),
            disabled: index === connected.length - 1 || reorder.isPending,
          },
        ],
        onClick: ({ key }) => {
          if (key === "up") moveByMenu(index, index - 1);
          else if (key === "down") moveByMenu(index, index + 1);
          else sharedChoice(row, key);
        },
      },
      action: row.capabilities.signOut ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("engines.disconnectNamed", { name: row.name })}
          disabled={manage.isPending}
          onClick={() => void signOut(row)}
        >
          {t("engines.disconnect")}
        </Button>
      ) : undefined,
    };
  });

  // A failed test names its engine, and a refused sign-in offers to sign in again right here.
  const tested = overview.data?.find((row) => row.id === test.variables?.provider);
  const testKey = messageKey(test.error);
  const feedback = (
    <>
      {result ? (
        <p className="small engines-result" role="status">
          {typeof result === "string"
            ? result
            : t("engines.tested", {
                ms: result.ms,
                // The list Settings already read names the model even before the names query has refreshed.
                model:
                  modelsByProvider[result.provider]?.find((row) => row.id === result.model)?.name ??
                  names.modelName(result.provider, result.model),
                tokens: result.tokens,
              })}
        </p>
      ) : null}
      {test.error && tested ? (
        <Notice
          tone="danger"
          details={detailOf(test.error)}
          action={
            testKey === "engines.errors.not-logged-in" && isInstallable(tested.id)
              ? {
                  label: t("engines.signInTo", { name: tested.name }),
                  onClick: () => signInAgain(tested.id),
                }
              : undefined
          }
        >
          {testMessage(t, testKey, tested.name)}
        </Notice>
      ) : test.error || manage.error ? (
        <Notice tone="danger" details={detailOf(test.error ?? manage.error)}>
          {t(messageKey(test.error ?? manage.error))}
        </Notice>
      ) : null}
    </>
  );
  const connectedTitle = useId();
  const toConnectTitle = useId();
  const keyRowId = useId();
  return (
    <div className="engines-panel">
      <section className="px-ctl-group" aria-labelledby={connectedTitle}>
        <div className="engines-heading">
          <h2 className="px-ctl-group-title" id={connectedTitle}>
            {t("engines.connected.title")}
          </h2>
          {/* Shown once there is an order to give up: Pyxis then shares the work among the tools as before. */}
          {order && connected.length > 1 ? (
            <Button variant="ghost" size="sm" disabled={reorder.isPending} onClick={() => reorder.mutate(null)}>
              {t("engines.order.reset")}
            </Button>
          ) : null}
        </div>
        {connected.length > 1 ? (
          <p className="px-ctl-group-hint">{t(order ? "engines.order.hint" : "engines.order.hintShared")}</p>
        ) : null}
        {overview.isPending ? <Working className="engines-loading" line={t("engines.loading")} /> : null}
        {overview.isError ? <Notice tone="danger">{t("engines.loadFailed")}</Notice> : null}
        {connected.length > 0 ? (
          <ToolList tools={tools} disabled={reorder.isPending} onMove={(from, to) => void move(from, to)} />
        ) : overview.isSuccess ? (
          <p className="engines-empty">{t("engines.connected.none")}</p>
        ) : null}
        <p className="visually-hidden" role="status">
          {said}
        </p>
        {reorder.isError || choose.isError ? <Notice tone="danger">{t("engines.order.failed")}</Notice> : null}
        {pinnedCount > 0 && connected.length > 0 ? (
          <p className="small engines-hint">{t("engines.auto.pinned", { count: pinnedCount })}</p>
        ) : null}
        {!details && !addingKey ? feedback : null}
      </section>

      {toConnect.length > 0 ? (
        <section className="px-ctl-group" aria-labelledby={toConnectTitle}>
          <h2 className="px-ctl-group-title" id={toConnectTitle}>
            {t("engines.toConnect.title")}
          </h2>
          <ControlList>
            {toConnect.map((row) => {
              const status = engineStatus(row);
              return (
                <ControlRow
                  key={row.id}
                  id={`engines-connect-${row.id}`}
                  title={row.name}
                  description={
                    row.disabled ? (
                      <>
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
                      </>
                    ) : isInstallable(row.id) ? (
                      t(`setup.plan.${row.id}`)
                    ) : undefined
                  }
                >
                  {/* Installed but signed out, or a sign-in the provider refused: the row says which. */}
                  {row.installed && !row.disabled ? (
                    <span className={`engines-tool-state is-${status.tone === "error" ? "warn" : status.tone}`}>
                      {t(status.label)}
                    </span>
                  ) : null}
                  {row.disabled ? null : (
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={t(row.installed ? "engines.signInTo" : "engines.toConnect.installNamed", {
                        name: row.name,
                      })}
                      onClick={() => connect(row)}
                    >
                      {t(row.installed ? "engines.signIn" : "engines.toConnect.install")}
                    </Button>
                  )}
                </ControlRow>
              );
            })}
          </ControlList>
          {nothingReady ? (
            <p className="small engines-hint">
              {t("engines.installHelp")}{" "}
              <a
                href={offersPage(i18n.language)}
                onClick={(event) => {
                  event.preventDefault();
                  void window.pyxis.openExternal(offersPage(i18n.language));
                }}
              >
                {t("onboarding.engines.offersLink")}
              </a>
            </p>
          ) : null}
        </section>
      ) : null}

      <details
        className="engines-advanced"
        open={advanced}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          if (open !== advanced) setAdvanced(open);
        }}
      >
        <summary>
          {t("engines.advanced")}
        </summary>
        <div className="engines-advanced-body">
          <LocalModelCard place="settings" />
          <ControlList>
            <li>
              <div className="px-ctl-row">
                <span className="engines-lead" aria-hidden>
                  <KeyRound size={20} strokeWidth={1.75} />
                </span>
                <div className="px-ctl-text">
                  <span className="px-ctl-title" id={keyRowId}>
                    {t("engines.apiKey")}
                  </span>
                  <span className="px-ctl-description">
                    {keys.isPending
                      ? t("engines.checkingKeyring")
                      : keys.data?.canSave
                        ? t("engines.key.hint")
                        : t("engines.keyringUnavailable")}
                  </span>
                </div>
                {keys.data?.canSave ? (
                  <Button variant="secondary" size="sm" onClick={() => setAddingKey(true)}>
                    {t("engines.key.add")}
                  </Button>
                ) : null}
              </div>
            </li>
            {keyed.map((row) => {
              const menu: ToolMenu = {
                items: [
                  ...sharedItems(row),
                  { type: "divider" },
                  { key: "remove", label: t("engines.removeKey"), danger: true },
                ],
                onClick: ({ key }) => (key === "remove" ? void remove(row) : sharedChoice(row, key)),
              };
              const region = t("engines.tool.actions", { name: row.name });
              const working = workingOn(row);
              const state = stateOf(row);
              return (
                <MenuItemArea key={row.id} menu={menu} region={region} data-tool={row.id}>
                  <div className="px-ctl-row">
                    <span className="engines-lead" aria-hidden />
                    <div className="px-ctl-text">
                      <span className="px-ctl-title">{row.name}</span>
                      <span className="px-ctl-description">{detailOfTool(row)}</span>
                    </div>
                    {working ? (
                      <Working className="engines-tool-working" line={working} />
                    ) : (
                      <span className={`engines-tool-state is-${row.refused ? "warn" : state.tone}`}>
                        {row.refused || !row.loggedIn ? t(engineStatus(row).label) : state.text}
                      </span>
                    )}
                    <MenuButton size="sm" menu={menu} label={region} />
                  </div>
                </MenuItemArea>
              );
            })}
          </ControlList>
          <EngineTasks
            features={features.data}
            overview={overview.data}
            modelsByProvider={modelsByProvider}
            choices={choices}
            labelOf={(provider, model) => `${engineName(provider)} · ${names.modelName(provider, model)}`}
            busy={configure.isPending || automatic.isPending || setEffortFor.isPending}
            customised={customised}
            visionWarning={visionCapability.data?.warning}
            onModel={(feature, value, picked) => {
              const [provider] = JSON.parse(value) as [string, string];
              withNotice(provider, () => configure.mutate({ feature, value, effort: picked }));
            }}
            onEffort={(feature, picked) => setEffortFor.mutate({ feature, effort: picked })}
            onAutomatic={(feature) => automatic.mutate(feature)}
          />
          <DebugSwitch />
          <details className="engines-diagnostics">
            <summary>
              {t("engines.diagnostics")}
            </summary>
            <div className="engines-diagnostics-scroll" tabIndex={0} aria-label={t("engines.diagnostics")}>
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
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td>{row.version || t("engines.notDetected")}</td>
                      <td>
                        <code>{row.path || t("engines.notDetected")}</code>
                      </td>
                      <td>{t(engineStatus(row).label)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small">{t("engines.searchFoldersUnavailable")}</p>
          </details>
        </div>
      </details>
      {/* In either view: "Use as default" in a tool's details fails here too. */}
      {configure.error || automatic.error || setEffortFor.error ? (
        <Notice tone="danger">{t(messageKey(configure.error ?? automatic.error ?? setEffortFor.error))}</Notice>
      ) : null}
      {/* The week's tokens are a technical detail, shown in debug mode. */}
      {debug.data?.on ? <EngineUsage /> : null}
      <p className="small engines-terms" id="engine-terms">
        {disclosureText({ t, language: i18n.language, features: features.data })} {t("engines.terms")}{" "}
        {t("engines.termsDetail")}
      </p>

      <Dialog
        open={details !== null}
        width="md"
        title={engine?.name ?? t("engines.details")}
        // The program behind the tool, quietly under its name; it stays out of the dialog's name.
        description={engine?.kind === "cli" ? TOOL_PROGRAMS[engine.id] : undefined}
        cancel={t("dialog.close")}
        onClose={() => setDetails(null)}
        enterConfirms={false}
        actions={
          engine && !engine.disabled
            ? [
                {
                  label: t("engines.test"),
                  tone: "secondary",
                  disabled: !selectedModel || test.isPending,
                  working: test.isPending,
                  onClick: () =>
                    withNotice(engine.id, () =>
                      test.mutate({
                        provider: engine.id,
                        model: selectedModel,
                        effort: engine.capabilities.effort ? effort : undefined,
                        fast: engine.capabilities.fast && model?.fast ? fast : undefined,
                      }),
                    ),
                },
                {
                  label: t("engines.useDefault"),
                  disabled: !selectedModel || configure.isPending,
                  onClick: () =>
                    withNotice(engine.id, () =>
                      configure.mutate({
                        feature: "default",
                        value: JSON.stringify([engine.id, selectedModel]),
                        effort: engine.capabilities.effort ? effort : undefined,
                        fast: engine.capabilities.fast && model?.fast ? fast : undefined,
                      }),
                    ),
                },
              ]
            : []
        }
      >
        {engine?.disabled ? (
          <Notice tone="info">{t("engines.disabled")}</Notice>
        ) : engine ? (
          <div className="engines-details">
            <ControlList>
              <ControlRow id="engine-detail-model-row" title={t("engines.model")}>
                <select
                  id="engine-detail-model"
                  className="px-ctl-field"
                  aria-labelledby="engine-detail-model-row"
                  value={selectedModel}
                  onChange={(event) => {
                    const value = event.target.value;
                    setSelectedModel(value);
                    // Keep the pick only where the new model offers it; otherwise the task's own level applies.
                    setEffort(
                      models.find((item) => item.id === value)?.efforts.some((option) => option.id === effort)
                        ? effort
                        : undefined,
                    );
                    setFast(false);
                  }}
                >
                  {models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </ControlRow>
              {engine.capabilities.effort && !!model?.efforts.length ? (
                <ControlRow id="engine-detail-effort-row" title={t("engines.effort")}>
                  <select
                    id="engine-detail-effort"
                    className="px-ctl-field"
                    aria-labelledby="engine-detail-effort-row"
                    value={effort ?? ""}
                    onChange={(event) => setEffort(event.target.value || undefined)}
                  >
                    <option value="">{t("engines.effortDefault")}</option>
                    {model.efforts.map((option) => (
                      <option key={option.id} value={option.id}>
                        {levelLabel(option.id)}
                      </option>
                    ))}
                  </select>
                </ControlRow>
              ) : null}
              {engine.capabilities.fast && model?.fast ? (
                <SwitchRow title={t("engines.fast")} checked={fast} onChange={setFast} />
              ) : null}
            </ControlList>
            {feedback}
            <div className="engines-actions">
              {engine.kind === "cli" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!engine.installed || manage.isPending}
                  onClick={() => manage.mutate({ provider: engine.id, action: "update" })}
                >
                  {t("engines.update")}
                </Button>
              ) : null}
              <Button variant="danger" size="sm" disabled={manage.isPending} onClick={() => void remove(engine)}>
                {engine.kind === "api" ? t("engines.removeKey") : t("engines.clearChoices", { name: engine.name })}
              </Button>
            </div>
            {engine.kind === "cli" && !engine.capabilities.signOut ? (
              <p className="small engines-hint">{t("engines.signOutUnsupported")}</p>
            ) : null}
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={addingKey}
        width="md"
        title={t("engines.key.add")}
        description={t("engines.key.hint")}
        busy={keyBusy}
        onClose={() => {
          setAddingKey(false);
          setKeyValue("");
        }}
        actions={[
          {
            label: t("engines.saveAndTest"),
            disabled: !keyValue.trim() || keyBusy,
            working: keyBusy,
            onClick: () => void saveKey(),
          },
        ]}
      >
        <ControlList>
          <ControlRow id="engine-key-provider-row" title={t("engines.provider")}>
            <select
              id="engine-key-provider"
              className="px-ctl-field"
              aria-labelledby="engine-key-provider-row"
              value={keyProvider}
              onChange={(event) => setKeyProvider(event.target.value as "anthropic" | "openai")}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
            </select>
          </ControlRow>
          <ControlRow id="engine-api-key-row" title={t("engines.apiKey")}>
            <input
              id="engine-api-key"
              className="px-ctl-field"
              type="password"
              autoComplete="off"
              aria-labelledby="engine-api-key-row"
              value={keyValue}
              onChange={(event) => setKeyValue(event.target.value)}
            />
          </ControlRow>
        </ControlList>
      </Dialog>
      <Dialog
        open={setupFor !== null}
        width="md"
        title={t("setup.title", {
          name: overview.data?.find((row) => row.id === shownSetup)?.name ?? shownSetup ?? "",
        })}
        // Installing and signing in start from the buttons inside, so the dialog only closes.
        cancel={t("dialog.close")}
        onClose={() => setSetupFor(null)}
      >
        {shownSetup ? (
          <ProviderSetup
            provider={shownSetup}
            row={overview.data?.find((row) => row.id === shownSetup)}
            onChanged={refresh}
            titled={false}
          />
        ) : null}
      </Dialog>
      <EngineNoticeDialog
        engines={notice?.engines ?? []}
        onDone={() => {
          const then = notice?.then;
          setNotice(null);
          then?.();
        }}
        onLater={() => {
          setNotice(null);
          setNoticeLater(true);
        }}
      />
    </div>
  );
}
