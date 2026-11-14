import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, type MenuProps } from "antd";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { usePlace } from "../../app/usePlace";
import { BackControl } from "../../components/BackControl";
import type { RequestOutput } from "@shared/ipc";
import { smartLabels, smartTextToMarkdown } from "@shared/smart-text";
import { Button } from "../../components/Button";
import { emptyRings, ExamRings, RingLegend } from "../../components/ExamRings";
import { ErrorState } from "../../components/ErrorState";
import { Icon } from "../../components/Icon";
import { MathText } from "../../components/math/MathText";
import { MenuButton, MenuItemArea } from "../../components/ItemMenu";
import { Logo } from "../../components/Logo";
import { MarkdownView } from "../../components/MarkdownView";
import { Notice } from "../../components/Notice";
import { SourceDetails } from "../../components/SourceDetails";
import { openSourceViewer } from "../../components/SourceViewer";
import { Tag } from "../../components/Tag";
import { Working } from "../../components/Working";
import { errorDetails } from "../../lib/errorDetails";
import { invoke } from "../../lib/ipc";
import {
  partsQuery,
  pastPapersQuery,
  ringsQuery,
  scheduleQuery,
  usePlan,
  useRecommend,
  useSources,
  useSubjects,
} from "../../lib/queries";
import { classifyFile } from "@shared/file-kind";
import { FileCover } from "../../components/FileCover";
import { coverColour } from "../home/shelf";
import { mapPath } from "../maps/mapPath";
import { MapThumb } from "../maps/MapThumb";
import { useSaveCalendar } from "../share/CalendarButton";
import { ExportButton } from "../share/ExportButton";
import { setPlanArchived } from "./archivePlan";
import { ActivityMaking } from "./ActivityMaking";
import { madeFor, type MadeActivity } from "./making";
import { ExamCreateDialog } from "./ExamCreateDialog";
import { draftsFromSessions, nextUpcomingDay } from "./examSessions";
import { activityIcons, PlanPath, type TopicAction } from "./PlanPath";
import { nowPartText, partPath } from "./partsText";
import { PlanSources } from "./PlanSources";
import { skipDiagnosticPath, stepPath } from "./reopen";
import { UnfinishedSection } from "./Unfinished";
import { useGapDrill } from "./useGapDrill";
import "./PlanPage.css";
import "./ExamPage.css";

type Plan = NonNullable<RequestOutput<"plans.read">>;
type Guide = NonNullable<RequestOutput<"plans.recommend">>;

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

/**
 * An exam's page at `/plans/:planId`. `/plans/:planId/sources` is all of its material; the older Path, Progress and
 * Topics tabs land on the page, and `?drill=<topicId>` there starts a Ripasso mirato.
 */
export function PlanPage() {
  const { planId = "", view } = useParams();
  return view === "sources" ? (
    <PlanSources planId={planId} />
  ) : (
    <ExamPage planId={planId} />
  );
}

function ExamPage({ planId }: { planId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const plan = usePlan(planId);
  // A back control elsewhere calls the exam by its title; this page's own leads to Esami or to the page that opened it.
  const back = usePlace({ name: plan.data ? { text: plan.data.title } : null });
  const recommended = useRecommend(planId);
  const schedule = useQuery({ ...scheduleQuery(planId), enabled: !!planId });
  const rings = useQuery(ringsQuery);
  const drill = useGapDrill(planId);
  const calendar = useSaveCalendar(planId);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTopic, setCreateTopic] = useState<string | undefined>(undefined);
  // What opened "Crea un'attività": it grows out of it and gives the focus back to it.
  const createOrigin = useRef<HTMLElement | null>(null);
  const [made, setMade] = useState<MadeActivity | null>(null);
  // An activity being made belongs to its exam: going to another exam leaves it out of sight and forgets it.
  const making = madeFor(made, planId);
  useEffect(() => {
    if (made && !making) setMade(null);
  }, [made, making]);
  const [exportOpen, setExportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [itemPreview, setItemPreview] =
    useState<RequestOutput<"plans.item"> | null>(null);
  const ring = rings.data?.find((entry) => entry.planId === planId);

  async function action(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await run();
    } catch {
      setError(t("planOverview.failed"));
    } finally {
      setBusy(false);
    }
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
  function topicAction(kind: TopicAction, topic: Plan["topics"][number]) {
    if (kind === "map") navigate(`/plans/${planId}/map/${topic.id}`);
    if (kind === "viewer" && topic.firstPassageId)
      openSourceViewer({ passageId: topic.firstPassageId });
    if (kind === "create") {
      createOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setCreateTopic(topic.id);
      setCreateOpen(true);
    }
    if (kind === "ask")
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
      <section className="px-exam">
        <BackControl target={back} variant="page" />
        <h1 className="title-1">{plan.data.title}</h1>
        <Working line={t("wizard.buildInProgress")} />
        <Button onClick={() => navigate(`/plans/new?build=${planId}`)}>
          {t("wizard.continueBuild")}
        </Button>
      </section>
    );
  if (plan.isError || (plan.isSuccess && !plan.data)) {
    const toExams = {
      label: t("nav.toExams"),
      onClick: () => navigate("/exams"),
    };
    return plan.isError ? (
      <ErrorState
        action={{
          label: t("components.notice.retry"),
          onClick: () => void plan.refetch(),
        }}
        secondary={toExams}
        details={errorDetails(plan.error)}
      >
        {t("planOverview.unavailable")}
      </ErrorState>
    ) : (
      <ErrorState action={toExams}>{t("planOverview.gone")}</ErrorState>
    );
  }
  if (!plan.data) return <ExamSkeleton label={t("components.loading")} />;
  const data = plan.data;
  const upcoming = nextUpcomingDay(draftsFromSessions(data.sessions)) !== null;
  // The exam's menu: the dots beside the settings and a right-click on the head.
  const menu: MenuProps = {
    items: [
      { key: "review", label: t("cards.reviewTitle") },
      {
        key: "create",
        label: t("examPage.create"),
        disabled: !data.topics.length,
      },
      { type: "divider" },
      // Only an exam with a session today or later has anything to put in a calendar.
      ...(upcoming
        ? [
            {
              key: "calendar",
              label: t("calendar.add"),
              disabled: calendar.busy,
            },
          ]
        : []),
      { key: "share", label: t("examPage.share") },
    ],
    onClick: ({ key }) => {
      if (key === "review") navigate(`/plans/${planId}/review`);
      if (key === "create") {
        // The menu gave the focus back to where it opened before this runs.
        createOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setCreateTopic(undefined);
        setCreateOpen(true);
      }
      if (key === "calendar") void calendar.save();
      if (key === "share") setExportOpen(true);
    },
  };

  return (
    <div className="px-exam">
      <BackControl target={back} variant="page" />
      <MenuItemArea as="header" className="px-exam-head" menu={menu} region={t("examPage.more")}>
        <div className="px-exam-name">
          <h1 className="title-1">{data.title}</h1>
          <p className="px-exam-date">
            <ExamWhen plan={data} />
          </p>
        </div>
        <div className="px-exam-rings">
          <ExamRings
            values={ring ?? emptyRings}
            label={rings.isPending ? t("components.loading") : undefined}
          />
          <RingLegend
            values={ring ?? emptyRings}
            onSetGoal={() => navigate(`/plans/${planId}/settings`, { state: { focus: "hours" } })}
          />
        </div>
        <span className="px-exam-grow" aria-hidden />
        <span className="px-exam-actions">
          <Button
            variant="secondary"
            icon="sliders-horizontal"
            onClick={() => navigate(`/plans/${planId}/settings`)}
          >
            {t("planOverview.settings")}
          </Button>
          <MenuButton rightClick menu={menu} label={t("examPage.more")} />
        </span>
      </MenuItemArea>
      {rings.isError ? (
        <Notice
          tone="danger"
          action={{
            label: t("components.notice.retry"),
            onClick: () => void rings.refetch(),
          }}
        >
          {t("examPage.ringsFailed")}
        </Notice>
      ) : null}
      {data.sessions.length > 1 ||
      data.sessions.some((s) => s.time || s.place) ? (
        <ul className="px-exam-sessions" aria-label={t("sessions.list")}>
          {data.sessions.map((session) => (
            <li key={session.id}>{sessionLine(session, i18n.language, t)}</li>
          ))}
        </ul>
      ) : null}
      {data.imported ? (
        <p className="px-exam-origin">
          <Tag>{t("planOverview.imported")}</Tag>
          <span>
            {[
              data.importedFrom?.author,
              new Date(
                data.importedFrom?.exportedAt ??
                  data.importedFrom?.importedAt ??
                  0,
              ).toLocaleDateString(i18n.language),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </p>
      ) : null}
      {data.archivedAt != null ? (
        <div className="px-exam-notice">
          <Notice
            tone="info"
            action={{
              label: t("planOverview.restore"),
              onClick: () =>
                void action(() => setPlanArchived(client, planId, false)),
            }}
          >
            {t("planOverview.archivedNotice")}
          </Notice>
        </div>
      ) : null}
      {data.status === "draft" ||
      data.topics.some((topic) => topic.grounding === "general") ? (
        <div className="px-exam-notice">
          <Notice tone="warning">{t("plans.draft")}</Notice>
        </div>
      ) : null}
      {error ? (
        <div className="px-exam-notice">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}
      <div className="px-exam-grid">
        {making ? (
          <ActivityMaking planId={planId} made={making} onDone={() => setMade(null)} />
        ) : (
          <NowCard
            planId={planId}
            plan={data}
            guide={recommended.data ?? undefined}
            loading={recommended.isPending}
          />
        )}
        <div className="px-exam-path">
          <PlanPath
            planId={planId}
            plan={data}
            guide={recommended.data ?? undefined}
            schedule={schedule.data}
            drill={drill}
            onTopicAction={topicAction}
            onOpenItem={openItem}
            itemsBusy={busy}
          />
        </div>
        <ExamAside planId={planId} plan={data} dueCards={ring?.dueCards} />
      </div>
      <ExamCreateDialog
        planId={planId}
        plan={data}
        guide={recommended.data ?? undefined}
        open={createOpen}
        initialTopic={createTopic}
        origin={() => createOrigin.current}
        onClose={() => setCreateOpen(false)}
        onMade={setMade}
      />
      <ExportButton
        planId={planId}
        kind="plan"
        open={exportOpen}
        onOpenChange={setExportOpen}
      />
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
    </div>
  );
}

/** "Scritto venerdì 22 gennaio", or that the date is still to be set. */
function ExamWhen({ plan }: { plan: Plan }) {
  const { t, i18n } = useTranslation();
  if (plan.examAt == null) return <>{t("examPage.noDate")}</>;
  const session = plan.sessions.find((entry) => entry.date === plan.examAt);
  const label = session?.label?.trim() || t("plans.path.exam");
  const date = new Intl.DateTimeFormat(i18n.language, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(plan.examAt);
  const days = dayjs(plan.examAt)
    .startOf("day")
    .diff(dayjs().startOf("day"), "day");
  if (days === 0) return <>{t("examPage.whenToday", { label })}</>;
  return (
    <>{t(days < 0 ? "examPage.whenPast" : "examPage.when", { label, date })}</>
  );
}

/**
 * Consigliato adesso: the path's one suggested step, with the page's only primary button. A lesson in parts names the
 * part to read next, or "Riprendi da" the part after the one finished on an earlier day.
 */
function NowCard({
  planId,
  plan,
  guide,
  loading,
}: {
  planId: string;
  plan: Plan;
  guide: Guide | undefined;
  loading: boolean;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const next = guide?.next ?? null;
  const topicId = next?.topicId ?? null;
  const topic = topicId
    ? plan.topics.find((item) => item.id === topicId)?.title
    : null;
  const activity = next ? t(`plans.path.activity.${next.activity}`) : null;
  const skipTo = skipDiagnosticPath(planId, plan.topics, plan.steps);
  const part = next?.part ?? null;
  const text =
    part && topic != null
      ? nowPartText(t, { part, topic, now: Date.now(), language: i18n.language })
      : null;
  const resume = Boolean(part?.resumeFrom);
  const go = () => {
    const to = next
      ? part && topicId
        ? partPath(planId, topicId, part.position)
        : stepPath(planId, next.activity, next.topicId)
      : null;
    if (to) navigate(to);
  };
  return (
    <section className="px-exam-now" aria-labelledby="px-exam-now-title">
      <div className="px-exam-now-text">
        {/* While the suggestion loads the kicker keeps its place, since it may turn out to be "Riprendi da". */}
        <span
          className={loading ? "px-exam-kicker is-pending" : "px-exam-kicker"}
          aria-hidden={loading || undefined}
        >
          {t(resume ? "examPage.resumeKicker" : "examPage.nowKicker")}
        </span>
        <h2 id="px-exam-now-title">
          {loading ? (
            <i className="px-skeleton-bar is-title" />
          ) : text ? (
            <MathText text={text.title} />
          ) : next ? (
            topic ? (
              t("examPage.nowTitle", { activity, topic })
            ) : (
              activity
            )
          ) : (
            t("plans.path.pick")
          )}
        </h2>
        {text ? (
          <p>{text.line}</p>
        ) : next ? (
          <p>{t(`plans.path.reason.${next.reason}`, { count: next.count })}</p>
        ) : null}
        {next && topicId && topic != null ? (
          <ChooseOther
            planId={planId}
            topicId={topicId}
            topic={topic}
            suggested={next.activity}
            dueCards={guide?.topics.find((entry) => entry.topicId === topicId)?.dueCards ?? 0}
          />
        ) : null}
      </div>
      {next?.activity === "diagnostic" && skipTo ? (
        <Button variant="ghost" onClick={() => navigate(skipTo)}>
          {t("plans.path.skipDiagnostic")}
        </Button>
      ) : null}
      {next ? (
        <Button size="lg" onClick={go}>
          {t(resume ? "examPage.resume" : "examPage.continue")}
        </Button>
      ) : null}
    </section>
  );
}

/**
 * "Scegli altro" under the suggestion: other short things on its topic, the ones that exist. Its exercises and its
 * flashcards (the suggested one left out), and, once some part of its lesson is read, a part to read again.
 */
function ChooseOther({
  planId,
  topicId,
  topic,
  suggested,
  dueCards,
}: {
  planId: string;
  topicId: string;
  topic: string;
  suggested: string;
  dueCards: number;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const parts = useQuery(partsQuery(planId, topicId));
  // The practice page's own read, which only reads: exercises are written when that page asks for them.
  const exercises = useQuery({
    queryKey: ["exercises", planId, topicId],
    queryFn: () => invoke("study.exercises", { topicId, planId }),
  });
  const cards = useQuery({
    queryKey: ["card-browse", "", planId, topicId, "all", "count"],
    queryFn: () => invoke("study.browse", { planId, topicId, limit: 1 }),
  });
  const read = parts.data?.outline?.parts.filter((entry) => entry.done) ?? [];
  const practiceCount = exercises.data?.exercises.length ?? 0;
  const cardsTotal = cards.data?.total;
  const choice = (label: string, note: string | null) => (
    <span className="px-item-menu-choice">
      <span>{label}</span>
      {note ? <small>{note}</small> : null}
    </span>
  );
  const items: NonNullable<MenuProps["items"]> = [
    ...(suggested === "practice"
      ? []
      : [
          {
            key: "practice",
            icon: <Icon name={activityIcons.practice} size={16} />,
            label: choice(
              t("lesson.otherPractice", { topic }),
              practiceCount ? t("lesson.otherPracticeCount", { count: practiceCount }) : null,
            ),
          },
        ]),
    ...(suggested === "cards"
      ? []
      : [
          {
            key: "cards",
            icon: <Icon name={activityIcons.cards} size={16} />,
            label: choice(
              t("lesson.otherCards", { topic }),
              dueCards > 0
                ? t("lesson.otherCardsDue", { count: dueCards })
                : cardsTotal
                  ? t("examPage.otherCardsCount", { count: cardsTotal })
                  : cardsTotal === 0
                    ? t("lesson.otherCardsNone")
                    : null,
            ),
          },
        ]),
    ...(read.length
      ? [
          {
            key: "reread",
            icon: <Icon name="rotate-ccw" size={16} />,
            label: choice(t("lesson.otherReread"), t("examPage.otherRereadCount", { count: read.length })),
            children: read.map((entry) => ({
              key: `part:${entry.position}`,
              label:
                entry.kind === "recap" ? (
                  t("lesson.recapTitle")
                ) : (
                  <MathText text={`${t("plans.path.partNumber", { n: entry.position })} · ${entry.title}`} />
                ),
            })),
          },
        ]
      : []),
  ];
  return (
    <MenuButton
      label={t("lesson.chooseOther")}
      align="start"
      size="sm"
      className="px-exam-other"
      menu={{
        items,
        onClick: ({ key }) => {
          if (key.startsWith("part:")) navigate(partPath(planId, topicId, Number(key.slice(5))));
          else {
            const to = stepPath(planId, key, topicId);
            if (to) navigate(to);
          }
        },
      }}
    >
      {t("lesson.chooseOther")}
    </MenuButton>
  );
}

/** One section of the column beside the path: its title, a count on the right, and its body. */
function AsideSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: string | null;
  children: ReactNode;
}) {
  return (
    <section className="px-exam-asec">
      <h2>
        {title}
        {count ? <span>{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

/** A section's body while its read is pending or after it failed. */
function Pending({
  query,
  children,
}: {
  query: { isPending: boolean; isError: boolean; refetch: () => unknown };
  children: () => ReactNode;
}) {
  const { t } = useTranslation();
  if (query.isError)
    return (
      <p className="px-exam-asec-error">
        {t("examPage.sectionFailed")}{" "}
        <button
          type="button"
          className="px-exam-link"
          onClick={() => void query.refetch()}
        >
          {t("components.notice.retry")}
        </button>
      </p>
    );
  if (query.isPending)
    return (
      <div className="px-exam-asec-skeleton" aria-hidden>
        <i className="px-skeleton-bar" />
        <i className="px-skeleton-bar" />
      </div>
    );
  return <>{children()}</>;
}

/** Flashcard, Da rifare, Mappe and Materiale, beside the path. */
function ExamAside({
  planId,
  plan,
  dueCards,
}: {
  planId: string;
  plan: Plan;
  dueCards: number | undefined;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [detailSourceId, setDetailSourceId] = useState<string | null>(null);
  const [redoing, setRedoing] = useState(false);
  const [redoFailed, setRedoFailed] = useState(false);
  const cards = useQuery({
    queryKey: ["card-browse", "", planId, "", "all", "count"],
    queryFn: () => invoke("study.browse", { planId, limit: 1 }),
  });
  const mistakes = useQuery({
    queryKey: ["mistakes", planId],
    queryFn: () => invoke("study.mistakes", { planId }),
  });
  const maps = useQuery({
    queryKey: ["maps", "all", ""],
    queryFn: () => invoke("maps.all", {}),
  });
  const papers = useQuery(pastPapersQuery(planId));
  // The Library's list knows each file's kind and subject, so Materiale draws the covers the shelf draws.
  const library = useSources();
  const subjects = useSubjects();
  // Subject names are unique regardless of case, as the exam names its subject.
  const subjectId = plan.subject
    ? subjects.data?.find((item) => item.name.toLocaleLowerCase() === plan.subject!.toLocaleLowerCase())?.id
    : undefined;
  const due = dueCards ?? 0;
  const entries =
    mistakes.data?.entries.filter((entry) => entry.planId === planId) ?? [];
  const mistakeTopics = [
    ...new Set(
      entries
        .map((entry) => entry.topicTitle)
        .filter((title): title is string => !!title),
    ),
  ];
  const subjectMaps = (maps.data ?? []).filter(
    (map) =>
      map.planId === planId ||
      // Subject names are unique regardless of case, and the Maps section matches them that way.
      (plan.subject != null &&
        map.subjectName?.toLocaleLowerCase() ===
          plan.subject.toLocaleLowerCase()),
  );
  const paperIds = new Set(papers.data?.papers.map((paper) => paper.sourceId));
  const listed = new Map((library.data ?? []).map((source) => [source.id, source]));
  const cover = (id: string, title: string, kind: string, pastPaper: boolean) => {
    const source = listed.get(id);
    return {
      id,
      title,
      kind: source?.fileKind ?? classifyFile({ kind, title, pastPaper }).kind,
      colour: source?.subjectId ? coverColour(source.subjectId) : subjectId ? coverColour(subjectId) : null,
      symbol: source?.subject ?? plan.subject ?? title,
    };
  };
  const covers = [
    ...plan.sources
      .filter((source) => !paperIds.has(source.id))
      .map((source) => cover(source.id, source.title, source.kind, false)),
    ...(papers.data?.papers ?? []).map((paper) => cover(paper.sourceId, paper.title, "pdf", true)),
  ];
  async function redo() {
    setRedoing(true);
    setRedoFailed(false);
    try {
      const { attemptId } = await invoke("study.mistakesRedo", {
        planId,
        keys: entries.slice(0, 100).map((entry) => entry.key),
      });
      navigate(`/plans/${planId}/redo?attempt=${attemptId}`);
    } catch {
      setRedoFailed(true);
      setRedoing(false);
    }
  }
  return (
    <aside className="px-exam-aside" aria-label={t("examPage.aside")}>
      <UnfinishedSection planId={planId} />
      <AsideSection
        title={t("cards.title")}
        count={
          cards.data
            ? t("examPage.cardsTotal", { count: cards.data.total })
            : null
        }
      >
        <Pending query={cards}>
          {() => (
            <>
              <p>
                {due > 0
                  ? t("examPage.cardsDue", { count: due })
                  : cards.data!.total > 0
                    ? t("examPage.cardsNoneDue")
                    : t("examPage.cardsNone")}
              </p>
              <div className="px-exam-arow">
                {due > 0 ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    focusKey="exam:cards-due"
                    onClick={() => navigate(`/cards/due?exam=${encodeURIComponent(planId)}`)}
                  >
                    {t("examPage.cardsReview", { count: due })}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  focusKey="exam:cards-all"
                  onClick={() => navigate(`/exams/cards?exam=${encodeURIComponent(planId)}`)}
                >
                  {t("examPage.browseCards")}
                </Button>
              </div>
            </>
          )}
        </Pending>
      </AsideSection>
      <AsideSection
        title={t("examPage.redo")}
        count={
          entries.length
            ? t("examPage.questions", { count: entries.length })
            : null
        }
      >
        <Pending query={mistakes}>
          {() =>
            entries.length ? (
              <>
                {mistakeTopics.length ? (
                  <p>
                    {t("examPage.redoTopics", {
                      topics: new Intl.ListFormat(i18n.language, {
                        type: "conjunction",
                      }).format(mistakeTopics.slice(0, 3)),
                    })}
                  </p>
                ) : null}
                {redoFailed ? (
                  <p className="px-exam-asec-error">
                    {t("examPage.redoFailed")}
                  </p>
                ) : null}
                <div className="px-exam-arow">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={redoing}
                    focusKey="exam:redo"
                    onClick={() => void redo()}
                  >
                    {redoing ? (
                      <span className="px-xpath-working">
                        <Logo working decorative size={16} />
                        {t("examPage.redoPreparing")}
                      </span>
                    ) : (
                      t("examPage.redoCount", {
                        count: Math.min(10, entries.length),
                      })
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    focusKey="exam:mistakes"
                    onClick={() =>
                      navigate(
                        `/exams/mistakes?exam=${encodeURIComponent(planId)}`,
                      )
                    }
                  >
                    {t("mistakes.title")}
                  </Button>
                </div>
              </>
            ) : (
              <p>{t("examPage.redoNone")}</p>
            )
          }
        </Pending>
      </AsideSection>
      <AsideSection title={t("maps.title")}>
        <Pending query={maps}>
          {() => (
            <>
              {subjectMaps.length ? (
                <ul className="px-exam-maps">
                  {subjectMaps.slice(0, 3).map((map) => (
                    <li key={map.id}>
                      <Link className="px-exam-mthumb" to={mapPath(map)}>
                        <span className="px-exam-mthumb-art">
                          <MapThumb shape={map.shape} />
                        </span>
                        <span>
                          <b>{map.title}</b>
                          <small>
                            {map.topicTitle ?? t("maps.wholeSubject")}
                          </small>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t("examPage.mapsNone")}</p>
              )}
              {/* Maps opens at this subject; with none yet, the way on is making one for it. */}
              <Link
                className="px-exam-alink"
                to={
                  subjectMaps.length
                    ? subjectId
                      ? `/maps?subject=${encodeURIComponent(subjectId)}`
                      : "/maps"
                    : subjectId
                      ? `/maps?subject=${encodeURIComponent(subjectId)}&new=1`
                      : "/maps?new=1"
                }
              >
                {t(subjectMaps.length ? "examPage.allMaps" : "examPage.makeMap")}
                <Icon name="chevron-right" size={14} />
              </Link>
            </>
          )}
        </Pending>
      </AsideSection>
      <AsideSection title={t("examPage.material")}>
        {covers.length ? (
          <ul className="px-exam-mats">
            {covers.slice(0, 6).map((cover) => (
              <li key={cover.id}>
                <button
                  type="button"
                  className="px-exam-cov"
                  onClick={() => setDetailSourceId(cover.id)}
                >
                  <span className="px-exam-art">
                    <FileCover kind={cover.kind} colour={cover.colour} symbol={cover.symbol} scale={0.62} />
                  </span>
                  <span className="px-exam-cov-title">{cover.title}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t("planOverview.noSources")}</p>
        )}
        {plan.needsRebuild ? (
          <p className="px-exam-asec-note">{t("examPage.rebuildSuggested")}</p>
        ) : null}
        <Link className="px-exam-alink" to={`/plans/${planId}/sources`}>
          {covers.length
            ? t("examPage.allMaterial")
            : t("examPage.addMaterial")}
          <Icon name="chevron-right" size={14} />
        </Link>
      </AsideSection>
      <SourceDetails
        sourceId={detailSourceId}
        known={plan.sources.find((source) => source.id === detailSourceId)}
        onClose={() => setDetailSourceId(null)}
        onOpen={setDetailSourceId}
      />
    </aside>
  );
}

/** The page's shape while the exam loads from this computer, after 150 ms. */
function ExamSkeleton({ label }: { label: string }) {
  return (
    <div className="px-exam px-skeleton" role="status" aria-label={label}>
      <div className="px-exam-head" aria-hidden>
        <div className="px-exam-name">
          <i
            className="px-skeleton-bar is-title"
            style={{ width: 220, height: 32 }}
          />
          <i className="px-skeleton-bar" style={{ width: 180 }} />
        </div>
        <i className="px-skeleton-bar is-ring" />
      </div>
      <div className="px-exam-grid" aria-hidden>
        <div className="px-exam-now">
          <i className="px-skeleton-bar is-title" style={{ width: "60%" }} />
        </div>
        <div className="px-exam-path">
          {[70, 55, 62, 48].map((width) => (
            <i
              key={width}
              className="px-skeleton-bar"
              style={{ width: `${width}%`, margin: "18px 0" }}
            />
          ))}
        </div>
        <div className="px-exam-aside" />
      </div>
    </div>
  );
}
