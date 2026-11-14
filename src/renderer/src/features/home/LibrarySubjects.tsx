import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { Dialog } from "../../components/Dialog";
import { mixedReasons, unsortedReasons } from "./shelf";

type LibrarySource = RequestOutput<"sources.list">[number];
type Subject = RequestOutput<"subjects.list">[number];

const messageKeyOf = (err: unknown): string =>
  err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "sources.importFailed";

/** Files the student has to place: Pyxis could not tell, had no AI tool, or was stopped while choosing. */
export const isUnsorted = (source: Pick<LibrarySource, "sort">) =>
  source.sort === "stopped" || source.sort === "unsure" || source.sort === "no-ai";

/** The value of the "Nuova materia…" option in a subject picker. */
const NEW = "\u0000new";

/**
 * "Da sistemare": the files without a subject, whose subject the student chooses. The lines above them say why they
 * wait, and link Settings when no AI tool is set up. A file Pyxis is still choosing for says so in its row.
 */
export function UnsortedGroup({
  sources,
  more,
  children,
}: {
  sources: LibrarySource[];
  /** "Mostra tutti" when only the first rows show. */
  more?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const headId = useId();
  const reasons = unsortedReasons(sources);
  // With more than one reason in the group, each line says it is about some of the files.
  const mixed = mixedReasons(reasons);
  return (
    <section className="px-library-unsorted" aria-labelledby={headId}>
      <h2 id={headId} className="body-strong">
        {t("sources.sort.unsortedTitle")}
      </h2>
      {reasons.has("no-ai") ? (
        <p className="small ink-muted">
          {t("sources.sort.noAi")} <Link to="/settings/engines">{t("sources.sort.noAiLink")}</Link>
        </p>
      ) : null}
      {reasons.has("unsure") ? (
        <p className="small ink-muted">{t(mixed ? "sources.sort.unsureSome" : "sources.sort.unsure")}</p>
      ) : null}
      {reasons.has("none") ? <p className="small ink-muted">{t(mixed ? "sources.sort.noneSome" : "sources.sort.none")}</p> : null}
      {reasons.has("stopped") ? <p className="small ink-muted">{t("sources.sort.stopped")}</p> : null}
      {reasons.size === 1 && reasons.has("working") ? (
        <p className="small ink-muted">{t("sources.shelf.working")}</p>
      ) : null}
      <ul className="px-unsorted-card">{children}</ul>
      {more ? <div className="px-unsorted-more">{more}</div> : null}
    </section>
  );
}

/** A file's subject, chosen by the student: the subjects they have, then "Nuova materia…". Choosing moves the file. */
export function SubjectPicker({
  source,
  subjects,
  onPick,
  onNewSubject,
}: {
  source: LibrarySource;
  subjects: Subject[];
  onPick: (subjectId: string) => void;
  /** Opens the dialog that names a new subject for this source. */
  onNewSubject: () => void;
}) {
  const { t } = useTranslation();
  return (
    <select
      className="px-ctl-field px-library-picker"
      aria-label={t("sources.sort.chooseFor", { title: source.title })}
      value=""
      onChange={(event) => {
        const value = event.target.value;
        if (value === NEW) onNewSubject();
        else if (value) onPick(value);
      }}
    >
      <option value="">{t("sources.sort.choose")}</option>
      {subjects.map((subject) => (
        <option key={subject.id} value={subject.id}>
          {subject.name}
        </option>
      ))}
      <option value={NEW}>{t("sources.sort.newSubject")}</option>
    </select>
  );
}

/** Names a new subject and moves the source into it (`onMove`). A name the student already has is that subject. */
export function NewSubjectDialog({
  source,
  onClose,
  onMove,
}: {
  source: LibrarySource | null;
  onClose: () => void;
  onMove: (source: LibrarySource, name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fieldId = useId();
  const save = async () => {
    if (!source || !name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onMove(source, name.trim());
      onClose();
    } catch (err) {
      setError(messageKeyOf(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={source !== null}
      width="md"
      title={t("sources.sort.newSubjectTitle")}
      busy={saving}
      onClose={onClose}
      // The name and the error stay while it shrinks away.
      onClosed={() => {
        setName("");
        setError(null);
      }}
      actions={[
        { label: t("sources.sort.newSubjectMove"), disabled: !name.trim(), working: saving, onClick: () => void save() },
      ]}
    >
      <form
        className="px-library-newsubject-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="label" htmlFor={fieldId}>
          {t("sources.sort.newSubjectName")}
        </label>
        <input
          id={fieldId}
          className="px-ctl-field"
          autoComplete="off"
          maxLength={120}
          value={name}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        {error ? <p className="small px-library-flag">{t(error)}</p> : null}
      </form>
    </Dialog>
  );
}

