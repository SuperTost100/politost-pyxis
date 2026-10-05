import { Button, Input } from "antd";
import { createContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../lib/ipc";
import { pythonMaxChars, pythonOutcome, type PythonOutcome } from "./pythonRun";
import "./PythonBlock.css";

/** Tutor messages turn this on so their Python blocks can run (MATH-03). */
export const RunnablePython = createContext(false);

/** An editable Python block that runs in the local sandbox and shows its output or error below the code. */
export function PythonBlock({ code }: { code: string }) {
  const { t } = useTranslation();
  const [edited, setEdited] = useState<string | null>(null);
  const [ran, setRan] = useState<{ source: string; outcome: PythonOutcome } | null>(null);
  const [busy, setBusy] = useState(false);
  const source = edited ?? code;
  const tooLong = source.length > pythonMaxChars;
  // Only the latest run may report, and none after unmount; the sandbox call itself cannot be cancelled.
  const latest = useRef(0);
  useEffect(
    () => () => {
      latest.current = -1;
    },
    [],
  );
  // While a reply streams, `code` keeps growing; an output that belongs to an older text is not shown.
  const outcome = ran?.source === source ? ran.outcome : null;

  async function run() {
    const id = ++latest.current;
    const started = source;
    setBusy(true);
    setRan(null);
    let outcome: PythonOutcome;
    try {
      outcome = pythonOutcome(await invoke("tools.python", { code: started }));
    } catch {
      outcome = { stdout: "", stderr: "", images: [], notice: "unavailable" };
    }
    if (latest.current !== id) return;
    setRan({ source: started, outcome });
    setBusy(false);
  }

  return (
    <div className="px-code-block px-python-block">
      <Input.TextArea
        aria-label={t("python.code")}
        value={source}
        autoSize={{ minRows: 2, maxRows: 16 }}
        spellCheck={false}
        onChange={(event) => setEdited(event.target.value)}
      />
      <div className="px-python-block-actions">
        <Button
          shape="round"
          size="small"
          loading={busy}
          disabled={tooLong || !source.trim()}
          onClick={() => void run()}
        >
          {t("components.markdown.run")}
        </Button>
        {edited !== null && edited !== code ? (
          <Button
            type="text"
            shape="round"
            size="small"
            disabled={busy}
            onClick={() => setEdited(null)}
          >
            {t("python.reset")}
          </Button>
        ) : null}
        {tooLong ? (
          <span className="meta" role="alert">
            {t("python.tooLong", { count: pythonMaxChars })}
          </span>
        ) : null}
      </div>
      <div aria-live="polite">
        {outcome?.notice === "setup" ? (
          <p className="small">
            {t("python.consentTitle")}.{" "}
            <a href="#/tools/python">{t("python.setup")}</a>
          </p>
        ) : outcome?.notice === "unavailable" ? (
          <p className="small">{t("python.missing")}</p>
        ) : outcome?.notice === "timeout" ? (
          <p className="small">{t("python.timeout")}</p>
        ) : outcome?.notice === "truncated" ? (
          <p className="small">{t("python.truncated")}</p>
        ) : null}
        {outcome?.stdout ? (
          <pre className="px-python-block-out" tabIndex={0} aria-label={t("python.output")}>
            {outcome.stdout}
          </pre>
        ) : null}
        {outcome?.stderr ? (
          <pre
            className="px-python-block-out is-error"
            tabIndex={0}
            aria-label={t("python.diagnostics")}
          >
            {outcome.stderr}
          </pre>
        ) : null}
        {outcome?.images.map((image, index) => (
          <img
            key={index}
            className="px-python-block-plot"
            src={image}
            alt={t("python.plot", { index: index + 1 })}
          />
        ))}
      </div>
    </div>
  );
}
