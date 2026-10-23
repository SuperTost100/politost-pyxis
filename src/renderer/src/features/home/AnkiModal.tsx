import { App, Button, Checkbox, Modal, Select } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";
import "./AnkiModal.css";
import { usePlan, usePlans } from "../../lib/queries";

type Preview = RequestOutput<"study.ankiPreview">;
type Result = RequestOutput<"study.ankiImport">;

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const messageKeyOf = (err: unknown): string =>
  err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "cardImport.failed";

/** Import from or export to an Anki package (.apkg), from the card browser. */
export function AnkiModal({
  mode,
  open,
  onClose,
  initialPlanId,
  initialTopicId,
  onImported,
}: {
  mode: "import" | "export";
  open: boolean;
  onClose: () => void;
  /** The exam and topic the card browser is filtered to, if any. */
  initialPlanId?: string;
  initialTopicId?: string;
  onImported?: (result: Result) => void;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const importing = mode === "import";
  const [planId, setPlanId] = useState(initialPlanId ?? "");
  const [topicId, setTopicId] = useState(initialTopicId ?? "");
  const [history, setHistory] = useState(true);
  const [file, setFile] = useState<{ path: string; preview: Preview } | null>(
    null,
  );
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const plans = usePlans(open);
  const plan = usePlan(planId, open);
  const topics = plan.data?.topics ?? [];

  // Opening starts from the browser's filters, or the first exam.
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setResult(null);
    setErrorKey(null);
    // Keeping the history is the point of an import; an export starts as plain new cards.
    setHistory(importing);
    setPlanId(initialPlanId ?? "");
    setTopicId(initialTopicId ?? "");
  }, [open, importing, initialPlanId, initialTopicId]);
  useEffect(() => {
    if (!open || planId || !plans.data?.length) return;
    setPlanId(plans.data[0]!.id);
  }, [open, planId, plans.data]);
  // An import needs a topic; an export may take them all.
  useEffect(() => {
    if (!open || !plan.data) return;
    if (topicId && topics.some((topic) => topic.id === topicId)) return;
    setTopicId(importing ? (topics[0]?.id ?? "") : "");
  }, [open, plan.data, topicId, topics, importing]);

  async function choose() {
    setErrorKey(null);
    setPicking(true);
    try {
      const picked = await window.pyxis.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: t("cardImport.fileType"), extensions: ["apkg"] }],
      });
      const path = picked?.[0];
      if (!path) return;
      setFile({ path, preview: await invoke("study.ankiPreview", { path }) });
    } catch (err) {
      setFile(null);
      setErrorKey(messageKeyOf(err));
    } finally {
      setPicking(false);
    }
  }

  async function run() {
    setBusy(true);
    setErrorKey(null);
    try {
      if (importing && file) {
        const done = await invoke("study.ankiImport", {
          path: file.path,
          planId,
          topicId,
          history: history && file.preview.reviews > 0,
        });
        setResult(done);
        onImported?.(done);
      } else if (!importing) {
        const out = await invoke("study.anki", {
          planId,
          topicId: topicId || undefined,
          history,
        });
        const saved = await window.pyxis.saveArtifact({
          filename: out.filename,
          base64: out.base64,
        });
        if (saved === "saved") {
          onClose();
          void message.success(t("export.saved"));
        }
      }
    } catch (err) {
      setErrorKey(importing ? messageKeyOf(err) : "export.failed");
    } finally {
      setBusy(false);
    }
  }

  const preview = file?.preview;
  const skipped = preview ? preview.unsupported + preview.empty : 0;
  const ready = importing
    ? Boolean(file && preview && preview.cards > 0 && planId && topicId)
    : Boolean(planId);

  const planOptions = (plans.data ?? []).map((item) => ({
    value: item.id,
    label: item.title,
  }));
  const fields = (
    <>
      <div className="px-form-field">
        <label className="label" htmlFor="anki-plan">
          {t("cardBrowser.exam")}
        </label>
        <Select
          id="anki-plan"
          value={planId || undefined}
          disabled={busy || result !== null}
          onChange={(value) => {
            setPlanId(value);
            setTopicId("");
          }}
          options={planOptions}
        />
      </div>
      <div className="px-form-field">
        <label className="label" htmlFor="anki-topic">
          {t("cardBrowser.topic")}
        </label>
        <Select
          id="anki-topic"
          value={topicId}
          disabled={busy || result !== null || !planId}
          onChange={setTopicId}
          options={[
            ...(importing
              ? []
              : [{ value: "", label: t("cardBrowser.allTopics") }]),
            ...topics.map((topic) => ({ value: topic.id, label: topic.title })),
          ]}
        />
      </div>
    </>
  );

  return (
    <Modal
      open={open}
      title={t(importing ? "cardImport.title" : "cardExport.title")}
      onCancel={() => {
        if (!busy) onClose();
      }}
      closable={!busy}
      maskClosable={false}
      keyboard={!busy}
      destroyOnHidden
      className="px-anki-modal"
      cancelText={t(result ? "cardImport.done" : "cardBrowser.cancel")}
      cancelButtonProps={{ disabled: busy }}
      okText={
        !importing
          ? t("cardExport.run")
          : preview
            ? t("cardImport.run", { count: preview.cards })
            : t("cardImport.runPlain")
      }
      okButtonProps={{
        disabled: !ready,
        style: result ? { display: "none" } : undefined,
      }}
      confirmLoading={busy}
      onOk={() => void run()}
    >
      <div className="px-anki-body">
        {!plans.isPending && planOptions.length === 0 ? (
          <Notice tone="info">{t("cardImport.noExams")}</Notice>
        ) : result ? (
          <Notice tone={result.imported > 0 ? "info" : "warning"}>
            <span className="px-anki-result">
              <span>
                {t("cardImport.imported", { count: result.imported })}
              </span>
              {result.withHistory > 0 ? (
                <span>
                  {t("cardImport.keptHistory", { count: result.withHistory })}
                </span>
              ) : null}
              {result.duplicates > 0 ? (
                <span>
                  {t("cardImport.duplicates", { count: result.duplicates })}
                </span>
              ) : null}
              {result.unsupported > 0 ? (
                <span>
                  {t("cardImport.unsupported", { count: result.unsupported })}
                </span>
              ) : null}
              {result.empty > 0 ? (
                <span>{t("cardImport.empty", { count: result.empty })}</span>
              ) : null}
            </span>
          </Notice>
        ) : (
          <>
            <p className="small">
              {t(importing ? "cardImport.intro" : "cardExport.intro")}
            </p>
            {importing ? (
              <div className="px-anki-file">
                <Button
                  shape="round"
                  loading={picking}
                  disabled={busy}
                  onClick={() => void choose()}
                >
                  {t(file ? "cardImport.chooseOther" : "cardImport.choose")}
                </Button>
                {file ? (
                  <span className="px-anki-name" title={file.path}>
                    {fileName(file.path)}
                  </span>
                ) : null}
              </div>
            ) : null}
            {errorKey ? (
              <Notice tone="danger">{t(errorKey)}</Notice>
            ) : null}
            {preview ? (
              <p className="px-anki-preview" role="status">
                {preview.cards > 0
                  ? t("cardImport.found", { count: preview.cards })
                  : t("cardImport.foundNone")}
                {skipped > 0
                  ? ` ${t("cardImport.willSkip", { count: skipped })}`
                  : ""}
              </p>
            ) : null}
            {!importing || preview ? fields : null}
            {(importing ? (preview?.reviews ?? 0) > 0 : true) ? (
              <div className="px-anki-history">
                <Checkbox
                  checked={history}
                  disabled={busy}
                  onChange={(event) => setHistory(event.target.checked)}
                >
                  {t(
                    importing
                      ? "cardImport.history"
                      : "cardExport.history",
                    { count: preview?.reviews ?? 0 },
                  )}
                </Checkbox>
                <p className="small">
                  {t(
                    importing
                      ? "cardImport.historyHint"
                      : "cardExport.historyHint",
                  )}
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}
