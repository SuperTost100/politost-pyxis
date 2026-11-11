import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "antd";
import { useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { Button } from "../../components/Button";
import { Logo } from "../../components/Logo";
import { invoke } from "../../lib/ipc";
import { refreshSubjects } from "../../lib/refreshSubjects";

type LibrarySource = RequestOutput<"sources.list">[number];
type Subject = RequestOutput<"subjects.list">[number];

const messageKeyOf = (err: unknown): string =>
  err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "sources.importFailed";

/** Files the student has to place: Pyxis could not tell, had no AI tool, or was stopped while choosing. */
export const isUnsorted = (source: Pick<LibrarySource, "sort">) =>
  source.sort === "stopped" || source.sort === "unsure" || source.sort === "no-ai";

/** Puts a source in a subject and reads the list and the subjects again. */
export function useMoveSource() {
  const client = useQueryClient();
  return async (sourceId: string, to: { subjectId: string } | { name: string }) => {
    await invoke("sources.move", { sourceId, ...to });
    void client.invalidateQueries({ queryKey: ["sources"] });
    void client.invalidateQueries({ queryKey: ["subjects"] });
  };
}

/** The value of the "Nuova materia…" option in a subject picker. */
const NEW = "\u0000new";

/**
 * "Da sistemare": the files whose subject the student chooses. The line above them says why they wait, and links
 * Settings when no AI tool is set up. The rows are the Library's own, each with a `SubjectPicker` in place of its state.
 */
export function UnsortedGroup({ sources, children }: { sources: LibrarySource[]; children: ReactNode }) {
  const { t } = useTranslation();
  const headId = useId();
  const reasons = new Set(sources.map((source) => source.sort));
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
      {reasons.has("unsure") ? <p className="small ink-muted">{t("sources.sort.unsure")}</p> : null}
      {reasons.has("stopped") ? <p className="small ink-muted">{t("sources.sort.stopped")}</p> : null}
      <ul className="px-list-surface">{children}</ul>
    </section>
  );
}

/** A file's subject, chosen by the student: the subjects they have, then "Nuova materia…". Choosing moves the file. */
export function SubjectPicker({
  source,
  subjects,
  onNewSubject,
  onError,
}: {
  source: LibrarySource;
  subjects: Subject[];
  /** Opens the dialog that names a new subject for this source. */
  onNewSubject: (source: LibrarySource) => void;
  onError: (key: string) => void;
}) {
  const { t } = useTranslation();
  const move = useMoveSource();
  return (
    <select
      className="px-ctl-field px-library-picker"
      aria-label={t("sources.sort.chooseFor", { title: source.title })}
      value=""
      onChange={(event) => {
        const value = event.target.value;
        if (value === NEW) onNewSubject(source);
        else if (value) void move(source.id, { subjectId: value }).catch((err) => onError(messageKeyOf(err)));
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

/** Names a new subject and moves the source into it. A name the student already has is that subject. */
export function NewSubjectDialog({ source, onClose }: { source: LibrarySource | null; onClose: () => void }) {
  const { t } = useTranslation();
  const move = useMoveSource();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fieldId = useId();
  const close = () => {
    setName("");
    setError(null);
    onClose();
  };
  const save = async () => {
    if (!source || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await move(source.id, { name: name.trim() });
      close();
    } catch (err) {
      setError(messageKeyOf(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={source !== null} title={t("sources.sort.newSubjectTitle")} footer={null} destroyOnHidden onCancel={close}>
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
          autoFocus
          autoComplete="off"
          maxLength={120}
          value={name}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        {error ? <p className="small px-library-flag">{t(error)}</p> : null}
        <div className="px-library-newsubject-actions">
          <Button variant="ghost" onClick={close}>
            {t("sources.sort.cancel")}
          </Button>
          <Button type="submit" disabled={!name.trim() || saving}>
            {t("sources.sort.newSubjectMove")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * What a Library row says about its subject: the working mark while Pyxis chooses it, and "Materia nuova" with Rinomina
 * on a file Pyxis made a subject for, until the student renames that subject.
 */
export function SortNote({ source, shared }: { source: LibrarySource; shared: number }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Escape leaves the field without saving, whatever the browser does with focus as it goes.
  const cancelled = useRef(false);
  if (source.sort === "working")
    return (
      <p className="small px-library-sorting" role="status">
        <Logo working decorative size={16} />
        {t("sources.sort.working")}
      </p>
    );
  if (source.sort !== "created" || !source.subjectId || !source.subject) return null;
  const name = source.subject;
  const subjectId = source.subjectId;
  const rename = async (next: string) => {
    setRenaming(false);
    try {
      await invoke("subjects.rename", { id: subjectId, name: next || name });
      setError(null);
    } catch (err) {
      setError(messageKeyOf(err));
    }
    void refreshSubjects(client);
  };
  return (
    <div className="px-library-newsubject">
      <p className="small">
        <strong>{t("sources.sort.createdTitle")}</strong> {t("sources.sort.created", { count: shared })}
      </p>
      {renaming ? (
        <input
          className="px-ctl-field"
          aria-label={t("sources.sort.renameLabel", { name })}
          autoFocus
          autoComplete="off"
          maxLength={120}
          defaultValue={name}
          onFocus={(event) => {
            cancelled.current = false;
            event.currentTarget.select();
          }}
          onBlur={(event) => {
            if (cancelled.current) setRenaming(false);
            else void rename(event.target.value.trim());
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              cancelled.current = true;
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          icon="pencil-line"
          aria-label={t("sources.sort.renameNamed", { name })}
          onClick={() => setRenaming(true)}
        >
          {t("sources.sort.rename")}
        </Button>
      )}
      {error ? <p className="small px-library-flag">{t(error)}</p> : null}
    </div>
  );
}
