import { useQuery } from "@tanstack/react-query";
import { Button, Input, Popconfirm } from "antd";
import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { BookmarkPlus, Play } from "lucide-react";
import { usePlace } from "../../app/usePlace";
import { IconButton } from "../../components/IconButton";
import { pythonMaxChars } from "../../components/pythonRun";
import { invoke } from "../../lib/ipc";
import { useJobs } from "../jobs/queries";
import { BarTool, StudyLayout } from "../study/StudyBar";
import { toolLine } from "./toolLine";
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
  // The chat or page the editor was opened from, which the bar names under the title.
  const back = usePlace({});
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
  // A download of either kind that is waiting or running, whichever page started it: Settings starts one pack on its own.
  const waiting = jobs.filter(
    (item) =>
      (item.kind === "local-runtime-download" || item.kind === "local-drawings-download") &&
      (item.state === "queued" || item.state === "running"),
  );
  const active = waiting.length > 0;
  const runtime = useQuery({
    queryKey: ["python-runtime"],
    queryFn: () => invoke("tools.runtime", {}),
    refetchInterval: (query) =>
      active || starting || query.state.data?.phase === "downloading"
        ? 500
        : false,
  });
  // Python runs with its own pack. The download is done when every pack is there, the drawing files included.
  const ready = runtime.data?.packs.pyodide === "ready";
  const complete = runtime.data?.phase === "ready";
  // Python is there and only the drawing files are missing: the same download, offered for what is left.
  const drawings = ready && !complete;
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
  // Ctrl or Cmd+Enter pressed while the page has not yet read whether Python is there is kept, and runs the code once the
  // read says it is, as the Run button's click does once it is enabled; pressed when Python is known to be missing, it
  // does nothing, and the notice above the editor says why.
  const [runWhenKnown, setRunWhenKnown] = useState(false);
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (canRun) void run();
    else if (runtime.isPending && !busy) setRunWhenKnown(true);
  }
  useEffect(() => {
    if (!runWhenKnown || runtime.isPending) return;
    setRunWhenKnown(false);
    if (canRun) void run();
  }, [runWhenKnown, runtime.isPending, canRun]);
  // What the page offers is what is missing and not on its way already: with only the drawings downloading, Python can
  // still be asked for, for its own size. What is on its way has its progress and its Annulla here too.
  const info = runtime.data?.info;
  // A job that waits for its turn has not begun to fetch, and is on its way all the same: it holds the pack it asks for, or
  // every pack for the one this page starts (its `ref` is "pyodide" when it asks for Python alone).
  const asked = (pack: "pyodide" | "drawing") =>
    waiting.some((item) => (item.kind === "local-drawings-download" ? pack === "drawing" : item.ref !== "pyodide" || pack === "pyodide"));
  const downloading = (["pyodide", "drawing"] as const).filter(
    (pack) => info && info[pack].phase !== "ready" && (info[pack].phase === "downloading" || asked(pack)),
  );
  const missing = (["pyodide", "drawing"] as const).filter((pack) => info && info[pack].phase !== "ready" && !downloading.includes(pack));
  const megabytes = mb(missing.reduce((sum, pack) => sum + (info?.[pack].size ?? 0), 0));
  const running = downloading.length > 0 || starting;
  const failed = (["pyodide", "drawing"] as const).some((pack) => info?.[pack].phase === "failed");
  /** Stops what is on its way, and the jobs that wait: stopping the downloads does not reach a job that has not started. */
  async function cancel() {
    for (const item of waiting) await invoke("jobs.cancel", { jobId: item.id }).catch(() => undefined);
    await invoke("tools.runtimeCancel", {}).catch(() => undefined);
    void runtime.refetch();
  }
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
    <StudyLayout
      back={back}
      title={t("python.title")}
      subtitle={toolLine(back)}
      tools={
        <>
          <BarTool
            icon={<Play size={16} strokeWidth={1.75} aria-hidden />}
            label={t("python.run")}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            loading={busy}
            disabled={!ready || tooLong}
            onClick={() => void run()}
          />
          <BarTool
            icon={<BookmarkPlus size={16} strokeWidth={1.75} aria-hidden />}
            label={t("python.saveSnippet")}
            disabled={!code.trim() || tooLong}
            onClick={() => keepSnippets(addSnippet(snippets, code))}
          />
        </>
      }
    >
      <section className="px-python" onKeyDown={onKeyDown}>
        {!complete && runtime.data ? (
          <div className="px-python-consent" role="group">
            <p className="body-strong">
              {t(drawings ? "python.drawingsTitle" : "python.consentTitle")}
            </p>
            <p className="small">
              {t(drawings ? "python.drawingsBody" : "python.consentBody", {
                size: megabytes,
              })}
            </p>
            {running ? (
              <div className="px-python-actions">
                <span className="meta" role="status">
                  {t(downloading.includes("pyodide") ? "python.download" : "python.drawingsDownload", {
                    current: mb(runtime.data.bytes),
                    total: mb(runtime.data.totalBytes),
                  })}
                </span>
                <Button shape="round" onClick={() => void cancel()}>
                  {t("python.cancelDownload")}
                </Button>
              </div>
            ) : null}
            {missing.length > 0 ? (
              <div className="px-python-actions">
                <Button
                  type="primary"
                  shape="round"
                  loading={starting}
                  onClick={() => void download()}
                >
                  {t(failed ? "python.retryDownload" : drawings ? "python.drawingsAction" : "python.downloadAction", {
                    size: megabytes,
                  })}
                </Button>
                {failed && !running ? (
                  <span className="small" role="alert">
                    {t("python.downloadFailed")}
                  </span>
                ) : null}
              </div>
            ) : null}
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
    </StudyLayout>
  );
}
