import { ChevronDown } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { BackControl } from "../../components/BackControl";
import type { BackTarget } from "../../app/usePlace";
import "./StudyBar.css";

/** A bar title that opens a panel under it, such as the parts of a lesson in a narrow window. */
export type StudyTitleMenu = {
  anchor: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onToggle: () => void;
  /** The panel's id while it is open. */
  controls?: string;
};

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
  titleMenu,
  className,
}: {
  /** The page's way back (`usePlace`). Without it the bar has no way out, as in a running exam simulation. */
  back?: BackTarget | null;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** 0 to 1: a thin line along the bar's bottom edge. */
  progress?: number;
  /** The title is the page's heading; a page with its own heading below shows the bar's title to sight only. */
  heading?: boolean;
  /** The title and its line become one button with a chevron that opens a panel under it. */
  titleMenu?: StudyTitleMenu;
  className?: string;
}) {
  return (
    <header className={className ? `px-studybar ${className}` : "px-studybar"}>
      {back ? (
        <>
          <BackControl target={back} variant="bar" />
          <span className="px-studybar-sep" aria-hidden />
        </>
      ) : null}
      {titleMenu ? (
        <div className="px-studybar-title">
          <button
            ref={titleMenu.anchor}
            type="button"
            className="px-studybar-title-menu"
            aria-haspopup="dialog"
            aria-expanded={titleMenu.open}
            aria-controls={titleMenu.open ? titleMenu.controls : undefined}
            onClick={titleMenu.onToggle}
          >
            <span className="px-studybar-title-text">
              <b>{title}</b>
              {subtitle ? <span className="px-studybar-title-line">{subtitle}</span> : null}
            </span>
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden className={titleMenu.open ? "is-open" : undefined} />
          </button>
        </div>
      ) : (
        <div className="px-studybar-title">
          {/* On a reading screen the page's own heading names it, so only the bar's copy of the title is hidden; the
              line under it is the one place that names the exam. */}
          {heading ? <h1>{title}</h1> : <b aria-hidden>{title}</b>}
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
      )}
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

/**
 * A study screen that is not a reading: the bar over one centred column, with an optional row of actions at its end.
 * `wide` gives the content the whole width under the bar, for a screen that lays out its own columns, such as the quiz.
 */
export function StudyLayout({
  children,
  primary,
  secondary,
  wide,
  ...bar
}: Parameters<typeof StudyBar>[0] & {
  children: ReactNode;
  primary?: ReactNode;
  secondary?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="focus">
      <StudyBar {...bar} />
      {wide ? (
        <main className="focus-main is-wide">{children}</main>
      ) : (
        <main className="focus-main">
          <div className="column">
            {children}
            <div className="focus-actions-bar">
              <span>{secondary}</span>
              <span>{primary}</span>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
