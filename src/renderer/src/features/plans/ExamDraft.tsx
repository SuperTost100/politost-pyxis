import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AutoComplete, Button, Input, Slider } from "antd";
import dayjs from "dayjs";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { booksNamed } from "@shared/book-match";
import { PLAN_TITLE_MAX } from "@shared/plan-file";
import { useLeaveGuard } from "../../app/useLeaveGuard";
import { openBook } from "../../components/BookReaderBar";
import { closeSourceViewer, refreshSourceViewer } from "../../components/SourceViewer";
import { addBook, addFailure, useBookAdding } from "../../lib/bookAdding";
import { useFreeBooks } from "../../lib/freeBooks";
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
import { availableSeed, examChosen, type ExamChoice, type WizardSeed } from "./wizardSeed";
import "./PlanWizard.css";

type Style = "read" | "practice" | "decide";

const GUIDED_PATH = "/plans/new/guided";

/**
 * The answers for a new exam, shared by the exam wizard and the last two steps of first setup: the exam (name,
 * subject, date, goal) and its material. `scale` is the one the goal is shown on. The goal is stored as a fraction;
 * until the student moves it, it is the scale's default. The answers live only on this page, so leaving it with some
 * written asks first (`useLeaveGuard`), except for the guided flow, which takes them along.
 */
export function useExamDraft({
  seed,
  offers = false,
  scale,
}: {
  seed: WizardSeed | null;
  /** The material step is showing: only then is the free books catalog read, for the book the exam can be offered. */
  offers?: boolean;
  scale: GradeScale;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
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
  const [picked, setPicked] = useState<string[]>(seed?.picked ?? []);
  // The sources a chat's proposal seeded are checked once the Library is read: one removed or failed since leaves the
  // form, and the step says how many did.
  const [seedDropped, setSeedDropped] = useState(0);
  const seedChecked = useRef(!seed?.picked?.length);
  useEffect(() => {
    if (seedChecked.current || !sources.data) return;
    seedChecked.current = true;
    const { kept, dropped } = availableSeed(seed?.picked ?? [], sources.data);
    if (!dropped) return;
    setPicked((current) => current.filter((id) => kept.includes(id) || !seed?.picked?.includes(id)));
    setSeedDropped(dropped);
  }, [sources.data]);
  // A free PoliTost book named like the exam's subject or title, which the student does not have, is offered as one more
  // source, ticked. Leaving it out is remembered per book; nothing is downloaded until the exam is created with it ticked.
  const freeBooks = useFreeBooks(offers);
  const adding = useBookAdding();
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(() => new Set());
  const offered = booksNamed(
    [subject, title],
    (freeBooks.data ?? []).filter((book) => !book.sourceId),
  )[0];
  // Every book this exam was offered, kept once it has been seen. A book that is added (by this form, or from another
  // place while the form is open) leaves the offer and becomes a Library source, which the form then treats as any
  // picked source: the tick is whether that source is picked. A reader is bound to its book, so it keeps working on
  // that book when the offer moves on to another one.
  const [asked, setAsked] = useState<readonly string[]>([]);
  if (offered && !asked.includes(offered.id)) setAsked([...asked, offered.id]);
  const sourceOf = (bookId: string) => freeBooks.data?.find((book) => book.id === bookId)?.sourceId ?? null;
  const bookOn = offered !== undefined && !leftOut.has(offered.id);
  const setLeft = (id: string, left: boolean) =>
    setLeftOut((current) => {
      const next = new Set(current);
      if (left) next.add(id);
      else next.delete(id);
      return next;
    });
  /** Whether the book is in the exam: its source is picked once it is in the Library, otherwise it is the ticked offer. */
  const bookOnFor = (bookId: string) => {
    const source = sourceOf(bookId);
    return source ? picked.includes(source) : offered?.id === bookId && !leftOut.has(bookId);
  };
  const setBookOnFor = (bookId: string, on: boolean) => {
    const source = sourceOf(bookId);
    if (source) {
      if (on) setPicked((current) => (current.includes(source) ? current : [...current, source]));
      else setPicked((current) => current.filter((id) => id !== source));
      setLeft(bookId, !on);
    } else if (offered?.id === bookId) setLeft(bookId, !on);
  };
  const setBookOn = (on: boolean) => {
    if (offered) setBookOnFor(offered.id, on);
  };
  // A book ticked on this form that arrives in the Library by another add joins the exam, unless it was left out.
  const joined = useRef(new Set<string>());
  useEffect(() => {
    for (const id of asked) {
      const source = sourceOf(id);
      if (!source || joined.current.has(id)) continue;
      joined.current.add(id);
      if (!leftOut.has(id)) setPicked((current) => (current.includes(source) ? current : [...current, source]));
    }
  }, [asked, freeBooks.data]);
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
  // Everything the form holds, as the student left it. It differs from a blank form's when anything was written or
  // chosen, whichever field, so no list of fields can go stale here.
  const defaultLanguage = i18n.language.startsWith("en") ? "en" : "it";
  const snapshot = JSON.stringify({
    title: title.trim(),
    subject: subject.trim(),
    picked,
    examChoice,
    sessions: sessions.map(({ date, time, place, label }) => [date, time, place.trim(), label.trim()]),
    goal,
    language,
    style,
  });
  const blank = JSON.stringify({
    title: "",
    subject: "",
    picked: [],
    examChoice: "",
    sessions: [["", "", "", ""]],
    goal: null,
    language: defaultLanguage,
    style: "decide",
  });
  // What the guided flow was last handed, and so what its entry in the history holds. Going forward to it asks nothing
  // only while the form still holds exactly that; otherwise it would restore older answers.
  const handedOver = useRef<string | null>(seed ? snapshot : null);
  useLeaveGuard({
    dirty: starting || snapshot !== blank,
    body: t("wizard.leaveBody"),
    carries: (pathname) => pathname === GUIDED_PATH && snapshot === handedOver.current,
  });

  // What the form holds now. Creating the exam can wait on a download, and the student may go on choosing meanwhile: the
  // exam is made from what the form holds when the creation gets to it, so nothing they did in the meantime is lost.
  const now = useRef({ title, subject, picked, sources: sources.data, sessions, target, language, style, leftOut });
  now.current = { title, subject, picked, sources: sources.data, sessions, target, language, style, leftOut };

  /** Creates the exam and starts its build. Resolves with the new plan's id, or null when it did not start. */
  async function create(): Promise<string | null> {
    if (!title.trim() || starting) return null;
    setStartError(null);
    setStarting(true);
    try {
      let added: { sourceId: string; title: string } | null = null;
      if (offered && bookOn) {
        // The ticked book is downloaded now. If that fails the exam is not made, and the tick stays for another try.
        const result = await addBook(client, offered.id);
        if (!result) {
          setStartError(addFailure(offered.id) ?? "sources.books.offline");
          return null;
        }
        // It is a source of the form from here on, so a later failure keeps it, unless it was unticked meanwhile.
        if (!now.current.leftOut.has(offered.id)) {
          pick([result.sourceId]);
          added = result;
        }
      }
      const form = now.current;
      const name = form.title.trim() || title.trim();
      const sourceIds = added && !form.picked.includes(added.sourceId) ? [...form.picked, added.sourceId] : form.picked;
      const result = await invoke("plans.create", {
        title: name,
        subject: form.subject.trim() || undefined,
        sourceIds,
        sessions: sessionsFromDrafts(form.sessions),
        target: form.target,
        language: form.language,
        style: form.style,
        topicTitles: sourceIds.map(
          (id) => (form.sources ?? []).find((source) => source.id === id)?.title || (added?.sourceId === id ? added.title : ""),
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
    // This page's own entry keeps the answers, so going back to it from the guided flow finds them there.
    handedOver.current = snapshot;
    void Promise.resolve(
      navigate(`${location.pathname}${location.search}`, { replace: true, state: { wizard: answers, step: 1 } }),
    ).then(() => navigate(GUIDED_PATH, { state: answers }));
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
    seedDropped,
    offered,
    bookOn,
    setBookOn,
    bookOnFor,
    setBookOnFor,
    bookBusy: offered !== undefined && adding.adding.has(offered.id),
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
          {/* The app's own list, in its look and theme, of the subjects still in use; a new name is typed in. */}
          <AutoComplete
            value={draft.subject}
            options={(subjects.data ?? [])
              .filter((item) => item.inUse)
              .map((item) => ({ value: item.name }))}
            filterOption={(typed, option) =>
              (option?.value ?? "").toLocaleLowerCase().includes(typed.toLocaleLowerCase())
            }
            onChange={draft.setSubject}
            // A subject picked from the list names the exam, unless the student already did.
            onSelect={(picked: string) => {
              if (!draft.title.trim()) draft.setTitle(picked);
            }}
          >
            <Input
              id="plan-subject"
              placeholder={t("wizard.subjectPlaceholder")}
              aria-describedby="plan-subject-help"
            />
          </AutoComplete>
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
  // The reader opened on a book says whether it is in the exam, and follows the tick made on this page. It is bound to
  // the book it was opened for, and reads what is true when it is drawn or pressed, not what was when it opened.
  const latest = useRef(draft);
  latest.current = draft;
  // Once the exam is being created the choice is made: the reader shows it locked, as the page does.
  useEffect(() => refreshSourceViewer(), [draft.bookOn, draft.starting, draft.picked]);
  // A reader opened here belongs to this step: it closes when the form leaves it, whether back to the first step (where the
  // title or the subject can change and the book stop being the offer) or on to what follows, so it never says a book is in
  // an exam that no longer offers it.
  useEffect(() => closeSourceViewer, []);
  return (
    <>
      {draft.seedDropped ? (
        <p className="small ink-muted" role="status">
          {t("wizard.seedDropped", { count: draft.seedDropped })}
        </p>
      ) : null}
      <WizardSources
        library={draft.sources.data ?? []}
        picked={draft.picked}
        onPick={draft.pick}
        onRemove={(id) => draft.setPicked((current) => current.filter((item) => item !== id))}
        onGuided={draft.startGuided}
        offer={
          draft.offered
            ? {
                book: draft.offered,
                on: draft.bookOn,
                busy: draft.bookBusy || draft.starting,
                onToggle: draft.setBookOn,
                onOpen: () => {
                  const book = draft.offered;
                  if (book)
                    openBook(book.id, {
                      choice: {
                        words: "exam",
                        on: () => latest.current.bookOnFor(book.id),
                        set: (on) => latest.current.setBookOnFor(book.id, on),
                        locked: () => latest.current.starting,
                      },
                    });
                },
              }
            : undefined
        }
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
  // The step's one primary button always moves on: Continue without material, Create once something is picked.
  if (draft.picked.length === 0 && !draft.bookOn)
    return (
      <Button type="primary" shape="round" onClick={draft.startGuided}>
        {t("wizard.continue")}
      </Button>
    );
  const reason = !draft.title.trim() || draft.blockedSource;
  return (
    <Button
      type="primary"
      shape="round"
      loading={draft.starting}
      // While another place adds the offered book, creating the exam would ask for the same download.
      disabled={draft.starting || draft.bookBusy || reason}
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
