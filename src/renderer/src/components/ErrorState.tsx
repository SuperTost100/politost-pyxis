import type { ReactNode } from "react";
import { Notice } from "./Notice";

/**
 * A failed load, build or quiz: one danger Notice with a sentence that says what failed, the action that fixes it,
 * and the technical message behind Details. Screens use this and nothing else for a failure, and put it in the
 * page column.
 */
export function ErrorState({
  title,
  titleLevel,
  children,
  action,
  secondary,
  details,
}: {
  /** A heading, for a failure that fills the page. */
  title?: ReactNode;
  titleLevel?: 1 | 2;
  children: ReactNode;
  action?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
  /** The technical message. Shown only when the student opens Details. */
  details?: string | null;
}) {
  return (
    <Notice
      tone="danger"
      title={title}
      titleLevel={titleLevel}
      action={action}
      secondary={secondary}
      details={details?.trim() ? details.trim().slice(0, 2000) : undefined}
    >
      {children}
    </Notice>
  );
}
