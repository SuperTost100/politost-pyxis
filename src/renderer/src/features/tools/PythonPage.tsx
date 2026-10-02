import { useQuery } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { invoke } from "../../lib/ipc";
import "./PythonPage.css";

export function PythonPage() {
  const { t } = useTranslation();
  const [code, setCode] = useState("print(1 + 1)");
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const runtime = useQuery({
    queryKey: ["python-runtime"],
    queryFn: () => invoke("tools.runtime", {}),
    enabled: busy,
    refetchInterval: busy ? 500 : false,
  });
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
      else if (
        result.stderr === "runtime-unavailable" ||
        result.stderr === "runtime-timeout"
      )
        setNotice(t("python.missing"));
    } catch {
      setNotice(t("python.missing"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <FocusLayout title={t("python.title")}>
      <section className="px-python">
        <p className="small">{t("python.sessionFiles")}</p>
        <Input.TextArea
          aria-label={t("python.code")}
          value={code}
          rows={10}
          onChange={(event) => setCode(event.target.value)}
          spellCheck={false}
        />
        <div className="px-python-actions">
          <Button
            type="primary"
            shape="round"
            loading={busy}
            onClick={() => void run()}
          >
            {t("python.run")}
          </Button>
          {busy ? (
            <span className="meta" role="status">
              {runtime.data?.phase === "downloading"
                ? t("python.download", {
                    current: (runtime.data.bytes / 1e6).toFixed(1),
                    total: (runtime.data.totalBytes / 1e6).toFixed(1),
                  })
                : t(
                    runtime.data?.phase === "ready"
                      ? "python.running"
                      : "python.preparing",
                  )}
            </span>
          ) : null}
        </div>
        {notice ? (
          <p className="small" role="status">
            {notice}
          </p>
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
