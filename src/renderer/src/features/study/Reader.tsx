import { Button } from "antd";
import { ArrowLeft, CircleCheck, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { CitationChip } from "../../components/CitationChip";
import { openSourceViewer } from "../../components/SourceViewer";
import { stepPath } from "../plans/reopen";
import "./Reader.css";
import { recommendQuery } from "../../lib/queries";

/**
 * The reading page shared by lessons and the course introduction: a slim sticky bar (back, title once the heading has
 * scrolled away, page actions) over a ~720px book-like column.
 */
export function ReaderLayout({
  eyebrow,
  title,
  backLabel,
  onBack,
  actions,
  children,
}: {
  eyebrow?: string;
  title: string;
  backLabel: string;
  onBack: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const element = heading.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setScrolled(!entry!.isIntersecting),
      { rootMargin: "-56px 0px 0px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="px-reader">
      <header className={`focus-bar px-reader-bar${scrolled ? " is-scrolled" : ""}`}>
        <Button
          shape="circle"
          type="text"
          aria-label={backLabel}
          title={backLabel}
          icon={<ArrowLeft size={18} strokeWidth={1.75} />}
          onClick={onBack}
        />
        <p className="title-3 px-reader-bar-title" aria-hidden>
          {title}
        </p>
        <div className="px-reader-actions">{actions}</div>
      </header>
      <main className="px-reader-main">
        <article className="px-reader-column passage">
          <header className="px-reader-head">
            {eyebrow ? <p className="label ink-muted">{eyebrow}</p> : null}
            <h1 ref={heading} className="title-1">
              {title}
            </h1>
          </header>
          {children}
        </article>
      </main>
    </div>
  );
}

/** "Writing…" with a Stop action, and skeleton lines until the first words arrive. */
export function ReaderProgress({
  label,
  detail,
  stopLabel,
  onStop,
  empty,
  pending = false,
}: {
  label: string;
  /** Names what is being written, after the label. */
  detail?: ReactNode;
  stopLabel?: string;
  onStop?: () => void;
  empty: boolean;
  /** More is coming below text already on screen: shows the lines of the next section, without a heading bar. */
  pending?: boolean;
}) {
  return (
    <>
      <div className={`px-reader-status${pending && !empty ? " is-after" : ""}`} role="status">
        <LoaderCircle className="px-reader-spinner" size={16} strokeWidth={1.75} aria-hidden />
        <span className="small">{label}</span>
        {detail ? <span className="small body-strong px-reader-detail">{detail}</span> : null}
        {onStop ? (
          <Button size="small" type="text" onClick={onStop}>
            {stopLabel}
          </Button>
        ) : null}
      </div>
      {empty || pending ? (
        <div className="px-reader-skeleton" aria-hidden>
          {empty ? <span className="is-heading" /> : null}
          <span />
          <span />
          <span className="is-short" />
          {empty ? (
            <>
              <span />
              <span />
              <span className="is-short" />
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * After a reading is done, opens the plan's next suggested step, or the plan when there is none or the suggestion is
 * this same page.
 */
export function useOpenNext(planId: string) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return async () => {
    const guide = await client.fetchQuery(recommendQuery(planId));
    const next = guide?.next;
    const to = next ? stepPath(planId, next.activity, next.topicId) : null;
    navigate(to && to.split("?")[0] !== pathname ? to : `/plans/${planId}`);
  };
}

/**
 * The end of the reading. Not done yet: a hint, a quiet "Done" that stops here and a primary "Done, continue" that
 * opens the next step. Done: the same next step, or back to the path.
 */
export function ReaderEnd({
  state,
  doneLabel,
  pendingHint,
  onDone,
  onContinue,
  onBack,
  busy,
  failed,
}: {
  state: "done" | "current" | "other";
  doneLabel: string;
  /** Why the page is not done yet, such as the unanswered recap. */
  pendingHint?: string;
  /** Marks the page done and goes back to the plan. */
  onDone: () => void;
  /** Marks the page done if it is not yet, then opens the next step. */
  onContinue: () => void;
  onBack: () => void;
  /** Which action is running. */
  busy?: "done" | "continue";
  failed?: boolean;
}) {
  const { t } = useTranslation();
  if (state === "other") return null;
  const done = state === "done";
  return (
    <section className={`px-reader-end${done ? " is-done" : ""}`} aria-live="polite">
      {done ? <CircleCheck size={20} strokeWidth={1.75} aria-hidden /> : null}
      <p className={done ? "body-strong" : "small ink-muted"}>
        {done ? doneLabel : (pendingHint ?? t("lesson.finishPrompt"))}
      </p>
      <div className="px-reader-end-actions">
        <Button
          shape="round"
          loading={busy === "done"}
          disabled={busy === "continue"}
          onClick={done ? onBack : onDone}
        >
          {t(done ? "lesson.backToPath" : "lesson.done")}
        </Button>
        <Button
          type="primary"
          shape="round"
          loading={busy === "continue"}
          disabled={busy === "done"}
          onClick={onContinue}
        >
          {t(done ? "lesson.continue" : "lesson.doneContinue")}
        </Button>
      </div>
      {failed ? (
        <p className="small px-reader-error" role="alert">
          {t("planOverview.failed")}
        </p>
      ) : null}
    </section>
  );
}

type Sources = RequestOutput<"study.lesson">["sources"];

/** Collapsed list of what the lesson was given; each place opens the source viewer there. */
export function SourcesFooter({ sources }: { sources: Sources }) {
  const { t } = useTranslation();
  if (!sources.length) return null;
  return (
    <details className="px-reader-sources">
      <summary>
        <span className="label">{t("lesson.sources")}</span>
        <span className="meta ink-muted">{sources.length}</span>
      </summary>
      <ul>
        {sources.map((source) => (
          <li key={source.sourceId}>
            <p className="body-strong">{source.title}</p>
            <div className="px-reader-places">
              {source.places.map((place) => (
                <CitationChip
                  key={place.passageId}
                  kind={place.page != null ? "pdf" : "smartbook"}
                  onClick={() => openSourceViewer({ passageId: place.passageId })}
                >
                  {place.page != null
                    ? t("lesson.page", { n: place.page })
                    : place.slide != null
                      ? t("lesson.slide", { n: place.slide })
                      : place.chapter != null
                        ? t("lesson.chapter", { n: place.chapter })
                        : (place.section ?? t("lesson.open"))}
                </CitationChip>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
