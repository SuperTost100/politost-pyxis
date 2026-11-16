import type { ReactNode } from "react";
import "./EmptyState.css";

/**
 * What a page shows when it has nothing yet: one line on what will appear here, then the one action that starts it. There
 * is no title, because the page's own title says what is empty, and no second button.
 *
 * With `centred` the block is the page's whole body and sits in the middle of the room under the page's head, across and
 * down (EmptyState.css makes the page at least as tall as the window). `art` is a drawing above the line and belongs to
 * that case. Without `centred` the block is small and stays under the head, left-aligned, so a page that also shows
 * something else, such as the Library's subjects, keeps its content in place.
 */
export function EmptyState({
  body,
  action,
  art,
  centred = false,
}: {
  body: string;
  action?: ReactNode;
  art?: ReactNode;
  centred?: boolean;
}) {
  return (
    <div className={centred ? "px-empty px-empty-centred" : "px-empty"}>
      {centred && art ? (
        <div className="px-empty-art" aria-hidden>
          {art}
        </div>
      ) : null}
      <p className="px-empty-line">{body}</p>
      {action ? <div className="px-empty-action">{action}</div> : null}
    </div>
  );
}
