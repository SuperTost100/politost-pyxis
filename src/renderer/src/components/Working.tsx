import type { ReactNode } from "react";
import { Logo } from "./Logo";
import "./Working.css";

/**
 * Background work, drawn where its result will appear: the Pyxis mark at work and one line on what it is doing. In a
 * line of text the mark is 22 px; `slot` centres a 44 px mark in the space the result will fill, with the line under
 * it and an optional `detail`. `action` is one button, such as Stop, after the line.
 */
export function Working({
  line,
  detail,
  slot = false,
  action,
  className,
}: {
  line: ReactNode;
  detail?: ReactNode;
  slot?: boolean;
  action?: ReactNode;
  className?: string;
}) {
  const classes = [slot ? "px-working-slot" : "px-working", className].filter(Boolean).join(" ");
  // Only the mark and the line are the live region, so a screen reader does not read the action out with them.
  if (slot)
    return (
      <div className={classes}>
        <div className="px-working-status" role="status">
          <Logo size={44} working decorative />
          <p className="px-working-text">
            <span className="px-working-line">{line}</span>
            {detail ? <span className="px-working-detail">{detail}</span> : null}
          </p>
        </div>
        {action}
      </div>
    );
  return (
    <div className={classes}>
      <span className="px-working-status" role="status">
        <Logo size={22} working decorative />
        <span className="px-working-line">{line}</span>
      </span>
      {action}
    </div>
  );
}
