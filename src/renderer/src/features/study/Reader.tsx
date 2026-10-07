import { Button } from "antd";
import { ArrowLeft, CircleCheck } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import { CitationChip } from "../../components/CitationChip";
import { openSourceViewer } from "../../components/SourceViewer";
import "./Reader.css";

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
  stopLabel,
  onStop,
  empty,
}: {
  label: string;
  stopLabel?: string;
  onStop?: () => void;
  empty: boolean;
}) {
  return (
    <>
      <div className="px-reader-status" role="status">
        <span className="px-reader-dot" aria-hidden />
        <span className="small">{label}</span>
        {onStop ? (
          <Button size="small" type="text" onClick={onStop}>
            {stopLabel}
          </Button>
        ) : null}
      </div>
      {empty ? (
        <div className="px-reader-skeleton" aria-hidden>
          <span className="is-heading" />
          <span />
          <span />
          <span className="is-short" />
          <span />
          <span />
          <span className="is-short" />
        </div>
      ) : null}
    </>
  );
}

/** The end of the reading: done, or a hint to answer the recap and a "Mark as done" fallback. */
export function ReaderEnd({
  state,
  doneLabel,
  pendingHint,
  onMarkDone,
  onBack,
  busy,
  failed,
}: {
  state: "done" | "current" | "other";
  doneLabel: string;
  /** Why the page is not done yet, such as the unanswered recap. */
  pendingHint?: string;
  onMarkDone: () => void;
  onBack: () => void;
  busy?: boolean;
  failed?: boolean;
}) {
  const { t } = useTranslation();
  if (state === "other") return null;
  if (state === "done")
    return (
      <section className="px-reader-end is-done" aria-live="polite">
        <CircleCheck size={20} strokeWidth={1.75} aria-hidden />
        <p className="body-strong">{doneLabel}</p>
        <Button type="primary" shape="round" onClick={onBack}>
          {t("lesson.backToPath")}
        </Button>
      </section>
    );
  return (
    <section className="px-reader-end" aria-live="polite">
      <p className="small ink-muted">{pendingHint ?? t("lesson.finishPrompt")}</p>
      <Button shape="round" loading={busy} onClick={onMarkDone}>
        {t("lesson.markDone")}
      </Button>
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
