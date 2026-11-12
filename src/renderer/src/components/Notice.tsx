import { Button } from "antd";
import { CircleX, Info, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import "./Notice.css";

const tones = {
  info: { icon: Info, className: "is-info" },
  warning: { icon: TriangleAlert, className: "is-warning" },
  danger: { icon: CircleX, className: "is-danger" },
} as const;

export function Notice({
  tone,
  children,
  action,
  secondary,
  details,
  title,
  titleLevel = 2,
}: {
  tone: keyof typeof tones;
  children: ReactNode;
  /** The notice's one action; `disabled` while what it starts can't start yet. */
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** A second, quieter choice beside the main action, such as going on without it or dismissing the notice. */
  secondary?: { label: string; onClick: () => void; disabled?: boolean };
  details?: string;
  /** A short heading above the sentence, for a message that stands for the whole page. */
  title?: ReactNode;
  /** The heading level of `title`; 1 when the message is the whole page. */
  titleLevel?: 1 | 2;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const Icon = tones[tone].icon;
  const Heading = `h${titleLevel}` as const;
  return (
    <div
      className={["px-notice", tones[tone].className].join(" ")}
      role={tone === "danger" ? "alert" : "status"}
    >
      <span className="px-notice-line">
        <Icon size={16} strokeWidth={1.75} aria-hidden />
      </span>
      <div className="px-notice-body">
        {title ? <Heading className="px-notice-title">{title}</Heading> : null}
        <p className="px-notice-text">{children}</p>
        {details ? (
          <button
            type="button"
            className="px-notice-details-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {t("components.notice.details")}
          </button>
        ) : null}
        {details && open ? (
          <pre
            className="px-notice-details code"
            tabIndex={0}
            aria-label={t("components.notice.details")}
          >
            {details}
          </pre>
        ) : null}
      </div>
      {action || secondary ? (
        <span className="px-notice-line px-notice-actions">
          {action ? (
            <Button type="text" size="small" disabled={action.disabled} onClick={action.onClick}>
              {action.label}
            </Button>
          ) : null}
          {secondary ? (
            <Button type="text" size="small" disabled={secondary.disabled} onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
