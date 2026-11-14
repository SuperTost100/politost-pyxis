import { Input } from "antd";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { Dialog, useConfirm, type ConfirmAnswer } from "../../components/Dialog";
import { MenuButton } from "../../components/ItemMenu";

const SUBJECTS = ["Analisi Matematica 2", "Fisica 1", "Geometria e algebra lineare"];
/** Enough rows to be taller than a 640px window, so the body scrolls under the title. */
const SHORTCUTS = [
  "newExam",
  "newChat",
  "search",
  "searchMenu",
  "settings",
  "back",
  "shortcuts",
  "zoomIn",
  "zoomOut",
  "actualSize",
  "send",
  "newLine",
  "stop",
  "flip",
  "rate",
  "undoCard",
  "editCard",
  "pick",
  "next",
  "dontKnow",
];

/** The one dialog in its three kinds: a confirmation that deletes, a form with a menu inside, and one that only informs. */
export function DialogGallery() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [answer, setAnswer] = useState<ConfirmAnswer | null>(null);
  // How many times the confirmation with work started it: a question answered once starts it once at most.
  const [runs, setRuns] = useState(0);
  const [form, setForm] = useState(false);
  const [info, setInfo] = useState(false);
  const [subject, setSubject] = useState(SUBJECTS[0]!);
  const topicId = useId();
  const howId = useId();

  return (
    <section className="gallery-card">
      <div className="gallery-card-head">
        <span className="label">{t("gallery.sections.layout")}</span>
        <h2 className="title-3">Dialog</h2>
        <p className="small">{t("gallery.dialogs.hint")}</p>
      </div>
      <div className="gallery-card-body gallery-row">
        <Button
          variant="secondary"
          onClick={async () =>
            setAnswer(
              await confirm({
                title: t("gallery.dialogs.deleteTitle"),
                body: t("gallery.dialogs.deleteBody"),
                confirm: t("gallery.dialogs.deleteConfirm"),
                tone: "danger",
                extra: t("gallery.dialogs.archiveInstead"),
              }),
            )
          }
        >
          {t("gallery.dialogs.confirmOpen")}
        </Button>
        <Button
          variant="secondary"
          onClick={async () =>
            setAnswer(
              await confirm({
                title: t("gallery.dialogs.deleteTitle"),
                body: t("gallery.dialogs.deleteBody"),
                confirm: t("gallery.dialogs.deleteConfirm"),
                tone: "danger",
                run: async () => setRuns((count) => count + 1),
              }),
            )
          }
        >
          {t("gallery.dialogs.runOpen")}
        </Button>
        <Button variant="secondary" onClick={() => setForm(true)}>
          {t("gallery.dialogs.formOpen")}
        </Button>
        <Button variant="secondary" onClick={() => setInfo(true)}>
          {t("gallery.dialogs.infoOpen")}
        </Button>
        <p className="small" role="status">
          {answer ? t("gallery.dialogs.answer", { answer: t(`gallery.dialogs.answers.${answer}`) }) : null}
        </p>
        <p className="small" role="status">
          {t("gallery.dialogs.runs", { count: runs })}
        </p>
      </div>

      <Dialog
        open={form}
        width="md"
        title={t("gallery.dialogs.formTitle")}
        onClose={() => setForm(false)}
        actions={[{ label: t("gallery.dialogs.formConfirm"), onClick: () => setForm(false) }]}
      >
        <div className="gallery-col">
          <span className="small">{t("gallery.dialogs.subject")}</span>
          <MenuButton
            label={t("gallery.dialogs.subjectChoose", { subject })}
            align="start"
            menu={{
              items: SUBJECTS.map((name) => ({ key: name, label: name })),
              onClick: ({ key }) => setSubject(key),
            }}
          >
            {subject}
          </MenuButton>
          <label className="small" htmlFor={topicId}>
            {t("gallery.dialogs.topic")}
          </label>
          <Input id={topicId} />
          <label className="small" htmlFor={howId}>
            {t("gallery.dialogs.how")} {t("gallery.dialogs.optional")}
          </label>
          <Input.TextArea id={howId} rows={2} placeholder={t("gallery.dialogs.howPlaceholder")} />
        </div>
      </Dialog>

      <Dialog open={info} cancel={false} title={t("gallery.dialogs.infoTitle")} onClose={() => setInfo(false)}>
        <ul className="gallery-col">
          {SHORTCUTS.map((id) => (
            <li key={id} className="body">
              {t(`shortcuts.rows.${id}`)}
            </li>
          ))}
        </ul>
      </Dialog>
    </section>
  );
}
