import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, InputNumber, Modal, Slider } from "antd";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BookMarked,
  BookOpen,
  Clock,
  FileText,
  Layers,
  ListChecks,
  Plus,
  RefreshCw,
  Repeat,
  Target,
  Trash2,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useBlocker, useNavigate, useParams } from "react-router";
import { PLAN_TITLE_MAX } from "@shared/plan-file";
import { ErrorState } from "../../components/ErrorState";
import { Notice } from "../../components/Notice";
import { Tag } from "../../components/Tag";
import { errorDetails } from "../../lib/errorDetails";
import { goalFraction, goalInput, goalRange } from "../../lib/grade";
import { invoke } from "../../lib/ipc";
import { engineFeaturesQuery, enginesQuery, usePlan } from "../../lib/queries";
import { refreshPlan } from "../../lib/refreshPlan";
import { useGradeScale } from "../../lib/useGradeScale";
import { decimalSeparator, formatMinutes } from "../home/plannerFormat";
import { CalendarButton } from "../share/CalendarButton";
import { ExportButton } from "../share/ExportButton";
import { AttachSourcesDialog } from "./AttachSourcesDialog";
import { setPlanArchived } from "./archivePlan";
import { saveThenRefresh } from "./examSettingsData";
import { ExamSessionsField } from "./ExamSessionsField";
import { RebuildDialog } from "./RebuildDialog";
import {
  draftsFromSessions,
  emptyDraft,
  MAX_EXAM_SESSIONS,
  nextUpcomingDay,
  sameSessions,
  sessionsFromDrafts,
  type SessionDraft,
} from "./examSessions";
import "./PlanPage.css";
import "./ExamSettings.css";

/** The engine tasks an exam uses, in the order Settings › AI engines lists them. */
const examFeatures = ["plan", "lesson", "cards", "grading", "map"] as const;
type Change = "name" | "sessions" | "goal" | "hours";

/** One group of the page: what it controls on the left, the controls on the right. */
function Group({
  id,
  title,
  help,
  changed,
  children,
}: {
  id: string;
  title: string;
  help?: ReactNode;
  changed?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="px-set-group" aria-labelledby={`set-${id}`}>
      <header>
        <h2 className="body-strong" id={`set-${id}`}>
          {title}
        </h2>
        {help ? <p className="small ink-muted">{help}</p> : null}
        {changed ? (
          <Tag icon="pencil-line">{t("examSettings.changed")}</Tag>
        ) : null}
      </header>
      <div className="px-set-body">{children}</div>
    </section>
  );
}

/** A row that names an action, says what it does, and holds its button. */
function ActionRow({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <div className="px-set-action">
      <div>
        <p className="body-strong">{title}</p>
        <p className="small ink-muted">{help}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * Everything a student can change about an exam after creating it, one group per row. Edits wait in a bar at the
 * bottom that names them; actions (rebuild, export, calendar, archive, delete) work at once and ask in their own dialog.
 */
export function ExamSettingsPage() {
  const { t, i18n } = useTranslation();
  const grade = useGradeScale();
  const { planId = "" } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const plan = usePlan(planId);
  const planner = useQuery({
    queryKey: ["plans", "planner"],
    queryFn: () => invoke("plans.planner", {}),
  });
  const engines = useQuery(enginesQuery);
  const features = useQuery(engineFeaturesQuery);
  // Each edit is null until the student touches it, so an untouched value is saved back exactly as stored.
  const [title, setTitle] = useState<string | null>(null);
  const [goal, setGoal] = useState<number | null>(null);
  const [sessions, setSessions] = useState<SessionDraft[] | null>(null);
  const [hours, setHours] = useState<{ value: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const leaving = useRef(false);
  const footprint = useQuery({
    queryKey: ["plan-footprint", planId],
    queryFn: () => invoke("plans.footprint", { planId }),
    enabled: deleteOpen && !!planId,
  });

  const data = plan.data;
  const savedSessions = useMemo(() => {
    const drafts = draftsFromSessions(data?.sessions ?? []);
    return drafts.length ? drafts : [emptyDraft()];
  }, [data?.sessions]);
  const savedGoal = data ? goalInput(data.target, grade.scale) : 0;
  const savedHours = planner.data?.weeklyHours ?? null;
  const shownTitle = title ?? data?.title ?? "";
  const shownGoal = goal ?? savedGoal;
  const shownSessions = sessions ?? savedSessions;
  const shownHours = hours ? hours.value : savedHours;
  const changed: Record<Change, boolean> = {
    name: title !== null && title.trim() !== data?.title,
    sessions: sessions !== null && !sameSessions(sessions, savedSessions),
    goal: goal !== null && goal !== savedGoal,
    hours: hours !== null && planner.isSuccess && hours.value !== savedHours,
  };
  const changes = (Object.keys(changed) as Change[]).filter((key) => changed[key]);
  const dirty = changes.length > 0;
  const nameMissing = shownTitle.trim() === "";
  const listFormat = new Intl.ListFormat(i18n.language.startsWith("it") ? "it" : "en-GB", {
    style: "long",
    type: "conjunction",
  });
  const changeList = listFormat.format(changes.map((key) => t(`examSettings.change.${key}`)));

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
  );

  function discard() {
    setTitle(null);
    setGoal(null);
    setSessions(null);
    setHours(null);
    setError(false);
  }
  async function action(run: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(false);
    try {
      await run();
    } catch {
      setError(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function save() {
    if (!data || nameMissing) return;
    const steps: Array<() => Promise<unknown>> = [];
    if (changed.name || changed.sessions || changed.goal)
      steps.push(() =>
        invoke("plans.settings", {
          planId,
          title: shownTitle.trim(),
          // An untouched goal stays as stored: on another scale its rounded input would move it.
          target: changed.goal ? goalFraction(shownGoal, grade.scale) : data.target,
          // Noon on each day, as in the wizard, so a shared plan keeps its days in another time zone.
          sessions: sessionsFromDrafts(shownSessions),
        }),
      );
    if (changed.hours) steps.push(() => invoke("plans.plannerHours", { hours: shownHours }));
    void action(async () => {
      // If the hours fail after the settings were stored, the plan is read again, so only the hours stay unsaved.
      await saveThenRefresh(steps, () => refreshPlan(client, planId));
      discard();
    });
  }
  function archive(archived: boolean) {
    void action(async () => {
      await setPlanArchived(client, planId, archived);
      setDeleteOpen(false);
      navigate(`/plans/${planId}`);
    });
  }
  function remove() {
    void action(async () => {
      await invoke("plans.delete", { planId });
      leaving.current = true;
      await client.invalidateQueries({ queryKey: ["plans"] });
      navigate("/exams");
    });
  }

  if (plan.isError || (plan.isSuccess && !data)) {
    const toExams = { label: t("nav.toExams"), onClick: () => navigate("/exams") };
    return plan.isError ? (
      <ErrorState
        action={{ label: t("components.notice.retry"), onClick: () => void plan.refetch() }}
        secondary={toExams}
        details={errorDetails(plan.error)}
      >
        {t("planOverview.unavailable")}
      </ErrorState>
    ) : (
      <ErrorState action={toExams}>{t("planOverview.gone")}</ErrorState>
    );
  }

  const range = goalRange(grade.scale);
  const upcomingDay = nextUpcomingDay(savedSessions);
  const calendarBlocked = changed.sessions
    ? t("calendar.saveFirst")
    : !data?.sessions.length
      ? t("calendar.oneNoDate")
      : upcomingDay === null
        ? t("calendar.onePast")
        : undefined;
  const thisWeek = planner.data?.weeks[0]?.plans.find((item) => item.planId === planId)?.minutes ?? 0;
  const language = data?.contentLanguage;
  const archived = data?.archivedAt != null;
  const counts = footprint.data;

  return (
    <div className="px-exam-settings">
      <Link to={`/plans/${planId}`} className="px-plan-back">
        <ArrowLeft size={16} aria-hidden />
        {data?.title ?? t("doors.exams")}
      </Link>
      <h1 className="title-1">{t("planOverview.settings")}</h1>
      {/* A plan still being built cannot be saved; its page leads back to the build. */}
      {data?.status === "building" ? <p className="body">{t("wizard.buildInProgress")}</p> : null}
      {data && data.status !== "building" ? (
        <>
          <Group id="exam" title={t("examSettings.examHeading")} help={t("examSettings.examHelp")} changed={changed.name}>
            <div className="px-form-field">
              <label className="label" htmlFor="set-title">
                {t("wizard.planTitle")}
              </label>
              <Input
                id="set-title"
                value={shownTitle}
                maxLength={PLAN_TITLE_MAX}
                disabled={busy}
                status={nameMissing ? "error" : undefined}
                aria-invalid={nameMissing || undefined}
                aria-describedby={nameMissing ? "set-title-error" : undefined}
                onChange={(event) => setTitle(event.target.value)}
              />
              {nameMissing ? (
                <p className="small px-set-error" id="set-title-error">
                  {t("examSettings.nameRequired")}
                </p>
              ) : null}
            </div>
            <dl className="px-set-fixed">
              <div>
                <dt className="label">{t("examSettings.subject")}</dt>
                <dd className="body">{data.subject ?? t("examSettings.noSubject")}</dd>
              </div>
              <div>
                <dt className="label">{t("examSettings.language")}</dt>
                <dd className="body">
                  {language === "it"
                    ? t("wizard.italian")
                    : language === "en"
                      ? t("wizard.english")
                      : (language ?? i18n.language)}
                </dd>
              </div>
            </dl>
            <p className="small ink-muted">{t("examSettings.fixedHint")}</p>
          </Group>

          <Group
            id="sessions"
            title={t("examSettings.sessionsHeading")}
            help={t("examSettings.sessionsHelp", { max: MAX_EXAM_SESSIONS })}
            changed={changed.sessions}
          >
            <ExamSessionsField
              idPrefix="settings"
              dateLabel={t("wizard.exam")}
              value={shownSessions}
              onChange={setSessions}
              disabled={busy}
            />
          </Group>

          <Group id="goal" title={t("examSettings.goalHeading")} help={t("examSettings.goalHelp")} changed={changed.goal}>
            <div className="px-set-goal">
              <p className="px-set-goal-value" aria-hidden>
                {shownGoal}
                <small>/{grade.scale}</small>
              </p>
              <div>
                <Slider
                  min={range.min}
                  max={range.max}
                  step={range.step}
                  marks={Object.fromEntries(range.marks.map((mark) => [mark, String(mark)]))}
                  value={shownGoal}
                  disabled={busy}
                  onChange={(value) => setGoal(value)}
                  ariaLabelForHandle={t("examSettings.goalLabel", { scale: grade.scale })}
                  ariaValueTextFormatterForHandle={(value) => `${value ?? ""}/${grade.scale}`}
                  tooltip={{ open: false }}
                />
                {changed.goal ? (
                  <p className="small ink-muted">
                    {t("examSettings.goalBefore", { value: grade.format(data.target) })}
                  </p>
                ) : null}
              </div>
            </div>
          </Group>

          <Group id="hours" title={t("examSettings.hoursHeading")} help={t("examSettings.hoursHelp")} changed={changed.hours}>
            <div className="px-set-hours">
              <InputNumber
                id="set-hours"
                aria-label={t("examSettings.hoursLabel")}
                min={0}
                max={100}
                step={1}
                decimalSeparator={decimalSeparator(i18n.language)}
                value={shownHours}
                disabled={busy || !planner.isSuccess}
                onChange={(value) => setHours({ value: typeof value === "number" ? value : null })}
              />
              <label htmlFor="set-hours" className="body">
                {t("examSettings.hoursUnit")}
              </label>
            </div>
            {planner.data?.neededHours != null && !changed.hours ? (
              <p className="small ink-muted">
                {t("planner.needed", {
                  hours: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(
                    planner.data.neededHours,
                  ),
                })}
              </p>
            ) : null}
            <p className="small ink-muted">
              {thisWeek > 0 && !changed.hours
                ? `${t("examSettings.hoursThisWeek", { time: formatMinutes(t, thisWeek) })} `
                : null}
              <Link to="/exams/planner">{t("examSettings.openPlanner")}</Link>
            </p>
          </Group>

          <Group id="sources" title={t("examSettings.sourcesHeading")} help={t("examSettings.sourcesHelp")}>
            {data.sources.length ? (
              <ul className="px-set-sources" aria-labelledby="set-sources">
                {data.sources.map((source) => (
                  <li key={source.id}>
                    {source.kind === "smartbook" ? (
                      <BookMarked size={18} strokeWidth={1.75} aria-hidden />
                    ) : (
                      <FileText size={18} strokeWidth={1.75} aria-hidden />
                    )}
                    <div>
                      <p className="body">{source.title}</p>
                      <p className="small ink-muted">
                        {[
                          t(`sources.kind.${source.kind}`, { defaultValue: source.kind }),
                          t("sources.sectionCount", { count: source.sections }),
                        ].join(" · ")}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="body ink-muted">{t("planOverview.noSources")}</p>
            )}
            <div className="px-set-buttons">
              <Button shape="round" icon={<Plus size={16} aria-hidden />} disabled={busy} onClick={() => setAttachOpen(true)}>
                {t("planOverview.addSources")}
              </Button>
              <Link to={`/plans/${planId}/sources`}>{t("examSettings.openSources")}</Link>
            </div>
          </Group>

          <Group id="engines" title={t("examSettings.enginesHeading")} help={t("examSettings.enginesHelp")}>
            <dl className="px-set-engines">
              {examFeatures.map((feature) => {
                const selection = features.data?.[feature] ?? features.data?.default;
                const name =
                  engines.data?.find((row) => row.id === selection?.provider)?.name ?? selection?.provider;
                return (
                  <div key={feature}>
                    <dt className="ink-muted">{t(`engines.feature.${feature}`)}</dt>
                    <dd>
                      {selection ? (
                        <>
                          {name} · <span className="code ink-muted">{selection.model}</span>
                        </>
                      ) : features.isSuccess ? (
                        t("engines.auto.none")
                      ) : null}
                    </dd>
                  </div>
                );
              })}
            </dl>
            <p className="small">
              <Link to="/settings/engines">{t("examSettings.enginesLink")}</Link>
            </p>
          </Group>

          <Group id="tools" title={t("examSettings.toolsHeading")}>
            <ActionRow
              title={t("plans.rebuild")}
              help={data.sources.length ? t("examSettings.rebuildHelp") : t("examSettings.rebuildNoSources")}
            >
              <Button
                shape="round"
                icon={<RefreshCw size={16} aria-hidden />}
                disabled={busy || !data.sources.length}
                onClick={() => setRebuildOpen(true)}
              >
                {t("examSettings.rebuild")}
              </Button>
            </ActionRow>
            <ActionRow title={t("examSettings.exportTitle")} help={t("examSettings.exportHelp")}>
              <ExportButton planId={planId} kind="plan" disabled={busy} />
            </ActionRow>
            <ActionRow title={t("examSettings.calendarTitle")} help={t("examSettings.calendarHelp")}>
              <CalendarButton planId={planId} disabled={busy} blocked={calendarBlocked} />
            </ActionRow>
          </Group>

          <Group id="end" title={t("examSettings.endHeading")}>
            {/* Only archiving fails here: saving reports in the bar, deleting in its dialog. */}
            {error && !dirty && !deleteOpen ? <Notice tone="danger">{t("planOverview.failed")}</Notice> : null}
            <ActionRow
              title={archived ? t("planOverview.restore") : t("planOverview.archive")}
              help={archived ? t("planOverview.restoreHelp") : t("planOverview.archiveHelp")}
            >
              <Button
                shape="round"
                icon={archived ? <ArchiveRestore size={16} aria-hidden /> : <Archive size={16} aria-hidden />}
                disabled={busy}
                onClick={() => archive(!archived)}
              >
                {archived ? t("examSettings.restore") : t("examSettings.archive")}
              </Button>
            </ActionRow>
            <ActionRow title={t("plans.delete")} help={t("examSettings.deleteHelp")}>
              <Button
                shape="round"
                danger
                icon={<Trash2 size={16} aria-hidden />}
                disabled={busy}
                onClick={() => {
                  setError(false);
                  setDeleteOpen(true);
                }}
              >
                {t("examSettings.delete")}
              </Button>
            </ActionRow>
          </Group>
        </>
      ) : null}

      {dirty ? (
        <div className="px-savebar" role="region" aria-label={t("examSettings.saveBar")}>
          <p className="body" aria-live="polite">
            <strong>{t("examSettings.changes", { count: changes.length })}</strong> {changeList}.
          </p>
          {error ? (
            <p className="small px-set-error" role="alert">
              {t("planOverview.failed")}
            </p>
          ) : null}
          <div className="px-savebar-buttons">
            <Button shape="round" type="text" disabled={busy} onClick={discard}>
              {t("examSettings.discard")}
            </Button>
            <Button shape="round" type="primary" loading={busy} disabled={nameMissing} onClick={save}>
              {t("planOverview.save")}
            </Button>
          </div>
        </div>
      ) : null}

      {data ? (
        <>
          <RebuildDialog
            planId={planId}
            sourceIds={data.sources.map((source) => source.id)}
            open={rebuildOpen}
            onClose={() => setRebuildOpen(false)}
            onDone={async () => {
              await refreshPlan(client, planId);
              navigate(`/plans/${planId}`);
            }}
          />
          <AttachSourcesDialog
            planId={planId}
            attached={data.sources.map((source) => source.id)}
            open={attachOpen}
            onClose={() => setAttachOpen(false)}
          />
        </>
      ) : null}

      <Modal
        open={deleteOpen}
        width={520}
        title={t("examSettings.deleteTitle", { title: data?.title ?? "" })}
        onCancel={() => !busy && setDeleteOpen(false)}
        footer={
          <div className="px-delete-footer">
            {archived ? null : (
              <Button shape="round" icon={<Archive size={16} aria-hidden />} disabled={busy} onClick={() => archive(true)}>
                {t("examSettings.archiveInstead")}
              </Button>
            )}
            <span className="px-delete-footer-gap" />
            <Button shape="round" disabled={busy} onClick={() => setDeleteOpen(false)}>
              {t("wizard.cancel")}
            </Button>
            <Button shape="round" type="primary" danger loading={busy} onClick={remove}>
              {t("plans.delete")}
            </Button>
          </div>
        }
      >
        {error ? <Notice tone="danger">{t("planOverview.failed")}</Notice> : null}
        <p className="body">{t("examSettings.deleteIntro")}</p>
        {counts ? (
          <ul className="px-delete-lose">
            {counts.topics > 0 ? (
              <li>
                <Layers size={18} strokeWidth={1.75} aria-hidden />
                {t("examSettings.lose.topics", { count: counts.topics })}
              </li>
            ) : null}
            {counts.lessons > 0 ? (
              <li>
                <BookOpen size={18} strokeWidth={1.75} aria-hidden />
                {t("examSettings.lose.lessons", { count: counts.lessons })}
              </li>
            ) : null}
            {counts.quizzes > 0 ? (
              <li>
                <ListChecks size={18} strokeWidth={1.75} aria-hidden />
                {t("examSettings.lose.quizzes", { count: counts.quizzes })}
              </li>
            ) : null}
            {counts.simulations > 0 ? (
              <li>
                <Clock size={18} strokeWidth={1.75} aria-hidden />
                {t("examSettings.lose.simulations", { count: counts.simulations })}
              </li>
            ) : null}
            {counts.cards > 0 ? (
              <li>
                <Repeat size={18} strokeWidth={1.75} aria-hidden />
                {t("examSettings.lose.cards", { count: counts.cards })}
              </li>
            ) : null}
            <li>
              <Target size={18} strokeWidth={1.75} aria-hidden />
              {t("examSettings.lose.mastery")}
            </li>
          </ul>
        ) : footprint.isError ? (
          // Without the counts the list still says what goes, in general terms.
          <ul className="px-delete-lose">
            <li>
              <Layers size={18} strokeWidth={1.75} aria-hidden />
              {t("examSettings.lose.all")}
            </li>
            <li>
              <Target size={18} strokeWidth={1.75} aria-hidden />
              {t("examSettings.lose.mastery")}
            </li>
          </ul>
        ) : null}
        <p className="small ink-muted">
          {archived
            ? t("examSettings.deleteKeep")
            : `${t("examSettings.deleteKeep")} ${t("examSettings.deleteArchiveHint")}`}
        </p>
      </Modal>

      <Modal
        open={blocker.state === "blocked"}
        title={t("examSettings.leaveTitle")}
        onCancel={() => blocker.state === "blocked" && blocker.reset()}
        footer={[
          <Button key="stay" shape="round" onClick={() => blocker.state === "blocked" && blocker.reset()}>
            {t("examSettings.stay")}
          </Button>,
          <Button
            key="leave"
            shape="round"
            danger
            onClick={() => {
              if (blocker.state !== "blocked") return;
              leaving.current = true;
              blocker.proceed();
            }}
          >
            {t("examSettings.leave")}
          </Button>,
        ]}
      >
        <p className="body">{t("examSettings.leaveBody", { changes: changeList })}</p>
      </Modal>
    </div>
  );
}
