import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal } from "antd";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { smartLabels, smartTextToMarkdown } from "@shared/smart-text";
import { Button } from "../../components/Button";
import { ExamRings, RingLegend } from "../../components/ExamRings";
import { ErrorState } from "../../components/ErrorState";
import { Icon } from "../../components/Icon";
import { ToolbarMenu } from "../../components/ListToolbar";
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
  pastPapersQuery,
  ringsQuery,
  scheduleQuery,
  usePlan,
  useRecommend,
} from "../../lib/queries";
import { mapPath } from "../maps/mapPath";
import { MapThumb } from "../maps/MapThumb";
import { useSaveCalendar } from "../share/CalendarButton";
import { ExportButton } from "../share/ExportButton";
import { setPlanArchived } from "./archivePlan";
import { ExamCreateDialog } from "./ExamCreateDialog";
import { draftsFromSessions, nextUpcomingDay } from "./examSessions";
import { PlanPath, type TopicAction } from "./PlanPath";
import { PlanSources } from "./PlanSources";
import { skipDiagnosticPath, stepPath } from "./reopen";
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
  const recommended = useRecommend(planId);
  const schedule = useQuery({ ...scheduleQuery(planId), enabled: !!planId });
  const rings = useQuery(ringsQuery);
  const drill = useGapDrill(planId);
  const calendar = useSaveCalendar(planId);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTopic, setCreateTopic] = useState<string | undefined>(undefined);
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
  const menu = (
    <ToolbarMenu
      label={t("listToolbar.more")}
      items={[
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
      ]}
      onSelect={(key) => {
        if (key === "review") navigate(`/plans/${planId}/review`);
        if (key === "create") {
          setCreateTopic(undefined);
          setCreateOpen(true);
        }
        if (key === "calendar") void calendar.save();
        if (key === "share") setExportOpen(true);
      }}
    />
  );

  return (
    <div className="px-exam">
      <header className="px-exam-head">
        <div className="px-exam-name">
          <h1 className="title-1">{data.title}</h1>
          <p className="px-exam-date">
            <ExamWhen plan={data} />
          </p>
        </div>
        <div className="px-exam-rings">
          <ExamRings
            values={ring ?? { preparation: null, path: null, today: null }}
            label={rings.isPending ? t("components.loading") : undefined}
          />
          <RingLegend
            values={ring ?? { preparation: null, path: null, today: null }}
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
          {menu}
        </span>
      </header>
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
        <NowCard
          planId={planId}
          plan={data}
          guide={recommended.data ?? undefined}
          loading={recommended.isPending}
        />
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
        onClose={() => setCreateOpen(false)}
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

/** Adesso: the path's one suggested step, with the page's only primary button. */
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const next = guide?.next ?? null;
  const topic = next?.topicId
    ? plan.topics.find((item) => item.id === next.topicId)?.title
    : null;
  const activity = next ? t(`plans.path.activity.${next.activity}`) : null;
  const skipTo = skipDiagnosticPath(planId, plan.topics, plan.steps);
  const go = () => {
    const to = next ? stepPath(planId, next.activity, next.topicId) : null;
    if (to) navigate(to);
  };
  return (
    <section className="px-exam-now" aria-labelledby="px-exam-now-title">
      <div className="px-exam-now-text">
        <span className="px-exam-kicker">{t("plans.path.next")}</span>
        <h2 id="px-exam-now-title">
          {loading ? (
            <i className="px-skeleton-bar is-title" />
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
        {next ? (
          <p>{t(`plans.path.reason.${next.reason}`, { count: next.count })}</p>
        ) : null}
      </div>
      {next?.activity === "diagnostic" && skipTo ? (
        <Button variant="ghost" onClick={() => navigate(skipTo)}>
          {t("plans.path.skipDiagnostic")}
        </Button>
      ) : null}
      {next ? (
        <Button size="lg" onClick={go}>
          {t("planOverview.start")}
        </Button>
      ) : null}
    </section>
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

/** The kind of drawing a source gets in Materiale, from what the app knows of it today. */
function coverKind(
  kind: string,
): "book" | "slides" | "exam" | "notebook" | "photo" {
  if (kind === "smartbook" || kind === "book") return "book";
  if (kind === "image" || kind === "photo") return "photo";
  if (kind === "slides" || kind === "pptx") return "slides";
  return "notebook";
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
  const covers = [
    ...plan.sources
      .filter((source) => !paperIds.has(source.id))
      .map((source) => ({
        id: source.id,
        title: source.title,
        art: coverKind(source.kind),
      })),
    ...(papers.data?.papers ?? []).map((paper) => ({
      id: paper.sourceId,
      title: paper.title,
      art: "exam" as const,
    })),
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
                    onClick={() => navigate(`/cards/due?exam=${encodeURIComponent(planId)}`)}
                  >
                    {t("examPage.cardsReview", { count: due })}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate("/exams/cards")}
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
              <Link className="px-exam-alink" to="/maps">
                {t("examPage.allMaps")}
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
                  <span className={`px-exam-art is-${cover.art}`} aria-hidden>
                    {cover.art === "book" ? cover.title : null}
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
