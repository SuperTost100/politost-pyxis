import { Button, Input } from "antd";
import { Check } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
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
 * The browser and terminal sign-in that core starts for a CLI. `done` runs when core reports the engine signed in.
 * Shared by first setup and Settings so both read the same.
 */
export function useEngineSignIn(done: () => void) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [terminal, setTerminal] = useState<string | null>(null);

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
    if (event.type === "code-prompt") {
      setCodeFor(event.provider ?? provider ?? null);
      setStatus(t("setup.signIn.codeHint"));
    }
    if (event.type === "needs-terminal" && event.command) {
      setTerminal(event.command.join(" "));
      setStatus(t("setup.signIn.waitingTerminal"));
    }
    if (event.type === "done") {
      setStatus(null);
      setCodeFor(null);
      setTerminal(null);
      done();
    }
    if (event.type === "error") {
      setStatus(null);
      setFailed(true);
    }
  }
  useEffect(() => onBroadcast("engine.login", (event) => handle(event)));

  function start(provider: string) {
    setFailed(false);
    setStatus(t("engines.waitingSignIn"));
    return invoke("engines.login", { provider }).then(
      (event) => handle(event, provider),
      () => {
        setStatus(null);
        setFailed(true);
      },
    );
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
  return { status, failed, terminal, codeForm, start };
}

function useInstall(provider: InstallableProvider, done: () => void) {
  const [state, setState] = useState<"idle" | "running" | "failed">("idle");
  const [line, setLine] = useState("");
  const [detail, setDetail] = useState("");
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
      setState("idle");
      done();
    } catch (err) {
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
    void invoke("engines.cancelInstall", { provider });
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
}: {
  provider: InstallableProvider;
  row: Engine | undefined;
  /** Something changed on disk or in the account: refresh the engine list. */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const name = row?.name ?? fallbackNames[provider];
  const { vendor, account } = makers[provider];
  const installed = !!row?.installed;
  const signedIn = installed && !!row?.loggedIn;
  const signIn = useEngineSignIn(onChanged);
  const install = useInstall(provider, () => {
    onChanged();
    if (provider !== "antigravity") void signIn.start(provider);
  });
  const [terminalNote, setTerminalNote] = useState<string | null>(null);
  const terminalSignIn = provider === "antigravity";

  async function openAntigravity() {
    setTerminalNote(null);
    // Core watches for the sign-in while the student works in the terminal.
    void signIn.start(provider);
    try {
      await window.pyxis.openTerminal("antigravity");
    } catch {
      setTerminalNote(t("setup.signIn.terminalUnavailable"));
    }
  }

  return (
    <section className="px-setup" aria-labelledby={`setup-${provider}`}>
      <div className="px-setup-head">
        <h2 className="title-3" id={`setup-${provider}`}>
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
                    type="primary"
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
                  type="primary"
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
                  type="primary"
                  shape="round"
                  onClick={() => void signIn.start(provider)}
                >
                  {t("setup.signIn.action", { account })}
                </Button>
              </div>
            </>
          )}
          {!signedIn && signIn.status ? (
            <p className="small" role="status">
              {signIn.status}
            </p>
          ) : null}
          {!signedIn ? signIn.codeForm : null}
          {!signedIn && signIn.terminal && !terminalSignIn ? (
            <div className="px-setup-terminal">
              <p className="small">{t("engines.terminalInstructions")}</p>
              <code className="code px-setup-command">{signIn.terminal}</code>
            </div>
          ) : null}
          {!signedIn && signIn.failed ? (
            <Notice tone="danger">{t("engines.signInFailed")}</Notice>
          ) : null}
        </SetupStep>
      </ol>
    </section>
  );
}
