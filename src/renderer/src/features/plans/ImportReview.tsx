import { useQuery } from "@tanstack/react-query";
import { Button, Select } from "antd";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PlanFile, PlanFilePart, PlanFileReason } from "@shared/plan-file";
import { Dialog } from "../../components/Dialog";
import { FileIcon } from "../../components/FileIcon";
import { Icon, type IconName } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { Working } from "../../components/Working";
import { invoke } from "../../lib/ipc";
import {
  defaultChoices,
  importFailure,
  importRequest,
  locatedData,
  previewPlan,
  type ImportRequest,
  type PlanPreview,
  type PreviewTopic,
  type SourceChoice,
} from "./importPreview";
import type { PlanOrigin } from "./openedPlan";
import "./ExamPage.css";
import "./PlanPath.css";
import "./ImportReview.css";
import { formatBytes } from "@shared/format-bytes";
import { useSources } from "../../lib/queries";

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** "shared by Marco Bianchi on 12 November 2026": who made the file and when, as far as the file says. */
function sharedLine(preview: PlanPreview, t: Translate, language: string): string | null {
  const date = preview.createdAt
    ? new Date(preview.createdAt).toLocaleDateString(language, { day: "numeric", month: "long", year: "numeric" })
    : null;
  if (preview.author && date) return t("shared.review.sharedBy", { author: preview.author, date });
  if (preview.author) return t("shared.review.sharedByOnly", { author: preview.author });
  return date ? t("shared.review.created", { date }) : null;
}

/** "Written Tuesday 2 February 2027, at 09:00": the exam day the file carries. */
function examLine(preview: PlanPreview, t: Translate, language: string): string | null {
  if (!preview.exam) return null;
  const day = new Intl.DateTimeFormat(language, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(
    preview.exam.at,
  );
  const time = preview.exam.time ? `, ${t("shared.review.at", { time: preview.exam.time })}` : "";
  return `${preview.exam.label || t("shared.review.exam")} ${day}${time}`;
}

/** What the file holds for one topic: "3 lessons · quiz · 14 flashcards · 1 map". */
function topicLine(topic: PreviewTopic, t: Translate): string {
  return [
    topic.lessons > 0 ? t("shared.review.counts.lessons", { count: topic.lessons }) : null,
    topic.quizzes > 0 ? t("shared.review.topicQuiz") : null,
    topic.cards > 0 ? t("shared.review.counts.cards", { count: topic.cards }) : null,
    topic.maps > 0 ? t("shared.review.counts.maps", { count: topic.maps }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What comes with the file, one line each, and whether the progress comes along. */
function ImportFacts({ preview, withTopics }: { preview: PlanPreview; withTopics?: boolean }) {
  const { t } = useTranslation();
  const { counts } = preview;
  const count = (key: keyof typeof counts) => t(`shared.review.counts.${key}`, { count: counts[key] });
  const rows: Array<[IconName, string]> = [];
  if (withTopics && counts.topics > 0) rows.push(["compass", count("topics")]);
  if (counts.lessons > 0) rows.push(["book-open", count("lessons")]);
  const practice = [counts.quizzes > 0 ? count("quizzes") : null, counts.exercises > 0 ? count("exercises") : null].filter(
    Boolean,
  );
  if (practice.length) rows.push(["list-checks", practice.join(t("shared.review.and"))]);
  if (counts.cards > 0) rows.push(["layers", count("cards")]);
  if (counts.maps > 0) rows.push(["network", count("maps")]);
  const author = preview.author;
  return (
    <>
      {rows.length ? (
        <ul className="px-import-facts">
          {rows.map(([icon, text]) => (
            <li key={icon}>
              <Icon name={icon} size={16} />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="px-import-progress">
        {preview.progress
          ? author
            ? t("shared.review.progressYes", { author })
            : t("shared.review.progressYesAnon")
          : author
            ? t("shared.review.progressNo", { author })
            : t("shared.review.progressNoAnon")}
      </p>
    </>
  );
}

/**
 * What a validated plan file holds and how each missing original is handled. Nothing is written until the student
 * adds the exam. The page and the dialog arrange the parts their own way.
 */
function useImportReview({
  file,
  onImport,
}: {
  file: PlanFile;
  onImport: (request: ImportRequest) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const library = useSources();
  const preview = useMemo(
    () => previewPlan(file, library.data ?? []),
    [file, library.data],
  );
  const [picked, setPicked] = useState<Record<number, SourceChoice>>({});
  const [located, setLocated] = useState<Record<number, string>>({});
  const [wrong, setWrong] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<
    boolean | { reason: PlanFileReason; without: PlanFilePart[] }
  >(false);
  // The same file imported before, if that plan is still here. Importing it again is allowed, with the date shown.
  const earlier = useQuery({
    queryKey: ["plans", "importedFile", file.id, file.createdAt],
    queryFn: () => invoke("plans.importedFile", { id: file.id!, createdAt: file.createdAt! }),
    enabled: file.id !== undefined && file.createdAt !== undefined,
    gcTime: 0,
  });
  const pending = useRef(false);
  const locating = useRef<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const ids = useId();
  const choices = { ...defaultChoices(preview), ...picked };
  // A choice that cannot work yet (file not verified, library copy gone) blocks the import instead of falling back.
  const unresolved = preview.missing.some(
    (source) =>
      (choices[source.index] === "file" && !located[source.index]) ||
      (choices[source.index] === "library" && !source.libraryId),
  );

  async function verify(index: number, chosen: Blob) {
    const source = file.sources?.[index];
    if (!source) return;
    const data = await locatedData(source, chosen).catch(() => null);
    setWrong(data ? null : index);
    setLocated((current) => {
      const next = { ...current };
      if (data) next[index] = data;
      else delete next[index];
      return next;
    });
  }

  async function submit(without?: PlanFilePart[]) {
    if (pending.current || unresolved) return;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await onImport({ ...importRequest(file, preview, choices, located), ...(without ? { without } : {}) });
    } catch (error) {
      setFailed(importFailure(error) ?? true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const options: Array<{ value: SourceChoice; label: string }> = [
    { value: "library", label: t("shared.review.library") },
    { value: "file", label: t("shared.review.file") },
    { value: "excerpts", label: t("shared.review.excerpts") },
    { value: "skip", label: t("shared.review.skip") },
  ];

  const warnings =
    preview.generalTopics > 0 || earlier.data ? (
      <div className="px-import-notices">
        {preview.generalTopics > 0 ? <Notice tone="warning">{t("plans.draft")}</Notice> : null}
        {earlier.data ? (
          <Notice tone="warning">
            {t("shared.review.duplicate", {
              date: new Date(earlier.data.importedAt).toLocaleDateString(i18n.language),
            })}
          </Notice>
        ) : null}
      </div>
    ) : null;

  // Every original the file names: the ones inside it go to the Library, the others need a choice.
  const material = preview.sources.length ? (
    <>
      {preview.missing.length ? (
        <>
          <p className="px-import-help">{t("shared.review.missingHelp")}</p>
          <input
            ref={picker}
            type="file"
            hidden
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              event.target.value = "";
              const index = locating.current;
              if (chosen && index !== null) void verify(index, chosen);
            }}
          />
        </>
      ) : null}
      <div className="px-import-sources">
        {preview.sources.map((source) => {
          const selectId = `${ids}-source-${source.index}`;
          const titleId = `${selectId}-title`;
          return (
            <div key={source.index} className="px-import-source" role="group" aria-labelledby={titleId}>
              <b id={titleId}>{source.title}</b>
              <small>
                {source.embedded
                  ? t("shared.review.inFile", { size: formatBytes(source.bytes, i18n.language) })
                  : source.libraryId
                    ? t("shared.review.inLibrary")
                    : [
                        t("shared.review.notInFile"),
                        source.excerpts > 0 ? t("shared.review.excerptKept", { count: source.excerpts }) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
              </small>
              {source.embedded ? null : (
                <>
                  <label className="visually-hidden" htmlFor={selectId}>
                    {t("shared.review.choiceFor", { title: source.title })}
                  </label>
                  <Select
                    id={selectId}
                    className="px-import-select"
                    value={choices[source.index]}
                    disabled={busy}
                    options={options.filter((option) => option.value !== "library" || source.libraryId)}
                    onChange={(value: SourceChoice) => setPicked((current) => ({ ...current, [source.index]: value }))}
                  />
                  {choices[source.index] === "skip" ? <p className="px-import-help">{t("shared.review.skipHelp")}</p> : null}
                  {choices[source.index] === "file" ? (
                    <div className="px-import-locate">
                      <Button
                        shape="round"
                        size="small"
                        disabled={busy}
                        onClick={() => {
                          locating.current = source.index;
                          picker.current?.click();
                        }}
                      >
                        {t("shared.review.choose")}
                      </Button>
                      {located[source.index] ? (
                        <span className="small" role="status">
                          {t("shared.review.verified")}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {wrong === source.index ? <Notice tone="warning">{t("shared.review.mismatch")}</Notice> : null}
                </>
              )}
            </div>
          );
        })}
      </div>
    </>
  ) : null;

  const failure =
    typeof failed === "object" ? (
      <Notice
        tone="danger"
        action={
          failed.without.length
            ? { label: t("shared.fail.rest"), onClick: () => void submit(failed.without) }
            : undefined
        }
      >
        {t("shared.fail.failed", { reason: t(`shared.reason.${failed.reason}`) })}
        {failed.without.length
          ? ` ${t("shared.fail.offer", { where: t(`shared.fail.in.${failed.without.length > 1 ? "both" : failed.without[0]}`) })}`
          : ""}
      </Notice>
    ) : failed ? (
      <Notice tone="danger">{t("shared.importFailed")}</Notice>
    ) : null;

  return {
    preview,
    title: preview.title,
    warnings,
    material,
    failure,
    busy,
    unresolved,
    confirm: t(earlier.data ? "shared.review.importCopy" : "shared.review.import"),
    submit: () => void submit(),
  };
}

/**
 * The review as a page: the exam as it will be, with the file's name and size, who shared it and when above the title,
 * its path of topics on the left and on the right what comes with the file and what to do with its material. The
 * footer adds it. While it is added the work shows in the footer and the path is held still; afterwards the page is the
 * exam itself (the caller moves there). Everything in the file is shown as text.
 */
export function ImportReview({
  file,
  origin,
  onImport,
  onCancel,
}: {
  file: PlanFile;
  origin?: PlanOrigin;
  onImport: (request: ImportRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const review = useImportReview({ file, onImport });
  const { preview } = review;
  const titleId = useId();
  const sourcesId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // The page arrives by a move or a file dropped on the window: the screen reader starts at what it is about.
  useEffect(() => heading.current?.focus(), []);
  const meta = [examLine(preview, t, i18n.language), sharedLine(preview, t, i18n.language)].filter(Boolean).join(" · ");
  const exam = preview.exam;
  return (
    <section className="px-import-review px-import-page px-exam px-import" aria-labelledby={titleId}>
      <header className="px-exam-head">
        <div className="px-exam-name">
          {origin ? (
            <p className="px-import-file">
              <FileIcon />
              <span>
                {origin.name} · {formatBytes(origin.bytes, i18n.language)}
              </span>
            </p>
          ) : null}
          <h1 id={titleId} ref={heading} tabIndex={-1} className="title-1">
            {review.title}
          </h1>
          {meta ? <p className="px-exam-date">{meta}</p> : null}
        </div>
      </header>
      {review.warnings}
      <div className="px-import-grid">
        {preview.path.length || exam ? (
          <div className="px-exam-path">
            <h2 className="px-exam-sech">{t("shared.review.path")}</h2>
            <ol className={review.busy ? "px-xpath-list is-adding" : "px-xpath-list"} aria-label={t("shared.review.path")}>
              {preview.path.map((topic, index) => {
                const line = topicLine(topic, t);
                return (
                  <li key={index} className="px-xpath-row is-topic is-later">
                    <span className="px-xpath-mk" aria-hidden>
                      {index + 1}
                    </span>
                    <div className="px-xpath-head">
                      <span className="px-xpath-title">{topic.title}</span>
                      {line ? <span className="px-xpath-sub">{line}</span> : null}
                    </div>
                  </li>
                );
              })}
              {exam ? (
                <li className="px-xpath-row is-later is-goal">
                  <span className="px-xpath-mk" aria-hidden>
                    <Icon name="star" size={16} />
                  </span>
                  <div className="px-xpath-head">
                    <span className="px-xpath-title">{exam.label || t("shared.review.exam")}</span>
                    <span className="px-xpath-sub">
                      {new Intl.DateTimeFormat(i18n.language, { weekday: "long", day: "numeric", month: "long" }).format(
                        exam.at,
                      )}
                    </span>
                  </div>
                </li>
              ) : null}
            </ol>
          </div>
        ) : null}
        <aside className="px-exam-aside">
          <section className="px-exam-asec" aria-labelledby={`${titleId}-arrive`}>
            <h2 id={`${titleId}-arrive`}>{t("shared.review.arrive")}</h2>
            <ImportFacts preview={preview} />
          </section>
          {review.material ? (
            <section className="px-exam-asec" aria-labelledby={sourcesId}>
              <h2 id={sourcesId}>
                {t("shared.review.material")}
                <span>{t("shared.review.sources", { count: preview.sources.length })}</span>
              </h2>
              {review.material}
            </section>
          ) : null}
        </aside>
      </div>
      {review.failure ? <div className="px-import-notices">{review.failure}</div> : null}
      <div className="px-import-foot" role="region" aria-label={t("shared.review.footer")} aria-busy={review.busy}>
        {review.busy ? (
          <Working className="px-import-working" line={t("shared.review.adding")} />
        ) : (
          <p className="px-import-note">{t("shared.review.note")}</p>
        )}
        <div className="px-import-foot-buttons">
          <Button type="text" shape="round" disabled={review.busy} onClick={onCancel}>
            {t("shared.review.cancel")}
          </Button>
          <Button type="primary" shape="round" size="large" loading={review.busy} disabled={review.unresolved} onClick={review.submit}>
            {review.confirm}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** The review as a dialog over the page that picked the file: the buttons are the dialog's own. */
export function ImportReviewDialog({
  open,
  file,
  onImport,
  onClose,
  onClosed,
}: {
  open: boolean;
  file: PlanFile;
  onImport: (request: ImportRequest) => Promise<void>;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { t, i18n } = useTranslation();
  const review = useImportReview({ file, onImport });
  const meta = sharedLine(review.preview, t, i18n.language);
  const body = (text: ReactNode) => <p className="body-strong">{text}</p>;
  return (
    <Dialog
      open={open}
      width="lg"
      title={t("shared.review.title")}
      busy={review.busy}
      // The choices made for each missing original would be lost by a stray click.
      outside="none"
      onClose={onClose}
      onClosed={onClosed}
      actions={[
        { label: review.confirm, disabled: review.unresolved, working: review.busy, onClick: review.submit },
      ]}
    >
      <section className="px-import-review" aria-labelledby="import-review-title">
        <h3 id="import-review-title" className="title-3">
          {review.title}
        </h3>
        {meta ? <p className="small ink-muted">{meta}</p> : null}
        {body(t("shared.review.arrive"))}
        <ImportFacts preview={review.preview} withTopics />
        {review.warnings}
        {review.material ? (
          <>
            {body(t("shared.review.material"))}
            {review.material}
          </>
        ) : null}
        {review.failure}
      </section>
    </Dialog>
  );
}
