import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MenuProps } from "antd";
import { ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { MenuButton, MenuItemArea } from "../../components/ItemMenu";
import { LoadError } from "../../components/LoadError";
import { SkeletonRows } from "../../components/Skeleton";
import { errorDetails } from "../../lib/errorDetails";
import { claimOnce } from "../../lib/claimOnce";
import { cardSectionsQuery } from "../../lib/queries";
import { useStillHere } from "../../lib/useStillHere";
import { stepPath } from "../plans/reopen";
import { AnkiModal } from "../home/AnkiModal";
import { NewCardDialog, type NewCardSide } from "./NewCardDialog";
import "./FlashcardsHome.css";

type Sections = RequestOutput<"study.cardSections">;
type Subject = Sections["subjects"][number];

/** Where a subject's review opens: the daily review narrowed to the subject, with `examless` to its cards with no exam. */
export function subjectReviewPath(subjectId: string | null, examless = false): string {
  // A real subject's cards with no exam have their own review, where new ones can be added to the subject.
  if (examless && subjectId) return `/cards/subject/${subjectId}`;
  const params = new URLSearchParams({ subject: subjectId ?? "none" });
  if (examless) params.set("exam", "none");
  return `/cards/due?${params.toString()}`;
}

/**
 * The Flashcard page with "Nuova flashcard" open on one side, and on a subject when `subjectId` is given. Another page
 * navigates here to let the student write a subject's flashcards, or have Pyxis write them, without leaving for a map.
 */
export function newCardPath(side: NewCardSide, subjectId?: string): string {
  const params = new URLSearchParams({ new: side });
  if (subjectId) params.set("subject", subjectId);
  return `/flashcards?${params.toString()}`;
}

/** The window's session storage, or nothing where the browser refuses it. */
function sessionOf(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** The id of a subject's heading, so the search can bring it into view. */
const headingId = (subjectId: string | null) => `px-fc-${subjectId ?? "none"}`;

/**
 * The Flashcard section: every subject's flashcards, by exam and topic, with those with no exam last. The head holds
 * the page's menu (Anki), "Sfoglia tutte" and "Nuova flashcard"; while cards are due, a band under it offers the review
 * of everything due today. The counts come from core in one read and match what each review shows.
 */
export function FlashcardsHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const sections = useQuery(cardSectionsQuery);
  const data = sections.data;
  const go = (path: string) => navigate(path);
  const client = useQueryClient();

  // Import and export Anki packages: the page's menu, in the dots of the head and on a right-click on it.
  const [anki, setAnki] = useState<"import" | "export" | null>(null);
  const menu: MenuProps = {
    items: [
      { key: "import", label: t("cardImport.open") },
      { key: "export", label: t("cardExport.open") },
    ],
    onClick: ({ key }) => setAnki(key === "export" ? "export" : "import"),
  };

  // The band under the head. It stays mounted once the counts are in and closes when nothing is due, so a review that
  // finishes the day's cards closes it in place instead of removing it from under the page, and it keeps the last
  // counts it showed while it closes.
  const due = data?.due ?? 0;
  const dueSubjects = data ? data.subjects.filter((subject) => subject.due > 0).length : 0;
  const [shown, setShown] = useState({ due, subjects: dueSubjects });
  if (due > 0 && (shown.due !== due || shown.subjects !== dueSubjects)) setShown({ due, subjects: dueSubjects });
  // A page that opens with its counts already known (a return to it) shows the band as it was; one that waits for them
  // opens it out of the head (FlashcardsHome.css).
  const [waited] = useState(!data);

  // "Nuova flashcard": the page's button opens it; another page opens it with `newCardPath` (`?new=…&subject=…`).
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<{ side: NewCardSide; subjectId?: string } | null>(null);
  const newButton = useRef<HTMLSpanElement>(null);
  const stillHere = useStillHere();
  useEffect(() => {
    const side = params.get("new");
    if (side !== "hand" && side !== "pyxis") return;
    // Taking the two parameters out applies to the router's current page, and this effect can run after the student has
    // gone on: then it opens nothing and cleans nothing, or it would pull them back here. A request that arrives while
    // another navigation is under way is dropped the same way.
    if (!stillHere()) return;
    // Asked once per history entry: Back and Forward to this entry, or a reload of it, do not open the dialog again.
    if (!claimOnce(sessionOf(), "new-card", location.key)) return;
    setDialog({ side, subjectId: params.get("subject") ?? undefined });
    setParams(
      (next) => {
        next.delete("new");
        next.delete("subject");
        return next;
      },
      { replace: true },
    );
  }, [params]);
  // The subject that just got flashcards is tinted for a moment, and a screen reader hears how many.
  const [landed, setLanded] = useState<{ subjectId: string; at: number } | null>(null);
  const [said, setSaid] = useState("");
  // A screen reader speaks a live region when its text changes, so a second save that says the same words is first
  // cleared and then said again.
  const sayTimer = useRef(0);
  function say(text: string) {
    setSaid("");
    window.clearTimeout(sayTimer.current);
    sayTimer.current = window.setTimeout(() => setSaid(text), 60);
  }
  useEffect(() => () => window.clearTimeout(sayTimer.current), []);
  const newCard = (variant: "primary" | "secondary") => (
    <span className="px-fc-new" ref={newButton}>
      <Button variant={variant} icon="plus" onClick={() => setDialog({ side: "hand" })}>
        {t("flashcards.new.action")}
      </Button>
    </span>
  );

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
    body = <EmptyState body={t("flashcards.emptyBody")} action={newCard("primary")} />;
  else
    body = (
      <div className="px-fc-subjects">
        {data.subjects.map((subject) => (
          <SubjectCard
            key={subject.subjectId ?? "none"}
            subject={subject}
            go={go}
            landed={landed && landed.subjectId === subject.subjectId ? landed.at : undefined}
          />
        ))}
      </div>
    );

  const hasCards = data !== undefined && data.subjects.length > 0;
  return (
    <div className="px-fc">
      <MenuItemArea as="div" className="px-fc-head" menu={menu} region={t("cardBrowser.more")} disabled={!data}>
        <div className="px-fc-head-text">
          <h1 className="title-1">{t("flashcards.title")}</h1>
          <p className="px-fc-lead">{t("flashcards.lead")}</p>
        </div>
        {data ? (
          <div className="px-fc-actions">
            <MenuButton rightClick menu={menu} label={t("cardBrowser.more")} />
            {hasCards ? (
              <>
                <Button variant="secondary" focusKey="flashcards:all" onClick={() => go("/flashcards/all")}>
                  {t("flashcards.browseAll")}
                </Button>
                {/* One primary button in the head: the new flashcard, while the band holds the review. */}
                {newCard(due > 0 ? "secondary" : "primary")}
              </>
            ) : null}
          </div>
        ) : null}
      </MenuItemArea>
      {data ? (
        <div className="px-fc-band" data-open={due > 0} data-waited={waited || undefined} inert={due === 0}>
          <div className="px-fc-band-clip">
            <div className="px-fc-band-pad">
              <div className="px-fc-band-bar">
                <p>
                  {t("flashcards.todayLine", {
                    count: shown.due,
                    subjects: t("flashcards.todaySubjects", { count: shown.subjects }),
                  })}
                </p>
                <Button onClick={() => go("/cards/due")}>{t("flashcards.reviewToday", { count: shown.due })}</Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {body}
      <p className="visually-hidden" role="status">
        {said}
      </p>
      <AnkiModal
        mode={anki ?? "import"}
        open={anki !== null}
        onClose={() => setAnki(null)}
        onImported={() =>
          void Promise.all(
            ["card-sections", "card-browse", "cards", "card-queue", "card-suspended", "review-session"].map((key) =>
              client.invalidateQueries({ queryKey: [key] }),
            ),
          )
        }
      />
      <NewCardDialog
        open={dialog !== null}
        side={dialog?.side ?? "hand"}
        subjectId={dialog?.subjectId}
        origin={() => newButton.current?.querySelector("button") ?? null}
        onClose={() => setDialog(null)}
        onSaved={({ subjectId, name, count, closing }) => {
          setLanded({ subjectId, at: Date.now() });
          // The dialog says "Aggiunta" itself while it stays open.
          if (closing) say(t("flashcards.new.savedTo", { count, subject: name }));
        }}
      />
    </div>
  );
}

function SubjectCard({
  subject,
  go,
  landed,
}: {
  subject: Subject;
  go: (path: string) => void;
  /** When flashcards were just saved here: the card is tinted for a moment (motion.md, "An item added"). */
  landed?: number;
}) {
  const { t } = useTranslation();
  const name = subject.name ?? t("cardBrowser.noSubject");
  const id = headingId(subject.subjectId);
  return (
    <section className="px-fc-subject" aria-labelledby={id} data-landed={landed} key={landed}>
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
      <Link className="px-fc-row" to={to}>
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
