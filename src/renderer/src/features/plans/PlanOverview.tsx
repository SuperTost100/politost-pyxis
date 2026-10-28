import { ArrowLeft } from "lucide-react";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Form,
  Input,
  Modal,
  Select,
  Slider,
  Table,
  Dropdown,
} from "antd";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { PLAN_TITLE_MAX } from "@shared/plan-file";
import { examDaysLabel, onTrackLabel } from "./examDays";
import { ExamSessionsField } from "./ExamSessionsField";
import {
  draftsFromSessions,
  emptyDraft,
  nextUpcomingDay,
  sameSessions,
  sessionsFromDrafts,
  type SessionDraft,
} from "./examSessions";
import { smartLabels, smartTextToMarkdown } from "@shared/smart-text";
import { errorDetails } from "../../lib/errorDetails";
import { invoke } from "../../lib/ipc";
import { MasteryBar } from "../../components/MasteryBar";
import { goalFraction, goalInput, goalRange } from "../../lib/grade";
import { useGradeScale } from "../../lib/useGradeScale";
import { Icon } from "../../components/Icon";
import { Tag } from "../../components/Tag";
import { LibraryPanel } from "../home/LibraryPanel";
import { IconButton } from "../../components/IconButton";
import type { IconName } from "../../components/Icon";
import { LessonTile } from "../../components/LessonTile";
import { SegmentedTabs } from "../../components/SegmentedTabs";
import { ErrorState } from "../../components/ErrorState";
import { Notice } from "../../components/Notice";
import { MarkdownView } from "../../components/MarkdownView";
import { openSourceViewer } from "../../components/SourceViewer";
import { CalendarButton } from "../share/CalendarButton";
import { ExportButton } from "../share/ExportButton";
import { PlanProgress } from "./PlanProgress";
import { RebuildDialog } from "./RebuildDialog";
import { PlanPath } from "./PlanPath";
import { MistakesNotebook } from "../study/MistakesNotebook";
import { SourceRow } from "../../components/SourceRow";
import { PastPapers } from "./PastPapers";
import "./PlanPage.css";
import { pastPapersQuery, sourcesQuery, usePlan, useRecommend } from "../../lib/queries";
import { refreshPlan } from "../../lib/refreshPlan";

type Plan = NonNullable<RequestOutput<"plans.read">>;

/** "Written: Tue 20 Nov, 09:30 · Aula 5", with "· over" once the day has passed. */
function sessionLine(
  session: Plan["sessions"][number],
  language: string,
  t: (key: string) => string,
): string {
  const day = new Intl.DateTimeFormat(language, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(session.date);
  const when = session.time ? `${day}, ${session.time}` : day;
  const over = dayjs(session.date).isBefore(dayjs().startOf("day"));
  return [
    session.label ? `${session.label}: ${when}` : when,
    session.place,
    over ? t("sessions.over") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
const kinds = ["mcq", "completion", "matching", "tf", "open"] as const;
type QuizKind = (typeof kinds)[number];

export function PlanPage() {
  const { t, i18n } = useTranslation();
  const grade = useGradeScale();
  const { planId = "", view } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const plan = usePlan(planId);
  const recommended = useRecommend(planId);
  const simulations = useQuery({
    queryKey: ["simulations", planId],
    enabled: !!planId,
    queryFn: () => invoke("plans.simulations", { planId }),
  });
  const pastPapers = useQuery({ ...pastPapersQuery(planId), enabled: !!planId });
  const series = useQuery({
    queryKey: ["series", planId],
    enabled: !!planId,
    queryFn: () => invoke("plans.series", { planId }),
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [itemPreview, setItemPreview] =
    useState<RequestOutput<"plans.item"> | null>(null);
  // The Sources tab reads the library too, for the file sizes its rows show.
  const library = useQuery({
    ...sourcesQuery,
    enabled: pickerOpen || view === "sources",
    refetchInterval: pickerOpen ? 1000 : false,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [group, setGroup] = useState("learn");
  const [lessonKind, setLessonKind] = useState<string | null>(null);
  const [topicId, setTopicId] = useState("");
  const [quizKinds, setQuizKinds] = useState<QuizKind[]>([...kinds]);
  const [minutes, setMinutes] = useState<30 | 60 | 90 | 120>(60);
  const [material, setMaterial] = useState<"exam" | "mixed">("mixed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const [form] = Form.useForm();
  // The sessions as edited, so the calendar button never exports older saved ones.
  const [draftSessions, setDraftSessions] = useState<SessionDraft[]>([emptyDraft()]);
  const [modal, modalContext] = Modal.useModal();
  const tab = ["progress", "topics", "sources", "mistakes"].includes(view ?? "")
    ? view!
    : "path";
  const progress = series.data;
  const refresh = () => refreshPlan(client, planId);
  async function action(run: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await run();
    } catch {
      setError(t("planOverview.failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function showCreate(topic?: string) {
    setTopicId(
      topic ?? recommended.data?.next?.topicId ?? plan.data?.topics[0]?.id ?? "",
    );
    setLessonKind(null);
    setGroup("learn");
    setError("");
    setCreateOpen(true);
  }
  const savedSessions = draftsFromSessions(plan.data?.sessions ?? []);
  const upcomingDay = nextUpcomingDay(savedSessions);
  const calendarBlocked = !sameSessions(draftSessions, savedSessions)
    ? t("calendar.saveFirst")
    : savedSessions.length === 0
      ? t("calendar.oneNoDate")
      : upcomingDay === null
        ? t("calendar.onePast")
        : undefined;
  function openSettings() {
    if (!plan.data) return;
    form.setFieldsValue({
      title: plan.data.title,
      target: goalInput(plan.data.target, grade.scale),
    });
    const saved = draftsFromSessions(plan.data.sessions);
    setDraftSessions(saved.length ? saved : [emptyDraft()]);
    setError("");
    setSettingsOpen(true);
  }
  /** Archiving changes what every review queue, count and card list shows, so they all read again. */
  async function setArchived(archived: boolean) {
    await invoke("plans.archive", { planId, archived });
    await Promise.all([
      refresh(),
      ...["card-browse", "cards", "card-queue", "review-session"].map((key) =>
        client.invalidateQueries({ queryKey: [key] }),
      ),
    ]);
  }
  function chooseLesson(kind: string) {
    if (["quiz", "simulation"].includes(kind)) {
      setLessonKind(kind);
      return;
    }
    setCreateOpen(false);
    navigate(
      `/plans/${planId}/${kind}${["lesson", "practice", "cards", "map"].includes(kind) ? `/${topicId}` : ""}`,
    );
  }
  function openItem(
    item: Plan["topics"][number]["items"][number],
    topicId: string,
  ) {
    if (item.kind === "map") {
      navigate(`/plans/${planId}/map/${topicId}`);
      return;
    }
    void action(async () => {
      if (item.kind === "quiz") {
        const attempt = await invoke("plans.openQuiz", {
          planId,
          itemId: item.id,
        });
        navigate(
          `/plans/${planId}/quiz/${topicId}?attempt=${attempt.attemptId}`,
        );
      } else
        setItemPreview(await invoke("plans.item", { planId, itemId: item.id }));
    });
  }
  function askTopic(topic: Plan["topics"][number]) {
    void action(async () => {
      const thread = await invoke("chats.seed", {
        kind: "passage",
        title: topic.title,
        body: [topic.title, topic.summary, ...topic.subtopics]
          .filter(Boolean)
          .join("\n\n"),
        sourceIds: topic.sourceIds,
        subject: plan.data?.subject ?? undefined,
      });
      navigate(`/ask/${thread.chatId}`);
    });
  }
  const previewBody = itemPreview
    ? (JSON.parse(itemPreview.bodyJson) as {
        markdown?: string;
        questions?: Array<{ stem: string; options?: string[] }>;
      })
    : null;
  if (plan.data?.status === "building")
    return (
      <section>
        <h1 className="title-1">{plan.data.title}</h1>
        <p>{t("wizard.buildInProgress")}</p>
        <Button
          type="primary"
          onClick={() => navigate(`/plans/new?build=${planId}`)}
        >
          {t("wizard.continueBuild")}
        </Button>
      </section>
    );
  if (plan.isError || (plan.isSuccess && !plan.data)) {
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
  return (
    <div className="px-plan-page">
      {modalContext}
      <RebuildDialog
        planId={planId}
        sourceIds={plan.data?.sources.map((source) => source.id) ?? []}
        open={rebuildOpen}
        onClose={() => setRebuildOpen(false)}
        onDone={async () => {
          await refresh();
          setSettingsOpen(false);
        }}
      />
      <Link to="/exams" className="px-plan-back">
        <ArrowLeft size={16} aria-hidden />
        {t("doors.exams")}
      </Link>
      <header className="px-plan-header">
        {plan.data?.subject && (
          <p className="label ink-muted">{plan.data.subject}</p>
        )}
        <h1 className="title-1">{plan.data?.title ?? t("wizard.title")}</h1>
        <p className="meta ink-muted">
          {plan.data?.examAt != null
            ? examDaysLabel(
                t,
                dayjs(plan.data.examAt).startOf("day").diff(dayjs().startOf("day"), "day"),
              )
            : t("plans.noExam")}{" "}
          ·{" "}
          {onTrackLabel(
            t,
            progress?.preparation.onTrack ?? 0,
            progress?.preparation.totalTopics ?? 0,
            plan.data?.target ?? 0.75,
            grade.format,
          )}
        </p>
        {plan.data &&
        (plan.data.sessions.length > 1 ||
          plan.data.sessions.some((s) => s.time || s.place || s.label)) ? (
          <ul className="px-plan-sessions small ink-muted" aria-label={t("sessions.list")}>
            {plan.data.sessions.map((session) => (
              <li key={session.id}>
                {sessionLine(session, i18n.language, t)}
              </li>
            ))}
          </ul>
        ) : null}
        <MasteryBar
          value={(progress?.preparation.mastery ?? 0) * 100}
          target={(plan.data?.target ?? 0.75) * 100}
          scale={grade.scale}
          label={t("progress.title")}
        />
        {/* Topic bars show one topic each; this bar weighs every topic by its passages, so it reads much lower early on. */}
        <p className="small ink-muted px-plan-mastery-note">{t("planOverview.planMastery")}</p>
        <div className="px-plan-header-actions">
          <Button
            shape="round"
            onClick={() => navigate(`/plans/${planId}/review`)}
            disabled={!plan.data}
          >
            {t("cards.reviewTitle")}
          </Button>
          {/* Only an exam with a session today or later has anything to save. */}
          {upcomingDay !== null ? (
            <CalendarButton planId={planId} icon />
          ) : null}
          <IconButton
            icon="settings"
            label={t("planOverview.settings")}
            onClick={openSettings}
            disabled={!plan.data}
          />
          {/* Not primary: the path's suggested step is the one main action on this page. */}
          <Button
            onClick={() => showCreate()}
            disabled={!plan.data?.topics.length}
          >
            {t("planOverview.create")}
          </Button>
        </div>
        {plan.data?.imported && (
          <p className="px-plan-origin">
            <Tag>{t("planOverview.imported")}</Tag>
            <span className="small ink-muted">
              {[
                plan.data.importedFrom?.author,
                new Date(
                  plan.data.importedFrom?.exportedAt ??
                    plan.data.importedFrom?.importedAt ??
                    0,
                ).toLocaleDateString(i18n.language),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </p>
        )}
        {plan.data?.archivedAt != null && (
          <div className="px-plan-archived">
            <Notice
              tone="info"
              action={{
                label: t("planOverview.restore"),
                onClick: () => void action(() => setArchived(false)),
              }}
            >
              {t("planOverview.archivedNotice")}
            </Notice>
          </div>
        )}
        {(plan.data?.status === "draft" ||
          plan.data?.topics.some((topic) => topic.grounding === "general")) && (
          <Notice tone="warning">{t("plans.draft")}</Notice>
        )}
      </header>
      <SegmentedTabs
        label={t("plans.views")}
        value={tab}
        onChange={(next) => navigate(`/plans/${planId}/${next}`)}
        items={[
          { value: "path", label: t("plans.tabPath") },
          { value: "topics", label: t("plans.tabTopics") },
          { value: "sources", label: t("plans.tabSources") },
          { value: "progress", label: t("progress.title") },
          { value: "mistakes", label: t("mistakes.title") },
        ]}
      />
      {error && !settingsOpen && !createOpen && (
        <Notice tone="danger">{error}</Notice>
      )}
      {tab === "path" && plan.data && (
        <PlanPath planId={planId} plan={plan.data} guide={recommended.data ?? undefined} />
      )}
      {tab === "topics" && (
        <ul className="px-plan-topics">
          {plan.data?.topics.map((topic) => (
            <li key={topic.id}>
              <div className="px-plan-topic-row">
                <details>
                  <summary>
                    <span>
                      <span className="body-strong">
                        {topic.chapter !== null && (
                          <Icon name="book-marked" size={16} />
                        )}{" "}
                        {topic.title}
                        {topic.grounding === "general" && (
                          <span className="px-plan-topic-tag">
                            <Tag>{t("components.tags.ai")}</Tag>
                          </span>
                        )}
                      </span>
                      <span className="meta ink-muted px-plan-topic-meta">
                        {t("planOverview.topicPassages", {
                          count: topic.passageCount,
                        })}{" "}
                        ·{" "}
                        {t("planOverview.topicLessons", {
                          count: topic.lessons,
                        })}
                        {topic.chapter !== null
                          ? ` · ${t("planOverview.chapter", { number: topic.chapter })}`
                          : ""}
                      </span>
                    </span>
                    <MasteryBar
                      label={topic.title}
                      value={
                        (progress?.topics.find((row) => row.id === topic.id)
                          ?.mastery ?? 0) * 100
                      }
                      scale={grade.scale}
                      showValue={false}
                    />
                  </summary>
                  {topic.summary && <p>{topic.summary}</p>}
                  <ul>
                    {topic.subtopics.map((name, index) => (
                      <li key={index}>{name}</li>
                    ))}
                  </ul>
                  {topic.items.length ? (
                    <ul className="px-plan-generated-items">
                      {topic.items.map((item) => (
                        <li key={item.id}>
                          <Button
                            type="text"
                            disabled={busy}
                            onClick={() => openItem(item, topic.id)}
                          >
                            {t(
                              item.kind === "lesson"
                                ? "lesson.title"
                                : item.kind === "quiz"
                                  ? "quiz.title"
                                  : item.kind === "map"
                                    ? "map.title"
                                    : `plans.${item.kind}`,
                            )}{" "}
                            ·{" "}
                            {new Date(item.createdAt).toLocaleDateString(
                              i18n.language,
                            )}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="small ink-muted">
                      {t("planOverview.noLessons")}
                    </p>
                  )}
                </details>
                <Dropdown
                  menu={{
                    items: [
                      {
                        key: "viewer",
                        label: t("planOverview.openViewer"),
                        disabled: !topic.firstPassageId,
                      },
                      { key: "create", label: t("planOverview.create") },
                      { key: "ask", label: t("planOverview.askTopic") },
                    ],
                    onClick: ({ key }) => {
                      if (key === "viewer" && topic.firstPassageId)
                        openSourceViewer({ passageId: topic.firstPassageId });
                      if (key === "create") showCreate(topic.id);
                      if (key === "ask") askTopic(topic);
                    },
                  }}
                  trigger={["click"]}
                >
                  <Button
                    type="text"
                    aria-label={t("planOverview.topicActions", {
                      title: topic.title,
                    })}
                    icon={<Icon name="settings" size={16} />}
                  />
                </Dropdown>
              </div>
            </li>
          ))}
        </ul>
      )}
      {tab === "sources" && (
        <section className="px-plan-sources">
          {plan.data?.needsRebuild && (
            <Notice
              tone="info"
              action={{
                label: t("plans.rebuild"),
                onClick: () => setRebuildOpen(true),
              }}
            >
              {t("planOverview.rebuildSuggested")}
            </Notice>
          )}
          {plan.data?.sources.length ? (
            <ul className="px-list-surface" aria-label={t("plans.tabSources")}>
              {plan.data.sources.map((source) => (
                <SourceRow
                  key={source.id}
                  source={{
                    ...source,
                    bytes: library.data?.find((item) => item.id === source.id)
                      ?.bytes,
                  }}
                  onOpen={() => openSourceViewer({ sourceId: source.id })}
                  actions={{
                    disabled: busy,
                    items: [
                      {
                        key: "remove",
                        label: t("planOverview.removeSource"),
                        danger: true,
                      },
                    ],
                    onSelect: () =>
                      modal.confirm({
                        title: t("planOverview.removeSource"),
                        content: t("planOverview.removeSourceHelp", {
                          title: source.title,
                        }),
                        onOk: () =>
                          action(async () => {
                            await invoke("plans.removeSource", {
                              planId,
                              sourceId: source.id,
                            });
                            await refresh();
                          }),
                      }),
                  }}
                />
              ))}
            </ul>
          ) : plan.data ? (
            <p className="body ink-muted">{t("planOverview.noSources")}</p>
          ) : null}
          <Button
            shape="round"
            onClick={() => {
              setSelectedSources([]);
              setPickerOpen(true);
            }}
          >
            {t("planOverview.addSources")}
          </Button>
          <PastPapers planId={planId} />
        </section>
      )}
      <Modal
        width={720}
        title={t("planOverview.addSources")}
        open={pickerOpen}
        onCancel={() => !busy && setPickerOpen(false)}
        confirmLoading={busy}
        okText={t("planOverview.attachSources")}
        okButtonProps={{ disabled: !selectedSources.length }}
        onOk={() =>
          void action(async () => {
            await invoke("plans.attachSources", {
              planId,
              sourceIds: selectedSources,
            });
            await refresh();
            setPickerOpen(false);
          })
        }
      >
        {error && <Notice tone="danger">{error}</Notice>}
        <p className="small ink-muted">{t("planOverview.pickerHelp")}</p>
        <Table
          tableLayout="fixed"
          className="px-plan-source-table"
          size="small"
          rowKey="id"
          loading={library.isPending}
          dataSource={(library.data ?? []).filter(
            (source) =>
              !plan.data?.sources.some((attached) => attached.id === source.id) &&
              !pastPapers.data?.papers.some((paper) =>
                paper.sourceIds.includes(source.id),
              ),
          )}
          rowSelection={{
            selectedRowKeys: selectedSources,
            onChange: (keys) => setSelectedSources(keys.map(String)),
            getCheckboxProps: (source) => ({
              disabled: busy || source.status !== "ready",
              name: source.title,
              "aria-label": source.title,
            }),
          }}
          columns={[
            { title: t("sources.nameColumn"), dataIndex: "title" },
            {
              title: t("sources.typeColumn"),
              dataIndex: "kind",
              render: (kind: string) =>
                t(`sources.kind.${kind}`, { defaultValue: kind }),
            },
            {
              title: t("sources.statusColumn"),
              dataIndex: "status",
              render: (status: string) =>
                t(`sources.status.${status}`, { defaultValue: status }),
            },
          ]}
        />
        <Button onClick={() => setImportOpen(true)}>
          {t("planOverview.importSource")}
        </Button>
      </Modal>
      <Modal
        width={720}
        open={importOpen}
        title={t("planOverview.importSource")}
        onCancel={() => setImportOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <LibraryPanel
          importOnly
          onClose={() => {
            setImportOpen(false);
            void library.refetch();
          }}
        />
      </Modal>
      <Modal
        width={720}
        title={
          itemPreview
            ? t(
                itemPreview.kind === "lesson"
                  ? "lesson.title"
                  : `plans.${itemPreview.kind}`,
              )
            : ""
        }
        open={!!itemPreview}
        footer={null}
        onCancel={() => setItemPreview(null)}
      >
        <MarkdownView
          onCitationClick={(number) => {
            const passageId = itemPreview?.passageIds[number - 1];
            if (passageId) openSourceViewer({ passageId });
          }}
        >
          {smartTextToMarkdown(
            previewBody?.markdown ?? "",
            i18n.language.startsWith("it") ? smartLabels.it : smartLabels.en,
          )}
        </MarkdownView>
        {previewBody?.questions?.map((question, index) => (
          <section key={index}>
            <MarkdownView>{question.stem}</MarkdownView>
            {question.options && (
              <ul>
                {question.options.map((option, index) => (
                  <li key={index}>{option}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </Modal>
      {tab === "progress" && progress && (
        <PlanProgress
          planId={planId}
          progress={progress}
          simulations={simulations.data ?? []}
        />
      )}
      {tab === "mistakes" && <MistakesNotebook planId={planId} />}
      <Modal
        open={settingsOpen}
        title={t("planOverview.settings")}
        onCancel={() => !busy && setSettingsOpen(false)}
        confirmLoading={busy}
        okText={t("planOverview.save")}
        onOk={() =>
          void form
            .validateFields()
            .then((values) =>
              action(async () => {
                await invoke("plans.settings", {
                  planId,
                  title: values.title,
                  // An untouched goal stays as stored: on another scale its rounded input would move it.
                  target: form.isFieldTouched("target")
                    ? goalFraction(values.target, grade.scale)
                    : (plan.data?.target ?? goalFraction(values.target, grade.scale)),
                  // Noon on each day, as in the wizard, so a shared plan keeps its days in another time zone.
                  sessions: sessionsFromDrafts(draftSessions),
                });
                await refresh();
                setSettingsOpen(false);
              }),
            )
            .catch(() => {})
        }
      >
        {error && <Notice tone="danger">{error}</Notice>}
        <Form form={form} layout="vertical">
          <Form.Item
            name="title"
            label={t("wizard.planTitle")}
            rules={[{ required: true, whitespace: true }]}
          >
            <Input maxLength={PLAN_TITLE_MAX} disabled={busy} />
          </Form.Item>
          <Form.Item name="target" label={t("planOverview.target")}>
            <Slider
              min={goalRange(grade.scale).min}
              max={goalRange(grade.scale).max}
              step={goalRange(grade.scale).step}
              marks={Object.fromEntries(
                goalRange(grade.scale).marks.map((mark) => [mark, String(mark)]),
              )}
              disabled={busy}
              ariaLabelForHandle={t("planOverview.target")}
              ariaValueTextFormatterForHandle={(value) => `${value ?? ""}/${grade.scale}`}
              tooltip={{ formatter: (value) => `${value ?? ""}/${grade.scale}` }}
            />
          </Form.Item>
          <Form.Item>
            <ExamSessionsField
              idPrefix="settings"
              dateLabel={t("wizard.exam")}
              value={draftSessions}
              onChange={setDraftSessions}
              disabled={busy}
            />
          </Form.Item>
          <p className="small">
            <strong>{t("planOverview.language")}: </strong>
            {plan.data?.contentLanguage === "it"
              ? t("wizard.italian")
              : plan.data?.contentLanguage === "en"
                ? t("wizard.english")
                : (plan.data?.contentLanguage ?? i18n.language)}
          </p>
        </Form>
        <section className="px-plan-settings-tools">
          <ExportButton planId={planId} kind="plan" disabled={busy} />
          <CalendarButton
            planId={planId}
            disabled={busy}
            blocked={calendarBlocked}
          />
          <Button
            disabled={busy || !plan.data?.sources.length}
            onClick={() => setRebuildOpen(true)}
          >
            {t("plans.rebuild")}
          </Button>
        </section>
        <section className="px-plan-archive">
          <p className="small ink-muted">
            {plan.data?.archivedAt != null
              ? t("planOverview.restoreHelp")
              : t("planOverview.archiveHelp")}
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await setArchived(plan.data?.archivedAt == null);
                setSettingsOpen(false);
              })
            }
          >
            {plan.data?.archivedAt != null
              ? t("planOverview.restore")
              : t("planOverview.archive")}
          </Button>
        </section>
        <section className="px-plan-danger">
          <p className="small ink-muted">{t("planOverview.deleteHelp")}</p>
          <Button
            danger
            disabled={busy}
            onClick={() =>
              modal.confirm({
                title: t("plans.delete"),
                content: t("planOverview.deleteConfirm"),
                okButtonProps: { danger: true },
                okText: t("plans.delete"),
                onOk: () =>
                  action(async () => {
                    await invoke("plans.delete", { planId });
                    await client.invalidateQueries({ queryKey: ["plans"] });
                    navigate("/exams");
                  }),
              })
            }
          >
            {t("plans.delete")}
          </Button>
        </section>
      </Modal>
      <Modal
        width={640}
        open={createOpen}
        title={t("planOverview.create")}
        onCancel={() => !busy && setCreateOpen(false)}
        footer={null}
      >
        {error && <Notice tone="danger">{error}</Notice>}
        {!lessonKind ? (
          <>
            <SegmentedTabs
              label={t("planOverview.lessonGroup")}
              value={group}
              onChange={setGroup}
              items={[
                { value: "learn", label: t("planOverview.learn") },
                { value: "practice", label: t("plans.practice") },
                { value: "exam", label: t("nav.exams") },
              ]}
            />
            <label
              className="small px-plan-topic-label"
              htmlFor="plan-lesson-topic"
            >
              {t("planOverview.topic")}
            </label>
            <Select
              id="plan-lesson-topic"
              value={topicId}
              onChange={setTopicId}
              options={plan.data?.topics.map((topic) => ({
                value: topic.id,
                label: topic.title,
              }))}
              style={{ width: "100%" }}
            />
            <div className="px-plan-lesson-grid">
              {(group === "learn"
                ? [
                    {
                      kind: "lesson",
                      icon: "book-open",
                      label: t("lesson.title"),
                    },
                    { kind: "map", icon: "network", label: t("map.title") },
                  ]
                : group === "practice"
                  ? [
                      {
                        kind: "quiz",
                        icon: "list-checks",
                        label: t("quiz.title"),
                      },
                      {
                        kind: "cards",
                        icon: "layers",
                        label: t("cards.title"),
                      },
                      {
                        kind: "practice",
                        icon: "pencil-line",
                        label: t("practice.title"),
                      },
                    ]
                  : [
                      {
                        kind: "diagnostic",
                        icon: "list-checks",
                        label: t("quiz.diagnostic"),
                      },
                      {
                        kind: "simulation",
                        icon: "clock",
                        label: t("simulation.title"),
                      },
                      ...(pastPapers.data?.papers.some(
                        (paper) => paper.status === "ready",
                      )
                        ? [
                            {
                              kind: "past",
                              icon: "file-pen",
                              label: t("pastPapers.practiceTitle"),
                            },
                          ]
                        : []),
                    ]
              ).map((tile) => (
                <LessonTile
                  key={tile.kind}
                  icon={tile.icon as IconName}
                  label={tile.label}
                  recommended={
                    recommended.data?.next?.activity === tile.kind &&
                    [topicId, null].includes(recommended.data.next.topicId)
                  }
                  recommendedLabel={t("plans.path.suggested")}
                  onClick={() => chooseLesson(tile.kind)}
                />
              ))}
            </div>
          </>
        ) : (
          <>
            <Button
              type="text"
              disabled={busy}
              onClick={() => setLessonKind(null)}
            >
              {t("nav.back")}
            </Button>
            {lessonKind === "quiz" ? (
              <>
                <fieldset className="px-plan-quiz-types">
                  <legend>{t("quiz.types")}</legend>
                  {kinds.map((kind) => (
                    <label key={kind}>
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={quizKinds.includes(kind)}
                        onChange={() =>
                          setQuizKinds((current) =>
                            current.includes(kind)
                              ? current.filter((value) => value !== kind)
                              : [...current, kind],
                          )
                        }
                      />
                      {t(`quiz.kinds.${kind}`)}
                    </label>
                  ))}
                </fieldset>
              </>
            ) : (
              <Form layout="vertical">
                <Form.Item label={t("simulation.duration")}>
                  <Select
                    value={minutes}
                    onChange={setMinutes}
                    disabled={busy}
                    options={[30, 60, 90, 120].map((value) => ({
                      value,
                      label: t("simulation.minutes", { count: value }),
                    }))}
                  />
                </Form.Item>
                <Form.Item label={t("simulation.material")}>
                  <Select
                    value={material}
                    onChange={setMaterial}
                    disabled={busy}
                    options={[
                      { value: "exam", label: t("simulation.exam") },
                      { value: "mixed", label: t("simulation.mixed") },
                    ]}
                  />
                </Form.Item>
              </Form>
            )}
            <Button
              type="primary"
              loading={busy}
              disabled={lessonKind === "quiz" && !quizKinds.length}
              onClick={() =>
                void action(async () => {
                  if (lessonKind === "quiz") {
                    const result = await invoke("study.quizStart", {
                      planId,
                      topicId,
                      count: 10,
                      types: quizKinds,
                    });
                    navigate(
                      `/plans/${planId}/quiz/${topicId}?attempt=${result.attemptId}`,
                    );
                  } else {
                    const result = await invoke("study.simulationPrepare", {
                      planId,
                      minutes,
                      source: material,
                    });
                    navigate(result.attemptId ? `/plans/${planId}/exam/${result.attemptId}` : `/plans/${planId}/simulation`);
                  }
                })
              }
            >
              {t("planOverview.start")}
            </Button>
          </>
        )}
      </Modal>
    </div>
  );
}
