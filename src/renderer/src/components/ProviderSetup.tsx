import { Button, Input } from "antd";
import { Check } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import {
  installCommand,
  installers,
  type InstallableProvider,
} from "@shared/installers";
import { invoke, onBroadcast } from "../lib/ipc";
import { Notice } from "./Notice";
import "./ProviderSetup.css";

type Engine = RequestOutput<"engines.overview">[number];

/** Who makes each engine and which account signs in to it. Product names, so the same in every language. */
const makers: Record<InstallableProvider, { vendor: string; account: string }> =
  {
    claude: { vendor: "Anthropic", account: "Claude" },
    codex: { vendor: "OpenAI", account: "ChatGPT" },
    agent: { vendor: "Cursor", account: "Cursor" },
    antigravity: { vendor: "Google", account: "Google" },
  };

const fallbackNames: Record<InstallableProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agent: "Cursor Agent",
  antigravity: "Antigravity",
};

function errorDetail(err: unknown): string {
  if (err && typeof err === "object" && "detail" in err)
    return String((err as { detail: unknown }).detail);
  return err instanceof Error ? err.message : String(err);
}

/**
 * The browser and terminal sign-in that core starts for one CLI. `done` runs when core reports it signed in. Events
 * for other engines are ignored, and a sign-in still pending when the card closes is cancelled.
 */
function useEngineSignIn(provider: InstallableProvider, done: () => void) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [terminal, setTerminal] = useState<string | null>(null);
  // The sign-in page, kept so the student can open it again if the tab was closed or never appeared.
  const [url, setUrl] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [detail, setDetail] = useState("");
  const pending = useRef(false);
  // Counts the attempts. A reply from a sign-in the student cancelled, or replaced by starting again, belongs to an
  // older number and is dropped, so it cannot reset the new attempt.
  const attempt = useRef(0);
  const stopWaiting = () => {
    pending.current = false;
    setWaiting(false);
    setUrl(null);
  };

  function handle(event: {
    provider?: string;
    type: string;
    url?: string;
    opened?: boolean;
    message?: string;
    command?: string[];
  }) {
    if (event.provider !== undefined && event.provider !== provider) return;
    if (!pending.current) return;
    if (event.type === "cancelled") {
      stopWaiting();
      setStatus(null);
      return;
    }
    if (event.type === "open-url" && event.url) {
      // Claude Code and Codex open the page themselves; opening it again gave the student two tabs.
      if (!event.opened) void window.pyxis.openExternal(event.url);
      setUrl(event.url);
      setStatus(t("setup.signIn.waitingBrowser"));
    }
    if (event.type === "code-prompt") {
      setCodeFor(provider);
      setStatus(t("setup.signIn.codeHint"));
    }
    if (event.type === "needs-terminal" && event.command) {
      setTerminal(event.command.join(" "));
      setStatus(t("setup.signIn.waitingTerminal"));
    }
    if (event.type === "done") {
      stopWaiting();
      setStatus(null);
      setCodeFor(null);
      setTerminal(null);
      done();
    }
    if (event.type === "error") {
      stopWaiting();
      setStatus(null);
      setCodeFor(null);
      setDetail(event.message ?? "");
      setFailed(true);
    }
  }
  // One subscription for the card's life, which always runs the latest handler.
  const latestHandle = useRef(handle);
  latestHandle.current = handle;
  useEffect(
    () => onBroadcast("engine.login", (event) => latestHandle.current(event)),
    [],
  );
  useEffect(
    () => () => {
      if (pending.current)
        void invoke("engines.cancelLogin", { provider }).catch(() => undefined);
    },
    [provider],
  );

  function start() {
    if (pending.current) return Promise.resolve();
    pending.current = true;
    const mine = ++attempt.current;
    setWaiting(true);
    setFailed(false);
    setDetail("");
    setStatus(t("engines.waitingSignIn"));
    return invoke("engines.login", { provider }).then(
      (event) => {
        if (attempt.current === mine) handle({ ...event, provider });
      },
      () => {
        if (attempt.current !== mine) return;
        stopWaiting();
        setStatus(null);
        setFailed(true);
      },
    );
  }

  function cancel() {
    attempt.current += 1;
    void invoke("engines.cancelLogin", { provider }).catch(() => undefined);
    stopWaiting();
    setStatus(null);
    setCodeFor(null);
    setTerminal(null);
  }

  const codeForm = codeFor ? (
    <form
      className="px-form-inline"
      onSubmit={(event) => {
        event.preventDefault();
        void invoke("engines.sendCode", { provider: codeFor, code }).catch(() =>
          setFailed(true),
        );
        setCodeFor(null);
        setCode("");
        setStatus(t("engines.waitingSignIn"));
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
  ) : null;
  return {
    status,
    failed,
    detail,
    terminal,
    url,
    waiting,
    codeForm,
    start,
    cancel,
  };
}

function useInstall(provider: InstallableProvider, done: () => void) {
  const [state, setState] = useState<"idle" | "running" | "failed">("idle");
  const [line, setLine] = useState("");
  const [detail, setDetail] = useState("");
  // An install keeps running in core when its card closes; it must not then start a sign-in nobody asked for.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () =>
      onBroadcast("engine.install", (event) => {
        if (event.provider !== provider) return;
        // Installers draw progress bars with carriage returns; the last full line is enough to show it moves.
        const last = event.text
          .split(/[\r\n]+/)
          .map((part) => part.trim())
          .filter(Boolean)
          .at(-1);
        if (last) setLine(last);
      }),
    [provider],
  );
  async function run() {
    setState("running");
    setLine("");
    setDetail("");
    try {
      await invoke("engines.install", { provider });
      if (!mounted.current) return;
      setState("idle");
      done();
    } catch (err) {
      if (!mounted.current) return;
      const cancelled =
        err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "aborted";
      setDetail(cancelled ? "" : errorDetail(err));
      setState(cancelled ? "idle" : "failed");
    }
  }
  function cancel() {
    void invoke("engines.cancelInstall", { provider }).catch(() => undefined);
  }
  return { state, line, detail, run, cancel };
}

function SetupStep({
  number,
  done,
  title,
  children,
}: {
  number: number;
  done: boolean;
  title: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <li className={done ? "px-setup-step is-done" : "px-setup-step"}>
      <span className="px-setup-marker" aria-hidden>
        {done ? <Check size={14} strokeWidth={2.5} /> : number}
      </span>
      <div className="px-setup-step-body">
        <h3 className="body-strong">
          {title}
          {done ? (
            <span className="visually-hidden">, {t("setup.stepDone")}</span>
          ) : null}
        </h3>
        {children}
      </div>
    </li>
  );
}

/**
 * Install and sign-in for one CLI engine, as two numbered steps. The install runs the vendor's own script and shows
 * the command first; sign-in starts by itself once the install finishes, except for Antigravity, which needs the
 * student in a terminal.
 */
export function ProviderSetup({
  provider,
  row,
  onChanged,
  titled = true,
}: {
  provider: InstallableProvider;
  row: Engine | undefined;
  /** Something changed on disk or in the account: refresh the engine list. */
  onChanged: () => void;
  /** False inside a dialog that already shows the same title. */
  titled?: boolean;
}) {
  const { t } = useTranslation();
  const name = row?.name ?? fallbackNames[provider];
  const { vendor, account } = makers[provider];
  const installed = !!row?.installed;
  const signedIn = installed && !!row?.loggedIn;
  const signIn = useEngineSignIn(provider, onChanged);
  const install = useInstall(provider, () => {
    onChanged();
    if (provider !== "antigravity") void signIn.start();
  });
  const [terminalNote, setTerminalNote] = useState<string | null>(null);
  const terminalSignIn = provider === "antigravity";

  async function openAntigravity() {
    setTerminalNote(null);
    // Core watches for the sign-in while the student works in the terminal.
    void signIn.start();
    try {
      await window.pyxis.openTerminal("antigravity");
    } catch {
      setTerminalNote(t("setup.signIn.terminalUnavailable"));
    }
  }

  return (
    <section className="px-setup" aria-labelledby={`setup-${provider}`}>
      <div className="px-setup-head">
        <h2
          className={titled ? "title-3" : "visually-hidden"}
          id={`setup-${provider}`}
        >
          {t("setup.title", { name })}
        </h2>
        <p className="small px-setup-muted">{t(`setup.plan.${provider}`)}</p>
      </div>
      <ol className="px-setup-steps">
        <SetupStep number={1} done={installed} title={t("setup.install.title")}>
          {installed ? (
            <p className="small px-setup-muted">
              {row?.version
                ? t("setup.install.doneVersion", { version: row.version })
                : t("setup.install.done")}
            </p>
          ) : install.state === "running" ? (
            <>
              <p className="small" role="status">
                {t("setup.install.running", { name })}
              </p>
              {install.line ? (
                <p className="meta px-setup-log">{install.line}</p>
              ) : null}
              <div className="px-setup-actions">
                <Button shape="round" onClick={install.cancel}>
                  {t("engines.cancel")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="small">{t("setup.install.body", { vendor })}</p>
              <code className="code px-setup-command">
                {installCommand(provider, window.pyxis.platform)}
              </code>
              {install.state === "failed" ? (
                <Notice
                  tone="danger"
                  details={install.detail || undefined}
                  action={{
                    label: t("setup.install.retry"),
                    onClick: () => void install.run(),
                  }}
                  secondary={{
                    label: t("setup.install.page", { vendor }),
                    onClick: () =>
                      void window.pyxis.openExternal(installers[provider].page),
                  }}
                >
                  {t("setup.install.failed", { name })}
                </Notice>
              ) : (
                <div className="px-setup-actions">
                  <Button
                    shape="round"
                    onClick={() => void install.run()}
                  >
                    {t("setup.install.action", { name })}
                  </Button>
                </div>
              )}
            </>
          )}
        </SetupStep>
        <SetupStep number={2} done={signedIn} title={t("setup.signIn.title")}>
          {signedIn ? (
            <p className="small px-setup-muted">{t("setup.signIn.done")}</p>
          ) : !installed ? (
            <p className="small px-setup-muted">
              {t("setup.signIn.afterInstall")}
            </p>
          ) : terminalSignIn ? (
            <>
              <ol className="px-setup-howto small">
                <li>{t("setup.antigravity.open")}</li>
                <li>{t("setup.antigravity.choose")}</li>
                <li>{t("setup.antigravity.browser")}</li>
                <li>{t("setup.antigravity.back")}</li>
              </ol>
              <div className="px-setup-actions">
                <Button
                  shape="round"
                  onClick={() => void openAntigravity()}
                >
                  {t("setup.antigravity.action")}
                </Button>
              </div>
              {terminalNote ? (
                <div className="px-setup-terminal">
                  <p className="small">{terminalNote}</p>
                  <code className="code px-setup-command">agy</code>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <p className="small">{t("setup.signIn.body", { account })}</p>
              <div className="px-setup-actions">
                <Button
                  shape="round"
                  loading={signIn.waiting}
                  onClick={() => void signIn.start()}
                >
                  {t("setup.signIn.action", { account })}
                </Button>
              </div>
            </>
          )}
          {/* Always present, so screen readers announce each new status. */}
          <p className="small" role="status">
            {signedIn ? "" : (signIn.status ?? "")}
          </p>
          {!signedIn && signIn.waiting ? (
            <div className="px-setup-actions">
              {signIn.url ? (
                <Button
                  shape="round"
                  onClick={() => void window.pyxis.openExternal(signIn.url!)}
                >
                  {t("setup.signIn.reopen")}
                </Button>
              ) : null}
              <Button type="text" shape="round" onClick={signIn.cancel}>
                {t("engines.cancel")}
              </Button>
            </div>
          ) : null}
          {!signedIn ? signIn.codeForm : null}
          {!signedIn && signIn.terminal && !terminalSignIn ? (
            <div className="px-setup-terminal">
              <p className="small">{t("engines.terminalInstructions")}</p>
              <code className="code px-setup-command">{signIn.terminal}</code>
            </div>
          ) : null}
          {!signedIn && signIn.failed ? (
            <Notice tone="danger" details={signIn.detail || undefined}>
              {t("engines.signInFailed")}
            </Notice>
          ) : null}
        </SetupStep>
      </ol>
    </section>
  );
}
