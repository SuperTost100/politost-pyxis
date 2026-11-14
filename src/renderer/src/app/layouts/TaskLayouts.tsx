import type { ReactNode } from "react";

export function EmptyState(props: {
  /** Left out where the page's own title already says what is empty. */
  title?: string;
  body: string;
  action?: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <div className="empty">
      {props.title ? <h2 className="title-2">{props.title}</h2> : null}
      <p className="body">{props.body}</p>
      <div className="empty-actions">
        {props.action}
        {props.secondary}
      </div>
    </div>
  );
}
