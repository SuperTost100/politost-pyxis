import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { IconName } from "./Icon";
import { Icon } from "./Icon";
import { Button } from "./Button";
import { Tag } from "./Tag";
import "./EngineRow.css";

const ENG_ICON: Record<string, IconName> = {
  cli: "terminal",
  api: "key-round",
  local: "hard-drive",
  remote: "cloud",
};

export function EngineRow({
  kind,
  name,
  model,
  status = "idle",
  statusText,
  isDefault,
  onAction,
  actionLabel,
  actionDisabled,
  onDetails,
}: {
  kind: "cli" | "api" | "local" | "remote";
  name: string;
  model: string;
  status?: "ok" | "warn" | "error" | "idle";
  statusText?: string;
  isDefault?: boolean;
  onAction?: () => void;
  actionLabel?: string;
  actionDisabled?: boolean;
  onDetails?: () => void;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const statusLabels = {
    ok: t("components.engine.statusOk"),
    warn: t("components.engine.statusWarn"),
    error: t("components.engine.statusError"),
    idle: t("components.engine.statusIdle"),
  };
  const action =
    actionLabel ??
    (status === "warn"
      ? t("components.engine.signIn")
      : t("components.engine.test"));
  return (
    <div className="px-card px-engine">
      <span className="px-engine-ico">
        <Icon name={ENG_ICON[kind] ?? "cpu"} size={18} />
      </span>
      <div className="px-engine-main">
        {onDetails ? (
          <>
            <button
              type="button"
              className="px-engine-open"
              onClick={onDetails}
              aria-describedby={detailsId}
            >
              <span className="px-engine-name">
                {name}
                {isDefault ? <Tag>{t("components.engine.default")}</Tag> : null}
              </span>
              <span className="px-engine-model">{model}</span>
            </button>
            {/* The visible words name the button (WCAG 2.5.3); what it does is its description. The span sits beside the button so it stays out of the name. */}
            <span id={detailsId} className="visually-hidden">
              {t("engines.openDetails", { name })}
            </span>
          </>
        ) : (
          <>
            <div className="px-engine-name">
              {name}
              {isDefault ? (
                <span style={{ marginLeft: 8 }}>
                  <Tag>{t("components.engine.default")}</Tag>
                </span>
              ) : null}
            </div>
            <div className="px-engine-model">{model}</div>
          </>
        )}
      </div>
      <span className={["px-status", `is-${status}`].join(" ")}>
        <i />
        {statusText ?? statusLabels[status]}
      </span>
      <Button
        size="sm"
        variant="secondary"
        disabled={actionDisabled}
        onClick={onAction}
        aria-label={t("components.engine.actionFor", { action, name })}
      >
        {action}
      </Button>
    </div>
  );
}
