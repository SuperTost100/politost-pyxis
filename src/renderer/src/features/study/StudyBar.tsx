import { Button, type ButtonProps } from "antd";
import { ChevronDown } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { BackControl } from "../../components/BackControl";
import type { BackTarget } from "../../app/usePlace";
import { JobsButton } from "../jobs/JobsButton";
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
 * One of a screen's tools in the bar: a ghost button with an icon and a word. Under 1,100 px the word is kept for
 * screen readers only, so the bar never grows a second row.
 */
export function BarTool({
  icon,
  label,
  ...rest
}: Omit<ButtonProps, "icon" | "children" | "type" | "className"> & { icon: ReactNode; label: string; "aria-keyshortcuts"?: string }) {
  return (
    <Button {...rest} type="text" className="px-studybar-action" icon={icon} title={label}>
      <span className="px-studybar-label">{label}</span>
    </Button>
  );
}

/**
 * The bar over every study screen: the way back with the place's name, a thin separator, the title over a line that
 * says what the student is doing and where, then the screen's tools, its dots menu and, always last at the far right,
 * Attività. It is the window's drag strip, so on macOS it leaves room for the traffic lights and only its controls
 * take clicks.
 */
export function StudyBar({
  back,
  title,
  subtitle,
  tools,
  menu,
  progress,
  heading = true,
  titleMenu,
  noWayOut,
  className,
}: {
  /** The page's way back (`usePlace`). Without it the bar has no way out, as in a running exam simulation. */
  back?: BackTarget | null;
  title: string;
  /** The line under the title: what the student is doing and where they are in it. */
  subtitle?: string;
  /** The screen's own tools, as `BarTool`s or a clock. */
  tools?: ReactNode;
  /** The screen's dots (`MenuButton`), after the tools. */
  menu?: ReactNode;
  /** 0 to 1: a thin line along the bar's bottom edge. */
  progress?: number;
  /** The title is the page's heading; a page with its own heading below shows the bar's title to sight only. */
  heading?: boolean;
  /** Why nothing leaves this page, as on a running exam: Attività then offers no link that goes elsewhere. */
  noWayOut?: string;
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
      <div className="px-studybar-actions">
        {tools}
        {menu}
        {/* The shell's jobs entry, so work running while a student studies stays in sight, last at the far right. */}
        <JobsButton keep leave={back?.leave} blocked={noWayOut} />
      </div>
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
