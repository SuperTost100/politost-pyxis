import { App, Button, Checkbox, Modal, Radio } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";
import "./ExportButton.css";
import { safeFileName } from "@shared/file-name";

type Kind = "plan" | "lesson" | "cards" | "quiz" | "simulation";
type Format = "pyxis" | "pdf" | "markdown" | "anki" | "csv";

export function textBase64(text: string): string {
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
  wording,
  attemptId,
  kind,
  disabled = false,
  open: controlled,
  onOpenChange,
}: {
  planId: string;
  topicId?: string;
  wording?: "simple" | "balanced" | "technical";
  attemptId?: string;
  kind: Kind;
  disabled?: boolean;
  /** Opened from elsewhere, such as a menu: no button of its own is shown. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [internal, setInternal] = useState(false);
  const open = controlled ?? internal;
  const setOpen = (next: boolean) => {
    setInternal(next);
    onOpenChange?.(next);
  };
  const [format, setFormat] = useState<Format>(
    kind === "plan" ? "pyxis" : "pdf",
  );
  const [answers, setAnswers] = useState(false);
  const [progress, setProgress] = useState(false);
  const [embed, setEmbed] = useState(false);
  const [author, setAuthor] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (controlled) setError(false);
  }, [controlled]);
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
      let leftOut: string[] = [];
      if (kind === "plan") {
        const file = await invoke("plans.export", {
          planId,
          progress,
          embed,
          author,
        });
        // An original on this computer that came back without its bytes did not fit in a file the app can save.
        if (embed)
          leftOut = (file.sources ?? [])
            .filter((source) => source.data === undefined && source.bytes > 0)
            .map((source) => source.title);
        result = await window.pyxis.saveArtifact({
          filename: `${safeFileName(file.title, "plan")}.pyxis`,
          base64: textBase64(JSON.stringify(file, null, 2)),
        });
      } else if (format === "anki") {
        const file = await invoke("study.anki", {
          planId,
          topicId,
          history: progress,
        });
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
          wording,
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
        if (leftOut.length)
          void message.warning(
            t("export.sourcesLeftOut", { count: leftOut.length, titles: leftOut.join(", ") }),
            8,
          );
        else void message.success(t("export.saved"));
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {controlled === undefined ? (
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
      ) : null}
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
                checked={author}
                onChange={(event) => setAuthor(event.target.checked)}
              >
                {t("plans.includeAuthor")}
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
          {format === "anki" ? (
            <Checkbox
              disabled={busy}
              checked={progress}
              onChange={(event) => setProgress(event.target.checked)}
            >
              {t("cardExport.history")}
            </Checkbox>
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
