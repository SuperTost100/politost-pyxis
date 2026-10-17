import { useQuery } from "@tanstack/react-query";
import { Button, Input, Popconfirm } from "antd";
import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { IconButton } from "../../components/IconButton";
import { pythonMaxChars } from "../../components/pythonRun";
import { invoke } from "../../lib/ipc";
import { useJobs } from "../jobs/queries";
import {
  addSnippet,
  readCode,
  readSnippets,
  writeCode,
  writeSnippets,
  type Snippet,
} from "./pythonCode";
import "./PythonPage.css";

const INITIAL_CODE = "print(1 + 1)";

export function PythonPage() {
  const { t, i18n } = useTranslation();
  const mb = (bytes: number) =>
    new Intl.NumberFormat(i18n.language, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(bytes / 1e6);
  // The code is saved as it is typed, so the menu and the router may leave the page at any time.
  // Code somewhat over the run limit still comes back, so the student can trim it.
  const [code, setCode] = useState(() =>
    readCode(localStorage, INITIAL_CODE, pythonMaxChars * 2),
  );
  const [snippets, setSnippets] = useState<Snippet[]>(() =>
    readSnippets(localStorage, pythonMaxChars),
  );
  useEffect(() => writeCode(localStorage, code), [code]);
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const { data: jobs = [] } = useJobs();
  const job = jobs.find((item) => item.kind === "local-runtime-download");
  const active = job?.state === "queued" || job?.state === "running";
  const runtime = useQuery({
    queryKey: ["python-runtime"],
    queryFn: () => invoke("tools.runtime", {}),
    refetchInterval: (query) =>
      active || starting || query.state.data?.phase === "downloading"
        ? 500
        : false,
  });
  const ready = runtime.data?.phase === "ready";
  const tooLong = code.length > pythonMaxChars;
  const canRun = ready && !tooLong && !busy;
  // Opening a snippet replaces the editor, so ask first when that would lose code that is not saved anywhere else.
  const unsaved =
    code.trim() !== "" &&
    code !== INITIAL_CODE &&
    !snippets.some((item) => item.code === code);
  function keepSnippets(next: Snippet[]) {
    setSnippets(next);
    writeSnippets(localStorage, next);
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (canRun) void run();
  }
  const megabytes = mb(runtime.data?.totalBytes ?? 0);
  async function download() {
    setStarting(true);
    setNotice("");
    try {
      await invoke("tools.runtimeDownload", {});
    } catch {
      setNotice(t("python.downloadFailed"));
    } finally {
      setStarting(false);
      void runtime.refetch();
    }
  }
  async function run() {
    setBusy(true);
    setNotice("");
    setStdout("");
    setStderr("");
    setImages([]);
    try {
      const result = await invoke("tools.python", { code });
      setStdout(result.stdout);
      setStderr(result.stderr);
      setImages(result.images ?? []);
      if (result.timedOut) setNotice(t("python.timeout"));
      else if (result.truncated) setNotice(t("python.truncated"));
      else if (result.stderr === "runtime-missing") {
        setStderr("");
        void runtime.refetch();
      } else if (
        result.stderr === "runtime-timeout" ||
        result.stderr === "runtime-load-timeout"
      )
        setNotice(t("python.slow"));
      else if (result.stderr === "runtime-unavailable")
        setNotice(t("python.missing"));
    } catch {
      setNotice(t("python.missing"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <FocusLayout title={t("python.title")}>
      <section className="px-python" onKeyDown={onKeyDown}>
        {!ready && runtime.data ? (
          <div className="px-python-consent" role="group">
            <p className="body-strong">{t("python.consentTitle")}</p>
            <p className="small">
              {t("python.consentBody", { size: megabytes })}
            </p>
            {active || runtime.data.phase === "downloading" ? (
              <div className="px-python-actions">
                <span className="meta" role="status">
                  {t("python.download", {
                    current: mb(runtime.data.bytes),
                    total: megabytes,
                  })}
                </span>
                {job ? (
                  <Button
                    shape="round"
                    onClick={() =>
                      void invoke("jobs.cancel", { jobId: job.id })
                    }
                  >
                    {t("python.cancelDownload")}
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="px-python-actions">
                <Button
                  type="primary"
                  shape="round"
                  loading={starting}
                  onClick={() => void download()}
                >
                  {t(
                    job?.state === "failed" || job?.state === "cancelled"
                      ? "python.retryDownload"
                      : "python.downloadAction",
                    { size: megabytes },
                  )}
                </Button>
                {job?.state === "failed" ? (
                  <span className="small" role="alert">
                    {t("python.downloadFailed")}
                  </span>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
        <p className="small">{t("python.sessionFiles")}</p>
        <div data-keeps-draft>
          <Input.TextArea
            aria-label={t("python.code")}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            value={code}
            rows={10}
            onChange={(event) => setCode(event.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="px-python-actions">
          <Button
            type="primary"
            shape="round"
            loading={busy}
            disabled={!ready || tooLong}
            onClick={() => void run()}
          >
            {t("python.run")}
          </Button>
          <Button
            shape="round"
            disabled={!code.trim() || tooLong}
            onClick={() => keepSnippets(addSnippet(snippets, code))}
          >
            {t("python.saveSnippet")}
          </Button>
          {busy ? (
            <span className="meta" role="status">
              {t("python.running")}
            </span>
          ) : null}
          {tooLong ? (
            <span className="small" role="alert">
              {t("python.tooLong", { count: pythonMaxChars })}
            </span>
          ) : null}
        </div>
        {notice ? (
          <p className="small" role="status">
            {notice}
          </p>
        ) : null}
        {snippets.length ? (
          <section
            className="px-python-snippets"
            aria-labelledby="px-python-snippets"
          >
            <h2 id="px-python-snippets" className="label">
              {t("python.snippets")}
            </h2>
            <ul>
              {snippets.map((snippet, index) => (
                <li key={snippet.code}>
                  <Popconfirm
                    disabled={!unsaved}
                    title={t("python.replaceTitle")}
                    description={t("python.replaceBody")}
                    okText={t("python.replace")}
                    cancelText={t("python.keep")}
                    onConfirm={() => setCode(snippet.code)}
                  >
                    <button
                      type="button"
                      className="px-python-snippet"
                      aria-label={t("python.openSnippet", { name: snippet.name })}
                      onClick={unsaved ? undefined : () => setCode(snippet.code)}
                    >
                      {snippet.name}
                    </button>
                  </Popconfirm>
                  <IconButton
                    icon="x"
                    size="sm"
                    variant="ghost"
                    label={t("python.deleteSnippet", { name: snippet.name })}
                    onClick={() =>
                      keepSnippets(snippets.filter((_, at) => at !== index))
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {stdout ? (
          <section aria-label={t("python.output")}>
            <h2 className="body-strong">{t("python.output")}</h2>
            <pre>{stdout}</pre>
          </section>
        ) : null}
        {stderr ? (
          <section aria-label={t("python.diagnostics")}>
            <h2 className="body-strong">{t("python.diagnostics")}</h2>
            <pre>{stderr}</pre>
          </section>
        ) : null}
        {images.map((image, index) => (
          <img
            key={index}
            className="px-python-plot"
            src={image}
            alt={t("python.plot", { index: index + 1 })}
          />
        ))}
      </section>
    </FocusLayout>
  );
}
