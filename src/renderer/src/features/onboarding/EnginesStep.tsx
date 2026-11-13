import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { CircleCheck, SlidersHorizontal } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import {
  installCommand,
  installers,
  isInstallable,
  offersPage,
  type InstallableProvider,
} from "@shared/installers";
import { TOOL_NAMES } from "@shared/tool-names";
import {
  EngineNoticePanel,
  unacknowledged,
} from "../../components/EngineNotice";
import { EngineRow } from "../../components/EngineRow";
import { EngineUseChoice, engineBox } from "../../components/EngineUseChoice";
import { LocalModelCard, useLocalModel } from "../../components/LocalModel";
import { Notice } from "../../components/Notice";
import { useProviderSetup } from "../../components/ProviderSetup";
import {
  engineStatus,
  keyStatus,
  manualChoice,
} from "../../lib/engineStatus";
import { useEngineNames } from "../../lib/useEngineNames";
import { invoke } from "../../lib/ipc";
import { useEngineSetup } from "../settings/useEngineSetup";
import "../settings/EnginesPanel.css";

type Engine = RequestOutput<"engines.overview">[number];

/**
 * The AI tools setup offers, named after the account the student has rather than the program Pyxis runs (`TOOL_NAMES`,
 * the same names as in Settings): Codex is ChatGPT, Antigravity is Gemini, Cursor Agent is Cursor.
 */
const tools = [
  { engine: "claude", name: TOOL_NAMES.claude!, copy: "claude" },
  { engine: "codex", name: TOOL_NAMES.codex!, copy: "chatgpt" },
  { engine: "antigravity", name: TOOL_NAMES.antigravity!, copy: "gemini" },
  { engine: "agent", name: TOOL_NAMES.agent!, copy: "cursor" },
] as const satisfies ReadonlyArray<{
  engine: InstallableProvider;
  name: string;
  copy: string;
}>;
type Tool = (typeof tools)[number];

/** The name setup shows for an engine: the tool's name for a CLI, the engine's own for an API key. */
function toolName(row: Pick<Engine, "id" | "name">): string {
  return tools.find((tool) => tool.engine === row.id)?.name ?? row.name;
}

/** What the page needs to know about the step: its buttons and title follow it. */
export type EnginesState = {
  /** Some engine is ready and confirmed, or the local model is on. Null until the engines are read. */
  ready: boolean | null;
  /** The notice of what leaves this computer waits for "I understand", the step's primary action then. */
  notice: boolean;
  /** A tool's card offers install or sign-in as the step's primary action. */
  picking: boolean;
  /** The tools that are connected, by name, for the title. */
  connected: string[];
};

/**
 * The AI step of setup: one card per tool with its real state (connected, not connected, sign-in needed or expired).
 * Picking a card offers "Install and sign in" there, and what the install or sign-in needs next (the command it runs,
 * its output, a code, a terminal) shows below the cards. With an engine connected, the other cards offer to connect
 * one more. "Advanced" holds which engines Pyxis may use, the model each one gets and the local model. The step never
 * calls a model: core picks the models (`engines.autoConfigure`). On a rerun (`again`) the engines the student already
 * set up stay as they are: Pyxis recomputes the automatic choices only if the set of ready engines changes while the
 * screen is open.
 */
export function EnginesStep({
  onState,
  again = false,
}: {
  onState: (state: EnginesState) => void;
  again?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const { overview, features, choice, choose, refresh } = useEngineSetup();
  const engineNames = useEngineNames();
  const [picked, setPicked] = useState<InstallableProvider | null>(null);
  const [advanced, setAdvanced] = useState<boolean | null>(null);
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
  // Every engine the student can tick: the CLIs and each API provider with a saved key (a rerun of setup can have one).
  const keys = useQuery({
    queryKey: ["engine-key-status"],
    queryFn: () => window.pyxis.keys.status(),
  });
  // Until the keys are read, "I choose" waits: a pick without the keyed API engines would drop them and their tasks.
  const manual = manualChoice(
    [...cliRows, ...rows.filter((row) => row.kind === "api")],
    keyStatus(keys),
  );
  const pickable = manual.rows;
  const usableKey = usable.map((row) => row.id).join(",");
  // One notice for every engine Pyxis may use, shown here so no task ever has to ask.
  const toAcknowledge = unacknowledged(rows);
  const noticeOpen = toAcknowledge.length > 0;
  // An installed engine that still needs a sign-in is most likely the one the student uses, so it is offered first.
  const signedOut =
    installedCli.find((row) => !row.loggedIn && row.allowed)?.id ?? null;
  const engine =
    picked ?? (overview.isSuccess && usable.length === 0 ? signedOut : null);
  const connected = (row: Engine | undefined) =>
    !!row && row.installed && row.loggedIn && !row.refused;
  const connectedNames = tools
    .filter((tool) => connected(rows.find((row) => row.id === tool.engine)))
    .map((tool) => tool.name);
  // The picked card's own button is the step's primary action until an engine is ready.
  const pickPrimary = usable.length === 0 && !localOn && !noticeOpen;
  const picking =
    engine !== null && !connected(rows.find((row) => row.id === engine));

  const ready = overview.isSuccess
    ? (usableKey !== "" || localOn) && toAcknowledge.length === 0
    : null;
  // The names travel as one string, so the page hears a change once rather than on every render.
  const connectedKey = connectedNames.join("\n");
  useEffect(() => {
    onState({
      ready,
      notice: noticeOpen,
      picking,
      connected: connectedKey ? connectedKey.split("\n") : [],
    });
  }, [ready, noticeOpen, picking, connectedKey, onState]);

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

  const names = (list: string[]) =>
    new Intl.ListFormat(i18n.language.startsWith("it") ? "it" : "en-GB", {
      style: "long",
      type: "conjunction",
    }).format(list);
  let found: string | null = null;
  if (overview.isSuccess) {
    if (readyRows.length > 0) {
      found = t("onboarding.engines.found", {
        names: names(readyRows.map(toolName)),
      });
    } else if (installedCli.length > 0) {
      found = t("onboarding.engines.foundSignedOut", {
        names: names(installedCli.map(toolName)),
      });
    } else {
      found = t("onboarding.engines.foundNone");
    }
  }

  // The picked card's button goes into the card, and the rest of its setup below the cards.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const openOffers = () =>
    void window.pyxis.openExternal(offersPage(i18n.language));
  const advancedOpen = advanced ?? (allowed !== null || localOn);
  const advancedId = useId();

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
      {/* The cards show the same thing; this line tells a screen reader what was found once the engines are read. */}
      <p className="visually-hidden" role="status">
        {found ?? ""}
      </p>
      {overview.isSuccess ? (
        <ul className="px-tools" aria-label={t("onboarding.ai.listLabel")}>
          {tools.map((tool) => {
            const row = rows.find((item) => item.id === tool.engine);
            const isPicked = engine === tool.engine;
            return (
              <ToolCard
                key={tool.engine}
                tool={tool}
                row={row}
                done={connected(row)}
                picked={isPicked}
                others={connectedNames.length > 0}
                onPick={() => setPicked(tool.engine)}
                onPlans={openOffers}
                slotRef={isPicked ? setSlot : undefined}
              />
            );
          })}
        </ul>
      ) : null}
      <div ref={setPanel} className="px-tool-panel-slot" />
      {engine ? (
        <PickedTool
          key={engine}
          tool={tools.find((tool) => tool.engine === engine)!}
          row={rows.find((row) => row.id === engine)}
          onChanged={refresh}
          primary={pickPrimary}
          slot={slot}
          panel={panel}
        />
      ) : null}
      {noticeOpen ? (
        <ScrollIntoView>
          <EngineNoticePanel
            engines={toAcknowledge.map((row) => ({
              ...row,
              name: toolName(row),
            }))}
            onDone={() =>
              void client.invalidateQueries({ queryKey: ["engines"] })
            }
          />
        </ScrollIntoView>
      ) : null}
      {usable.length === 0 ? (
        <p className="small engines-hint">
          {t("onboarding.engines.disclosure")}
        </p>
      ) : null}
      {overview.isSuccess ? (
        <div className="px-onboarding-advanced">
          <Button
            type="text"
            className="px-onboarding-advanced-toggle"
            icon={<SlidersHorizontal size={16} aria-hidden />}
            aria-expanded={advancedOpen}
            aria-controls={advancedId}
            onClick={() => setAdvanced(!advancedOpen)}
          >
            {t("onboarding.ai.advanced")}
          </Button>
          {advancedOpen ? (
            <div
              className="px-onboarding-advanced-body px-grow"
              id={advancedId}
            >
              <EngineUseChoice
                allowed={allowed}
                rows={pickable.map((row) => ({ ...row, name: toolName(row) }))}
                keys={manual.state}
                onRetryKeys={() => void keys.refetch()}
                disabled={choose.isPending || choice.isPending}
                onChange={(next) => choose.mutate(next)}
              />
              <div
                className="engines-list"
                role="list"
                aria-label={t("onboarding.engines.listLabel")}
              >
                {pickable.map((row) => {
                  const status = engineStatus(row);
                  return (
                    <div role="listitem" key={row.id}>
                      <EngineRow
                        kind={row.kind}
                        name={toolName(row)}
                        model={engineNames.modelsLine(
                          row.id,
                          features.data,
                          row.refusedModels,
                          row.allowed,
                        )}
                        status={status.tone}
                        statusText={t(status.label)}
                        use={engineBox(
                          allowed,
                          row.id,
                          (next) => choose.mutate(next),
                          choose.isPending,
                        )}
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
              <LocalModelCard place="onboarding" />
              <p className="small px-onboarding-note">
                {t("onboarding.ai.apiKeyLater", {
                  section: t("settings.pages.engines"),
                })}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One tool: its name, what account it needs, a link to the plans and its state, with the picked card's button. */
function ToolCard({
  tool,
  row,
  done,
  picked,
  others,
  onPick,
  onPlans,
  slotRef,
}: {
  tool: Tool;
  row: Engine | undefined;
  done: boolean;
  picked: boolean;
  /** Another tool is connected, so this one is offered as a second. */
  others: boolean;
  onPick: () => void;
  onPlans: () => void;
  slotRef?: (element: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  const status = row ? engineStatus(row) : null;
  // A tool that is installed but needs a sign-in, or whose sign-in expired, says so in the words of the engine list.
  const state = done
    ? t("onboarding.ai.state.connected")
    : status && status.fix === "signIn"
      ? t(status.label)
      : others
        ? t("onboarding.ai.state.more")
        : t("onboarding.ai.state.off");
  const className = [
    "px-tool",
    picked && !done ? "is-picked" : "",
    done ? "is-done" : "",
    !done && others && status?.fix !== "signIn" ? "is-more" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <li className={className}>
      <h2 className="px-tool-name">
        {done ? (
          tool.name
        ) : (
          <button
            type="button"
            className="px-tool-pick"
            aria-pressed={picked}
            onClick={onPick}
          >
            {tool.name}
          </button>
        )}
      </h2>
      <div className="px-tool-desc">
        {done ? (
          <p>
            {t("onboarding.ai.signedInWith", {
              account: tool.engine === "antigravity" ? "Google" : tool.name,
            })}
          </p>
        ) : (
          <>
            <p>{t(`onboarding.ai.tools.${tool.copy}`)}</p>
            {tool.copy === "gemini" ? (
              <p className="px-tool-free">
                {t("onboarding.ai.tools.geminiFree")}
              </p>
            ) : null}
          </>
        )}
      </div>
      {done ? (
        <span />
      ) : (
        <button
          type="button"
          className="px-tool-plans"
          aria-label={t("onboarding.ai.plansOf", { name: tool.name })}
          onClick={onPlans}
        >
          {t("onboarding.ai.plans")}
        </button>
      )}
      <div className="px-tool-action" ref={slotRef} />
      <span className="px-tool-state">
        {done ? <CircleCheck size={16} aria-hidden /> : null}
        {state}
      </span>
    </li>
  );
}

/**
 * Install and sign-in for the picked tool. Its main button and status go into the card, through `slot`; the command,
 * the installer's output, a code to paste, terminal steps and failures go below the cards, through `panel`, and grow
 * from the card. Keyed by engine, so picking another tool cancels a sign-in still pending, as closing it did before.
 */
function PickedTool({
  tool,
  row,
  onChanged,
  primary,
  slot,
  panel,
}: {
  tool: Tool;
  row: Engine | undefined;
  onChanged: () => void;
  primary: boolean;
  slot: HTMLElement | null;
  panel: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const provider = tool.engine;
  const setup = useProviderSetup(provider, row, onChanged, tool.name);
  const { install, signIn, installed, signedIn, terminalSignIn } = setup;
  const titleId = useId();
  const [origin, setOrigin] = useState<string | undefined>();
  // The panel grows from the card above it.
  useLayoutEffect(() => {
    const card = slot?.closest(".px-tool");
    if (!card || !panel) return;
    const from = card.getBoundingClientRect();
    const to = panel.getBoundingClientRect();
    setOrigin(`${Math.round(from.left + from.width / 2 - to.left)}px 0`);
  }, [slot, panel]);
  if (signedIn) return null;

  let action: ReactNode = null;
  if (install.state === "running") {
    action = (
      <>
        <p className="small" role="status">
          {t("setup.install.running", { name: tool.name })}
        </p>
        <Button shape="round" size="small" onClick={install.cancel}>
          {t("engines.cancel")}
        </Button>
      </>
    );
  } else if (signIn.waiting) {
    action = (
      <Button type="text" shape="round" size="small" onClick={signIn.cancel}>
        {t("engines.cancel")}
      </Button>
    );
  } else if (!installed) {
    action = (
      <>
        <Button
          type={primary ? "primary" : "default"}
          shape="round"
          onClick={() => void install.run()}
        >
          {t("onboarding.ai.installAndSignIn")}
        </Button>
        <span className="small">
          {t(
            terminalSignIn
              ? "onboarding.ai.terminalNote"
              : "onboarding.ai.opensPage",
            { vendor: setup.vendor },
          )}
        </span>
      </>
    );
  } else {
    action = (
      <>
        <Button
          type={primary ? "primary" : "default"}
          shape="round"
          onClick={() =>
            void (terminalSignIn ? setup.openAntigravity() : signIn.start())
          }
        >
          {terminalSignIn
            ? t("onboarding.ai.terminalSignIn")
            : t("setup.signIn.action", { account: setup.account })}
        </Button>
        <span className="small">
          {t(
            terminalSignIn
              ? "onboarding.ai.terminalNote"
              : "onboarding.ai.opensPage",
            { vendor: setup.vendor },
          )}
        </span>
      </>
    );
  }

  // Below the cards: whatever the install or the sign-in needs explained, and nothing once it has nothing to say.
  const details: ReactNode[] = [];
  if (!installed && install.state === "idle")
    details.push(
      <div key="command" className="px-tool-command">
        <p className="small">
          {t("setup.install.body", { vendor: setup.vendor })}
        </p>
        <code className="code px-setup-command">
          {installCommand(provider, window.pyxis.platform)}
        </code>
      </div>,
    );
  if (install.state === "running" && install.line)
    details.push(
      <p key="line" className="meta px-setup-log">
        {install.line}
      </p>,
    );
  if (install.state === "failed")
    details.push(
      <Notice
        key="install-failed"
        tone="danger"
        details={install.detail || undefined}
        action={{
          label: t("setup.install.retry"),
          onClick: () => void install.run(),
        }}
        secondary={{
          label: t("setup.install.page", { vendor: setup.vendor }),
          onClick: () =>
            void window.pyxis.openExternal(installers[provider].page),
        }}
      >
        {t("setup.install.failed", { name: tool.name })}
      </Notice>,
    );
  if (installed && terminalSignIn)
    details.push(
      <div key="terminal-howto">
        <ol className="px-setup-howto small">
          <li>{t("onboarding.ai.terminal.open")}</li>
          <li>{t("setup.antigravity.choose")}</li>
          <li>{t("setup.antigravity.browser")}</li>
          <li>{t("setup.antigravity.back")}</li>
        </ol>
        {setup.terminalNote ? (
          <div className="px-setup-terminal">
            <p className="small">{setup.terminalNote}</p>
            <code className="code px-setup-command">agy</code>
          </div>
        ) : null}
      </div>,
    );
  if (signIn.waiting && signIn.url)
    details.push(
      <div key="reopen" className="px-setup-actions">
        <Button
          shape="round"
          onClick={() => void window.pyxis.openExternal(signIn.url!)}
        >
          {t("setup.signIn.reopen")}
        </Button>
      </div>,
    );
  if (signIn.codeForm) details.push(<div key="code">{signIn.codeForm}</div>);
  if (signIn.terminal && !terminalSignIn)
    details.push(
      <div key="terminal" className="px-setup-terminal">
        <p className="small">{t("engines.terminalInstructions")}</p>
        <code className="code px-setup-command">{signIn.terminal}</code>
      </div>,
    );
  if (signIn.failed)
    details.push(
      <Notice
        key="signin-failed"
        tone="danger"
        details={signIn.detail || undefined}
      >
        {t("engines.signInFailed")}
      </Notice>,
    );

  return (
    <>
      {slot
        ? createPortal(
            <div className="px-tool-action-body px-grow">
              {action}
              {/* Always present, so screen readers announce each new sign-in status. */}
              <p className="small" role="status">
                {signIn.status ?? ""}
              </p>
            </div>,
            slot,
          )
        : null}
      {panel && details.length
        ? createPortal(
            <section
              className="px-tool-panel px-grow"
              style={{ transformOrigin: origin }}
              aria-labelledby={titleId}
            >
              <h2 className="visually-hidden" id={titleId}>
                {t("setup.title", { name: tool.name })}
              </h2>
              {details}
            </section>,
            panel,
          )
        : null}
    </>
  );
}

/** Brings a block that just appeared into view, so a notice below the fold is not missed. */
function ScrollIntoView({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div ref={ref} className="px-grow">
      {children}
    </div>
  );
}
