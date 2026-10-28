import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Slider } from "antd";
import dayjs from "dayjs";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { PLAN_TITLE_MAX } from "@shared/plan-file";
import { FreeBooks } from "../../components/FreeBooks";
import { invoke } from "../../lib/ipc";
import {
  defaultGoal,
  formatGradeNumber,
  goalFraction,
  goalInput,
  goalRange,
  type GradeScale,
} from "../../lib/grade";
import { sourcesQuery, useSubjects } from "../../lib/queries";
import { ExamSessionsField } from "./ExamSessionsField";
import { emptyDraft, sessionsFromDrafts, type SessionDraft } from "./examSessions";
import { WizardSources } from "./WizardSources";
import { examChosen, type ExamChoice, type WizardSeed } from "./wizardSeed";
import "./PlanWizard.css";

type Style = "read" | "practice" | "decide";

/**
 * The answers for a new exam, shared by the exam wizard and the last two steps of first setup: the exam (name,
 * subject, date, goal) and its material. `scale` is the one the goal is shown on. The goal is stored as a fraction;
 * until the student moves it, it is the scale's default.
 */
export function useExamDraft({
  seed,
  books = false,
  scale,
}: {
  seed: WizardSeed | null;
  books?: boolean;
  scale: GradeScale;
}) {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const sources = useQuery({
    ...sourcesQuery,
    // A source just imported is still being read. Its status follows until it settles.
    refetchInterval: (query) =>
      query.state.data?.some((source) =>
        ["queued", "extracting", "indexing", "ocr-queued"].includes(source.status),
      )
        ? 1000
        : false,
  });
  const [title, setTitle] = useState(seed?.title ?? "");
  const [subject, setSubject] = useState(seed?.subject ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const [booksOpen, setBooksOpen] = useState(books);
  // Nothing is chosen for the student: a made-up deadline would start pushing simulations within days.
  const [examChoice, setExamChoice] = useState<ExamChoice>(seed?.examChoice ?? "");
  const [sessions, setSessions] = useState<SessionDraft[]>(
    seed?.sessions.length ? seed.sessions : [emptyDraft()],
  );
  const [goal, setGoal] = useState<number | null>(seed?.target ?? null);
  const [language, setLanguage] = useState<"it" | "en">(
    seed?.language ?? (i18n.language.startsWith("en") ? "en" : "it"),
  );
  const [style, setStyle] = useState<Style>("decide");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const target = goal ?? goalFraction(defaultGoal(scale), scale);
  const pick = (ids: string[]) =>
    setPicked((current) => [...current, ...ids.filter((id) => !current.includes(id))]);
  const chosenSources = (sources.data ?? []).filter((source) => picked.includes(source.id));
  const blockedSource = chosenSources.some((source) =>
    ["failed", "needs-ocr", "cancelled", "interrupted"].includes(source.status),
  );
  const examReady = Boolean(title.trim()) && examChosen(examChoice, sessions);

  /** Creates the exam and starts its build. Resolves with the new plan's id, or null when it did not start. */
  async function create(): Promise<string | null> {
    const name = title.trim();
    if (!name || starting) return null;
    setStartError(null);
    setStarting(true);
    try {
      const result = await invoke("plans.create", {
        title: name,
        subject: subject.trim() || undefined,
        sourceIds: picked,
        sessions: sessionsFromDrafts(sessions),
        target,
        language,
        style,
        topicTitles: picked.map(
          (id) => (sources.data ?? []).find((source) => source.id === id)?.title || "",
        ),
      });
      if (!result) return null;
      await client.invalidateQueries({ queryKey: ["plans"] });
      return result.planId;
    } catch (err) {
      const key =
        err && typeof err === "object" && "messageKey" in err
          ? String((err as { messageKey: unknown }).messageKey)
          : "";
      if (key !== "errors.aborted") setStartError(key || "wizard.failed");
      return null;
    } finally {
      setStarting(false);
    }
  }

  // PLAN-10: no material leads to the guided flow, which asks its own questions.
  function startGuided() {
    const answers: WizardSeed = {
      title: title.trim(),
      subject,
      examChoice,
      sessions,
      target,
      language,
    };
    navigate("/plans/new/guided", { state: answers });
  }

  return {
    scale,
    title,
    setTitle,
    subject,
    setSubject,
    examChoice,
    setExamChoice,
    sessions,
    setSessions,
    target,
    setGoal,
    language,
    setLanguage,
    style,
    setStyle,
    picked,
    pick,
    setPicked,
    booksOpen,
    setBooksOpen,
    sources,
    chosenSources,
    blockedSource,
    examReady,
    starting,
    startError,
    setStartError,
    create,
    startGuided,
  };
}

export type ExamDraft = ReturnType<typeof useExamDraft>;

/** The guide line under the goal: what the path stresses at that goal. */
function goalGuide(fraction: number): "60" | "75" | "90" {
  return fraction < 0.7 ? "60" : fraction < 0.9 ? "75" : "90";
}

/** Screen 1 of a new exam: its name and subject, the date, and the goal on the profile's scale. */
export function ExamStep({ draft }: { draft: ExamDraft }) {
  const { t, i18n } = useTranslation();
  const subjects = useSubjects();
  const goalId = useId();
  const { scale } = draft;
  const range = goalRange(scale);
  const value = goalInput(draft.target, scale);
  const shown = formatGradeNumber(value, i18n.language);
  const goalLabel = t("wizard.goalOn", { value: shown, scale });
  const examDays = sessionsFromDrafts(draft.sessions).map((session) => session.date);
  const examAt = examDays.length ? Math.min(...examDays) : null;
  const daysLeft =
    examAt != null ? dayjs(examAt).startOf("day").diff(dayjs().startOf("day"), "day") : null;
  const noDate = draft.examChoice === "none";
  return (
    <>
      <div className="px-wizard-row">
        <div className="px-form-field">
          <label className="label" htmlFor="plan-title">
            {t("wizard.planTitle")}
          </label>
          <Input
            id="plan-title"
            placeholder={t("wizard.planTitlePlaceholder")}
            maxLength={PLAN_TITLE_MAX}
            value={draft.title}
            onChange={(event) => draft.setTitle(event.target.value)}
          />
        </div>
        <div className="px-form-field">
          <label className="label" htmlFor="plan-subject">
            {t("wizard.subject")}
          </label>
          <Input
            id="plan-subject"
            placeholder={t("wizard.subjectPlaceholder")}
            list="plan-subjects"
            value={draft.subject}
            aria-describedby="plan-subject-help"
            onChange={(event) => {
              const next = event.target.value;
              // A subject picked from the list names the exam, unless the student already did.
              if (!draft.title.trim() && (subjects.data ?? []).some((item) => item.name === next))
                draft.setTitle(next);
              draft.setSubject(next);
            }}
          />
          <datalist id="plan-subjects">
            {(subjects.data ?? []).map((item) => (
              <option key={item.id} value={item.name} />
            ))}
          </datalist>
          <p id="plan-subject-help" className="small ink-muted">
            {t("wizard.subjectHelp")}
          </p>
        </div>
      </div>
      <div className="px-wizard-date">
        <ExamSessionsField
          idPrefix="plan"
          dateLabel={t("wizard.examDate")}
          value={draft.sessions}
          disabled={noDate}
          onChange={(next) => {
            if (next.some((row) => row.date)) draft.setExamChoice("");
            draft.setSessions(next);
          }}
        />
        <div className="px-wizard-date-line">
          <p className="small ink-muted" aria-live="polite">
            {examAt != null
              ? t(examDays.length > 1 ? "wizard.examSummaryMany" : "wizard.examSummary", {
                  count: examDays.length,
                  date: new Intl.DateTimeFormat(i18n.language, {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  }).format(examAt),
                }) +
                (daysLeft != null && daysLeft >= 0
                  ? `, ${t(daysLeft === 0 ? "wizard.daysLeftToday" : "wizard.daysLeft", { count: daysLeft })}`
                  : "")
              : t(noDate ? "wizard.noDateSummary" : "wizard.examRequired")}
          </p>
          <button
            type="button"
            className={noDate ? "choice is-selected px-wizard-chip" : "choice px-wizard-chip"}
            aria-pressed={noDate}
            onClick={() => {
              draft.setExamChoice(noDate ? "" : "none");
              // "No date yet" clears the days already picked; the rows keep their other fields for a second thought.
              if (!noDate) draft.setSessions([emptyDraft()]);
            }}
          >
            {t("wizard.noDate")}
          </button>
        </div>
      </div>
      <div className="px-wizard-goal" role="group" aria-labelledby={`${goalId}-label`}>
        <span className="label" id={`${goalId}-label`}>
          {t("wizard.targetStep")}
        </span>
        <div className="px-wizard-goal-body">
          <div className="px-wizard-target-value stat" aria-hidden>
            {shown}
            <span className="body">/{scale}</span>
          </div>
          <div>
            <Slider
              id="plan-target"
              className="px-wizard-gold-slider"
              min={range.min}
              max={range.max}
              step={range.step}
              value={value}
              onChange={(next) => draft.setGoal(goalFraction(next, scale))}
              ariaLabelForHandle={goalLabel}
              ariaValueTextFormatterForHandle={() => goalLabel}
              tooltip={{ open: false }}
              marks={Object.fromEntries(range.marks.map((mark) => [mark, String(mark)]))}
            />
            <p className="small ink-muted" aria-live="polite">
              {t(`wizard.targetGuide.${goalGuide(draft.target)}`)}
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Screen 2 of a new exam: the material, and below it the lesson language and order, which have defaults and open
 * only on Change.
 */
export function MaterialStep({ draft }: { draft: ExamDraft }) {
  const { t } = useTranslation();
  const [options, setOptions] = useState(false);
  const optionsId = useId();
  return (
    <>
      <WizardSources
        library={draft.sources.data ?? []}
        picked={draft.picked}
        onPick={draft.pick}
        onRemove={(id) => draft.setPicked((current) => current.filter((item) => item !== id))}
        onGuided={draft.startGuided}
        onFreeBooks={() => draft.setBooksOpen(true)}
        blocked={draft.blockedSource}
      />
      <div className="px-wizard-options-line">
        <p className="small ink-muted">
          {t("wizard.optionsSummary", {
            language: t(draft.language === "en" ? "wizard.inEnglish" : "wizard.inItalian"),
            style: t(`wizard.styleShort.${draft.style}`),
          })}
        </p>
        <Button
          type="text"
          size="small"
          shape="round"
          aria-expanded={options}
          aria-controls={optionsId}
          onClick={() => setOptions((open) => !open)}
        >
          {t(options ? "wizard.optionsHide" : "wizard.optionsChange")}
        </Button>
      </div>
      {options ? (
        <div id={optionsId} className="px-wizard-options">
          <fieldset className="px-wizard-fieldset">
            <legend className="label">{t("wizard.language")}</legend>
            <div className="choice-list">
              {(
                [
                  ["it", t("wizard.italian")],
                  ["en", t("wizard.english")],
                ] as const
              ).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  className={draft.language === id ? "choice is-selected" : "choice"}
                  aria-pressed={draft.language === id}
                  onClick={() => draft.setLanguage(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="small ink-muted">{t("wizard.languageLocked")}</p>
          </fieldset>
          <fieldset className="px-wizard-fieldset">
            <legend className="label">{t("wizard.style")}</legend>
            <div className="choice-list">
              {(
                [
                  ["read", t("wizard.read")],
                  ["practice", t("wizard.practice")],
                  ["decide", t("wizard.decide")],
                ] as const
              ).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  className={draft.style === id ? "choice is-selected" : "choice"}
                  aria-pressed={draft.style === id}
                  onClick={() => draft.setStyle(id)}
                >
                  <span className="body-strong">{label}</span>
                  <span className="small">{t(`wizard.styleHelp.${id}`)}</span>
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      ) : null}
      {draft.picked.length > 0 && !draft.title.trim() ? (
        <p id="wizard-create-reason" className="small" role="status">
          {t("wizard.titleRequired")}
        </p>
      ) : null}
      <FreeBooks
        open={draft.booksOpen}
        added={draft.picked}
        onClose={() => draft.setBooksOpen(false)}
        onAdded={(book) => {
          draft.pick([book.sourceId]);
          // A first book names the exam, unless the student already did.
          draft.setTitle((current) => current || book.title);
          draft.setSubject((current) => current || book.subject);
        }}
      />
    </>
  );
}

/**
 * The material step's main button: Create once something is picked. With nothing picked it continues to the guided
 * flow, which builds a draft without material (PLAN-10).
 */
export function MaterialPrimary({
  draft,
  onCreated,
}: {
  draft: ExamDraft;
  onCreated: (planId: string) => void;
}) {
  const { t } = useTranslation();
  // Adding material is the main action on that screen, so going on without any is a secondary button.
  if (draft.picked.length === 0)
    return (
      <Button shape="round" onClick={draft.startGuided}>
        {t("wizard.continue")}
      </Button>
    );
  const reason = !draft.title.trim() || draft.blockedSource;
  return (
    <Button
      type="primary"
      shape="round"
      loading={draft.starting}
      disabled={draft.starting || reason}
      aria-describedby={!draft.title.trim() ? "wizard-create-reason" : undefined}
      onClick={() =>
        void draft.create().then((planId) => {
          if (planId) onCreated(planId);
        })
      }
    >
      {t("wizard.create")}
    </Button>
  );
}
