import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import "./StudyBar.css";

/** Where the bar's back button leads. `label` is read before `text`, such as "Back to the exam: Fisica I". */
export type StudyBack = { text: string; label?: string; onClick: () => void };

/**
 * The bar over every study screen (pyxis-mockups app/study.html, ".stepbar"): the way back with the exam's name, a thin
 * separator, the screen's title over a small line, and the screen's actions on the right. It is the window's drag
 * strip, so on macOS it leaves room for the traffic lights and only its controls take clicks.
 */
export function StudyBar({
  back,
  title,
  subtitle,
  actions,
  progress,
  heading = true,
  className,
}: {
  /** Without it the bar has no way out, as in a running exam simulation. */
  back?: StudyBack;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** 0 to 1: a thin line along the bar's bottom edge. */
  progress?: number;
  /** The title is the page's heading; a page with its own heading below shows the bar's title to sight only. */
  heading?: boolean;
  className?: string;
}) {
  return (
    <header className={className ? `px-studybar ${className}` : "px-studybar"}>
      {back ? (
        <>
          <button type="button" className="px-studybar-back" onClick={back.onClick}>
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
            {back.label ? <span className="visually-hidden">{back.label}: </span> : null}
            <span className="px-studybar-back-text">{back.text}</span>
          </button>
          <span className="px-studybar-sep" aria-hidden />
        </>
      ) : null}
      <div className="px-studybar-title" aria-hidden={heading ? undefined : true}>
        {heading ? <h1>{title}</h1> : <b>{title}</b>}
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="px-studybar-actions">{actions}</div> : null}
      {progress != null ? (
        <div
          className="px-studybar-progress"
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      ) : null}
    </header>
  );
}

/** A study screen that is not a reading: the bar over one centred column, with an optional row of actions at its end. */
export function StudyLayout({
  children,
  primary,
  secondary,
  ...bar
}: Parameters<typeof StudyBar>[0] & {
  children: ReactNode;
  primary?: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <div className="focus">
      <StudyBar {...bar} />
      <main className="focus-main">
        <div className="column">
          {children}
          <div className="focus-actions-bar">
            <span>{secondary}</span>
            <span>{primary}</span>
          </div>
        </div>
      </main>
    </div>
  );
}
