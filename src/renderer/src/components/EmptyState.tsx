import type { ReactNode } from "react";
import "./EmptyState.css";

/**
 * What a page shows when it has nothing yet: one line on what will appear here, then the one action that starts it, in
 * the place where the content will be. There is no title, because the page's own title says what is empty, and no
 * second button. `art` is a drawing above the line; with none, nothing is reserved for it.
 */
export function EmptyState({ body, action, art }: { body: string; action?: ReactNode; art?: ReactNode }) {
  return (
    <div className="px-empty">
      {art ? (
        <div className="px-empty-art" aria-hidden>
          {art}
        </div>
      ) : null}
      <p className="px-empty-line">{body}</p>
      {action ? <div className="px-empty-action">{action}</div> : null}
    </div>
  );
}
