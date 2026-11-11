import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useEffect, useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { Button } from "../../components/Button";
import { LoadError } from "../../components/LoadError";
import { SkeletonRows } from "../../components/Skeleton";
import { errorDetails } from "../../lib/errorDetails";
import { cardSectionsQuery } from "../../lib/queries";
import { stepPath } from "../plans/reopen";
import "./FlashcardsHome.css";

type Sections = RequestOutput<"study.cardSections">;
type Subject = Sections["subjects"][number];

/** Every review opened here comes back to this page when it closes (CardsPage reads it). */
const FROM_SECTION = { from: "flashcards" } as const;

/** Where a subject's review opens: the daily review narrowed to the subject, with `examless` to its cards with no exam. */
export function subjectReviewPath(subjectId: string | null, examless = false): string {
  // A real subject's cards with no exam have their own review, where new ones can be added to the subject.
  if (examless && subjectId) return `/cards/subject/${subjectId}`;
  const params = new URLSearchParams({ subject: subjectId ?? "none" });
  if (examless) params.set("exam", "none");
  return `/cards/due?${params.toString()}`;
}

/** The id of a subject's heading, so the search can bring it into view. */
const headingId = (subjectId: string | null) => `px-fc-${subjectId ?? "none"}`;

/**
 * The Flashcard section: every subject's flashcards, by exam and topic, with those with no exam last, and one action
 * to review everything due today. The counts come from core in one read and match what each review shows.
 */
export function FlashcardsHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const sections = useQuery(cardSectionsQuery);
  const data = sections.data;
  const go = (path: string) => navigate(path, { state: FROM_SECTION });

  // The search opens a subject here: bring its card into view and put the focus on its name.
  const wanted = (location.state as { subject?: unknown } | null)?.subject;
  useEffect(() => {
    if (!data || typeof wanted !== "string") return;
    const heading = document.getElementById(headingId(wanted === "none" ? null : wanted));
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  }, [data, wanted]);

  let body;
  if (sections.isError && !data)
    body = (
      <LoadError onRetry={() => void sections.refetch()} details={errorDetails(sections.error)}>
        {t("flashcards.loadFailed")}
      </LoadError>
    );
  // Shaped like a subject's card, so the page does not jump when the counts arrive.
  else if (!data)
    body = (
      <div className="px-fc-subjects">
        <div className="px-fc-subject px-fc-loading">
          <SkeletonRows rows={4} label={t("components.loading")} />
        </div>
      </div>
    );
  else if (data.subjects.length === 0)
    body = (
      <EmptyState
        title={t("flashcards.emptyTitle")}
        body={t("flashcards.emptyBody")}
        action={<Button onClick={() => navigate("/maps")}>{t("flashcards.emptyAction")}</Button>}
      />
    );
  else
    body = (
      <div className="px-fc-subjects">
        {data.subjects.map((subject) => (
          <SubjectCard key={subject.subjectId ?? "none"} subject={subject} go={go} />
        ))}
      </div>
    );

  return (
    <div className="px-fc">
      <div className="px-fc-head">
        <div>
          <h1 className="title-1">{t("flashcards.title")}</h1>
          <p className="px-fc-lead">{t("flashcards.lead")}</p>
        </div>
        {data && data.subjects.length > 0 ? (
          data.due > 0 ? (
            <Button onClick={() => go("/cards/due")}>{t("flashcards.reviewToday", { count: data.due })}</Button>
          ) : (
            <p className="small px-fc-none">{t("flashcards.noneDue")}</p>
          )
        ) : null}
      </div>
      {body}
    </div>
  );
}

function SubjectCard({ subject, go }: { subject: Subject; go: (path: string) => void }) {
  const { t } = useTranslation();
  const name = subject.name ?? t("cardBrowser.noSubject");
  const id = headingId(subject.subjectId);
  return (
    <section className="px-fc-subject" aria-labelledby={id}>
      <div className="px-fc-subject-head">
        <div>
          <h2 className="title-2" id={id} tabIndex={-1}>
            {name}
          </h2>
          <p className="small">
            {t("cardBrowser.count", { count: subject.total })}
            {subject.due > 0 ? ` · ${t("flashcards.dueToday", { count: subject.due })}` : ""}
          </p>
        </div>
        {subject.due > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label={t("flashcards.reviewSubject", { subject: name })}
            onClick={() => go(subjectReviewPath(subject.subjectId))}
          >
            {t("flashcards.review")}
          </Button>
        ) : (
          <span className="small px-fc-none">{t("flashcards.noneDue")}</span>
        )}
      </div>
      {subject.exams.map((exam) =>
        exam.topics.length > 0 || exam.noTopic ? (
          <Group key={exam.planId} label={exam.title}>
            {exam.topics.map((topic) => (
              <Row
                key={topic.topicId}
                title={topic.title}
                total={topic.total}
                due={topic.due}
                to={stepPath(exam.planId, "cards", topic.topicId) ?? `/plans/${exam.planId}`}
              />
            ))}
            {/* The exam's cards with no topic, so the rows add up to the subject's count. */}
            {exam.noTopic ? (
              <Row
                title={t("cardBrowser.noTopic")}
                total={exam.noTopic.total}
                due={exam.noTopic.due}
                to={`/cards/due?exam=${encodeURIComponent(exam.planId)}&topic=none`}
              />
            ) : null}
          </Group>
        ) : null,
      )}
      {subject.examless ? (
        <Group label={t("cardBrowser.noExam")}>
          <Row
            title={t("flashcards.examless")}
            total={subject.examless.total}
            due={subject.examless.due}
            to={subjectReviewPath(subject.subjectId, true)}
          />
        </Group>
      ) : null}
    </section>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="px-fc-group">
      <h3 className="px-fc-group-label" id={id}>
        {label}
      </h3>
      <ul aria-labelledby={id}>{children}</ul>
    </div>
  );
}

/** A deck the student can open: its name, how many cards it holds and how many are due today. The whole row is the link. */
function Row({ title, total, due, to }: { title: string; total: number; due: number; to: string }) {
  const { t } = useTranslation();
  return (
    <li>
      <Link className="px-fc-row" to={to} state={FROM_SECTION}>
        <span className="px-fc-row-name">
          <b title={title}>{title}</b>
          <small>{t("cardBrowser.count", { count: total })}</small>
        </span>
        {due > 0 ? (
          <span className="px-fc-row-due">
            <span aria-hidden>{t("flashcards.dueShort", { count: due })}</span>
            <span className="visually-hidden">{t("flashcards.dueToday", { count: due })}</span>
          </span>
        ) : (
          <span />
        )}
        <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
      </Link>
    </li>
  );
}
