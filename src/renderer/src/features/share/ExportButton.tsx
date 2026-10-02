import { App, Button, Checkbox, Modal, Radio } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";
import "./ExportButton.css";

type Kind = "plan" | "lesson" | "cards" | "quiz" | "simulation";
type Format = "pyxis" | "pdf" | "markdown" | "anki" | "csv";

function textBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export function ExportButton({
  planId,
  topicId,
  attemptId,
  kind,
  disabled = false,
}: {
  planId: string;
  topicId?: string;
  attemptId?: string;
  kind: Kind;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<Format>(
    kind === "plan" ? "pyxis" : "pdf",
  );
  const [answers, setAnswers] = useState(false);
  const [progress, setProgress] = useState(false);
  const [embed, setEmbed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const formats: Format[] =
    kind === "plan"
      ? ["pyxis"]
      : kind === "cards"
        ? ["pdf", "markdown", "anki", "csv"]
        : ["pdf", "markdown"];

  async function save() {
    setBusy(true);
    setError(false);
    try {
      let result: "saved" | "cancelled";
      if (kind === "plan") {
        const file = await invoke("plans.export", { planId, progress, embed });
        result = await window.pyxis.saveArtifact({
          filename: `${file.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim() || "plan"}.pyxis`,
          base64: textBase64(JSON.stringify(file, null, 2)),
        });
      } else if (format === "anki") {
        const file = await invoke("study.anki", { planId, topicId });
        result = await window.pyxis.saveArtifact({
          filename: file.filename,
          base64: file.base64,
        });
      } else if (format === "csv") {
        const file = await invoke("study.csv", { planId, topicId });
        result = await window.pyxis.saveArtifact({
          filename: file.filename,
          base64: textBase64(file.csv),
        });
      } else {
        const file = await invoke("study.markdown", {
          planId,
          topicId,
          kind,
          answers,
          attemptId,
        });
        result =
          format === "pdf"
            ? await window.pyxis.exportPdf({
                filename: file.filename.replace(/\.md$/i, ".pdf"),
                markdown: file.markdown,
              })
            : await window.pyxis.saveArtifact({
                filename: file.filename,
                base64: textBase64(file.markdown),
              });
      }
      if (result === "saved") {
        setOpen(false);
        void message.success(t("export.saved"));
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        shape="round"
        disabled={disabled || !planId}
        onClick={() => {
          setError(false);
          setOpen(true);
        }}
      >
        {t("export.title")}
      </Button>
      <Modal
        title={t("export.title")}
        open={open}
        onCancel={() => {
          if (!busy) setOpen(false);
        }}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
        okText={t("export.save")}
        cancelText={t("export.cancel")}
        onOk={() => void save()}
        confirmLoading={busy}
        cancelButtonProps={{ disabled: busy }}
        className="px-export-modal"
      >
        <div className="px-export-body">
          <fieldset className="px-export-formats" disabled={busy}>
            <legend className="label">{t("export.format")}</legend>
            <Radio.Group
              value={format}
              onChange={(event) => setFormat(event.target.value as Format)}
            >
              {formats.map((value) => (
                <Radio.Button key={value} value={value}>
                  {t(`export.${value}`)}
                </Radio.Button>
              ))}
            </Radio.Group>
          </fieldset>
          <p className="small">{t(`export.description.${format}`)}</p>
          {kind === "plan" ? (
            <div className="px-export-options">
              <Checkbox
                disabled={busy}
                checked={progress}
                onChange={(event) => setProgress(event.target.checked)}
              >
                {t("plans.includeProgress")}
              </Checkbox>
              <Checkbox
                disabled={busy}
                checked={embed}
                onChange={(event) => setEmbed(event.target.checked)}
              >
                {t("plans.embedSources")}
              </Checkbox>
              {embed ? (
                <Notice tone="warning">{t("plans.embedWarning")}</Notice>
              ) : null}
            </div>
          ) : null}
          {kind === "quiz" || kind === "simulation" ? (
            <Checkbox
              disabled={busy}
              checked={answers}
              onChange={(event) => setAnswers(event.target.checked)}
            >
              {t("export.answers")}
            </Checkbox>
          ) : null}
          {error ? <Notice tone="danger">{t("export.failed")}</Notice> : null}
        </div>
      </Modal>
    </>
  );
}
