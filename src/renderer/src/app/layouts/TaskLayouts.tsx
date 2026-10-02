import { Button } from "antd";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

export function EmptyState(props: {
  title: string;
  body: string;
  action?: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <div className="empty">
      <h2 className="title-2">{props.title}</h2>
      <p className="body">{props.body}</p>
      <div className="empty-actions">
        {props.action}
        {props.secondary}
      </div>
    </div>
  );
}

export function FocusLayout(props: {
  title: string;
  meta?: string;
  children: ReactNode;
  primary?: ReactNode;
  secondary?: ReactNode;
  progress?: number;
  closable?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="focus">
      <header className="focus-bar">
        {props.closable === false ? (
          <span />
        ) : (
          <Button
            shape="circle"
            type="text"
            aria-label={t("nav.close")}
            icon={<X size={18} strokeWidth={1.75} />}
            onClick={() => navigate("/exams")}
          />
        )}
        <div>
          <h1 className="title-3 focus-title">{props.title}</h1>
          {props.meta ? (
            <div className="meta focus-meta">{props.meta}</div>
          ) : null}
        </div>
        <span />
      </header>
      {props.progress != null ? (
        <div
          className="focus-progress"
          style={{ width: `${Math.round(props.progress * 100)}%` }}
        />
      ) : null}
      <main className="focus-main">
        <div className="column">
          {props.children}
          <div className="focus-actions-bar">
            <span>{props.secondary}</span>
            <span>{props.primary}</span>
          </div>
        </div>
      </main>
    </div>
  );
}

export function CanvasLayout(props: {
  title: string;
  children: ReactNode;
  closeTo?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="canvas">
      <header className="canvas-bar">
        <Button
          shape="circle"
          type="text"
          aria-label={t("nav.close")}
          icon={<X size={18} strokeWidth={1.75} />}
          onClick={() => navigate(props.closeTo ?? "/ask")}
        />
        <h1 className="title-3 focus-title">{props.title}</h1>
        <span />
      </header>
      <main className="canvas-stage">{props.children}</main>
    </div>
  );
}
