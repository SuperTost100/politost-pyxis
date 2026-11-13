import { Button } from "antd";
import { ArrowRight, Check, CircleCheck } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { Working } from "../../components/Working";
import { CitationChip } from "../../components/CitationChip";
import { openSourceViewer } from "../../components/SourceViewer";
import { JobsButton } from "../jobs/JobsButton";
import { stepPath } from "../plans/reopen";
import "./Reader.css";
import { StudyBar, type StudyTitleMenu } from "./StudyBar";
import { recommendQuery } from "../../lib/queries";
import { renderedText, wordCount } from "../../lib/renderedText";

/** About how many words a student reads a minute, for the time left in a lesson. */
const WORDS_PER_MINUTE = 200;

/** `title` is the heading as text (a formula as its TeX), `formula` says the heading holds one, drawn in the outline too. */
type Part = { id: string; title: string; formula: boolean; words: number };

/**
 * What the outline shows of a heading: its text, and each formula as the page drew it. The nodes are copies of ones
 * React and KaTeX already made for the lesson, so nothing is parsed from a string. Other markup (emphasis, code) is
 * left out so an entry stays one plain line, and so are ids, which must stay unique on the page.
 */
function headingNodes(from: Node, into: Node[] = []): Node[] {
  for (const child of from.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) into.push(child.cloneNode());
    else if (child instanceof Element) {
      if (child.classList.contains("katex")) {
        const copy = child.cloneNode(true) as Element;
        copy.removeAttribute("id");
        for (const inner of copy.querySelectorAll("[id]")) inner.removeAttribute("id");
        into.push(copy);
      } else headingNodes(child, into);
    }
  }
  return into;
}

/** An outline entry's heading. With a formula it is copied from the lesson's heading again whenever the heading's text changes. */
function PartTitle({ part }: { part: Part }) {
  const box = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const head = document.getElementById(part.id);
    if (part.formula) box.current?.replaceChildren(...(head ? headingNodes(head) : []));
  }, [part.id, part.title, part.formula]);
  // Different keys, so React never reuses the box it fills by hand for plain text.
  return part.formula ? <span key="formula" ref={box} /> : <span key="plain">{part.title}</span>;
}

/**
 * The reading page shared by lessons and the course introduction (pyxis-mockups app/study.html, "s-lesson"): the study
 * bar with the way back, the page's name and its actions, over one white sheet about 87 characters a line. With `outline`, the
 * sheet's sections are listed beside it, with what has been read ticked, the current one marked and the time left. A
 * lesson part puts its parts there instead (`side`), and in a window too narrow for that column it opens them from the
 * bar's title (`barMenu`).
 */
export function ReaderLayout({
  eyebrow,
  title,
  backLabel,
  backText,
  barTitle,
  barSubtitle,
  onBack,
  actions,
  outline = false,
  side,
  barMenu,
  meta,
  titleFocusable = false,
  headProps,
  sheetClassName,
  children,
}: {
  eyebrow?: ReactNode;
  /** The sheet's heading: text, or a part's title drawn with its formulas. */
  title: ReactNode;
  /** The back button's name. With `backText` it is read before that text. */
  backLabel: string;
  /** Shown beside the back arrow, as the exam's name; until it is known the arrow shows `backLabel`. */
  backText?: string;
  /** The page's name in the bar, over `barSubtitle`. */
  barTitle: string;
  barSubtitle?: string;
  onBack: () => void;
  actions?: ReactNode;
  outline?: boolean;
  /** Drawn in the outline's column, which hides under 1,100 px, such as a lesson's parts. */
  side?: ReactNode;
  /** The bar's title opens a panel under it, such as the parts when their column is hidden. */
  barMenu?: StudyTitleMenu;
  /** A line under the heading, such as a part's minutes. */
  meta?: ReactNode;
  /** The heading can take the focus, as a part's does when Continua opens it. */
  titleFocusable?: boolean;
  /** On the sheet's head, such as the handlers that open a part's menu on a right-click. */
  headProps?: HTMLAttributes<HTMLElement>;
  sheetClassName?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [parts, setParts] = useState<Part[]>([]);
  const [current, setCurrent] = useState(0);
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
  // The outline reads the sheet's own section headings, so it follows the text as it is written and rewritten.
  useEffect(() => {
    const node = sheet.current;
    if (!outline || !node) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const heads = [...node.querySelectorAll<HTMLHeadingElement>(".px-markdown h2")];
      const next = heads.map((head, index) => {
        if (!head.id) head.id = `px-part-${index}`;
        const range = document.createRange();
        range.setStartBefore(head);
        const following = heads[index + 1];
        if (following) range.setEndBefore(following);
        else range.setEndAfter(node.lastChild ?? head);
        // A formula is one word in the count, and once in the title, though KaTeX draws it three times.
        return {
          id: head.id,
          title: renderedText(head),
          formula: head.querySelector(".katex") !== null,
          words: wordCount(range.cloneContents()),
        };
      });
      setParts((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    read();
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(read);
    });
    observer.observe(node, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [outline]);
  // The current section is the last one whose heading has reached the top third of the window.
  useEffect(() => {
    if (parts.length === 0) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const line = window.innerHeight / 3;
      let index = 0;
      parts.forEach((part, at) => {
        const head = document.getElementById(part.id);
        if (head && head.getBoundingClientRect().top <= line) index = at;
      });
      setCurrent(index);
    };
    place();
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [parts]);
  const minutes = Math.ceil(parts.slice(current).reduce((sum, part) => sum + part.words, 0) / WORDS_PER_MINUTE);
  const showOutline = !side && outline && parts.length > 1;
  return (
    <div className="px-reader">
      <StudyBar
        className={`px-reader-bar${scrolled ? " is-scrolled" : ""}`}
        heading={false}
        back={backText ? { text: backText, label: backLabel, onClick: onBack } : { text: backLabel, onClick: onBack }}
        title={barTitle}
        subtitle={barSubtitle}
        titleMenu={barMenu}
        actions={
          <>
            {/* The shell's jobs entry, so work running while a student reads stays in sight. It shows only once a job has run today. */}
            <JobsButton />
            {actions}
          </>
        }
      />
      <main className={showOutline || side ? "px-reader-main has-outline" : "px-reader-main"}>
        {side ? <div className="px-reader-side">{side}</div> : null}
        {showOutline ? (
          <nav className="px-reader-outline" aria-label={t("lesson.outline")}>
            <p className="px-reader-outline-label" aria-hidden>
              {t("lesson.outline")}
            </p>
            <ol>
              {parts.map((part, index) => (
                <li key={part.id}>
                  <button
                    type="button"
                    className={index < current ? "is-read" : index === current ? "is-current" : undefined}
                    aria-current={index === current ? "location" : undefined}
                    onClick={() =>
                      document.getElementById(part.id)?.scrollIntoView({
                        block: "start",
                        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                      })
                    }
                  >
                    {index < current ? (
                      <Check size={14} strokeWidth={2} aria-hidden />
                    ) : index === current ? (
                      <ArrowRight size={14} strokeWidth={2} aria-hidden />
                    ) : (
                      <span className="px-reader-outline-dot" aria-hidden />
                    )}
                    <PartTitle part={part} />
                  </button>
                </li>
              ))}
            </ol>
            {minutes > 0 ? (
              <p className="px-reader-outline-time">{t("lesson.minutesLeft", { count: minutes })}</p>
            ) : null}
          </nav>
        ) : null}
        <article ref={sheet} className={["px-reader-column passage", sheetClassName].filter(Boolean).join(" ")}>
          <header {...headProps} className="px-reader-head">
            {eyebrow ? <p className="label ink-muted px-reader-kicker">{eyebrow}</p> : null}
            <h1 ref={heading} className="title-1" tabIndex={titleFocusable ? -1 : undefined}>
              {title}
            </h1>
            {meta}
          </header>
          {children}
        </article>
      </main>
    </div>
  );
}

/**
 * The AI writing the page: the working mark with what it writes and a Stop action. Before the first words it stands
 * where the text will appear; once text is on screen it is one line under it (`pending`).
 */
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
  /** More is coming below text already on screen. */
  pending?: boolean;
}) {
  const stop = onStop ? (
    <Button size="small" type="text" onClick={onStop}>
      {stopLabel}
    </Button>
  ) : null;
  if (empty) return <Working slot className="px-reader-working" line={label} detail={detail} action={stop} />;
  return (
    <Working
      className={`px-reader-status${pending ? " is-after" : ""}`}
      line={
        <>
          <span className="small">{label}</span>
          {detail ? <span className="small body-strong px-reader-detail">{detail}</span> : null}
        </>
      }
      action={stop}
    />
  );
}

/** A page read from this computer: skeleton lines in the shape of the text, shown once the read has taken 150 ms. */
export function ReaderLoading({ label }: { label: string }) {
  // The label arrives after the live region, with the skeleton, so a screen reader announces it (as SkeletonRows).
  const [said, setSaid] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSaid(true), 150);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="px-reader-skeleton" role="status">
      <span className="visually-hidden">{said ? label : ""}</span>
      <span className="is-heading" />
      <span />
      <span />
      <span className="is-short" />
      <span />
      <span />
      <span className="is-short" />
    </div>
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
