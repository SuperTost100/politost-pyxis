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
  details,
}: {
  tone: keyof typeof tones;
  children: ReactNode;
  action?: { label: string; onClick: () => void };
  details?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const Icon = tones[tone].icon;
  return (
    <div
      className={["px-notice", tones[tone].className].join(" ")}
      role="status"
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden />
      <div className="px-notice-body">
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
      {action ? (
        <Button type="text" size="small" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
