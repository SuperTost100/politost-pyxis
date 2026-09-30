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
}: {
  kind: "cli" | "api" | "local" | "remote";
  name: string;
  model: string;
  status?: "ok" | "warn" | "error" | "idle";
  statusText?: string;
  isDefault?: boolean;
}) {
  const { t } = useTranslation();
  const statusLabels = {
    ok: t("components.engine.statusOk"),
    warn: t("components.engine.statusWarn"),
    error: t("components.engine.statusError"),
    idle: t("components.engine.statusIdle"),
  };
  return (
    <div className="px-card px-engine">
      <span className="px-engine-ico">
        <Icon name={ENG_ICON[kind] ?? "cpu"} size={18} />
      </span>
      <div className="px-engine-main">
        <div className="px-engine-name">
          {name}
          {isDefault ? (
            <span style={{ marginLeft: 8 }}>
              <Tag>{t("components.engine.default")}</Tag>
            </span>
          ) : null}
        </div>
        <div className="px-engine-model">{model}</div>
      </div>
      <span className={["px-status", `is-${status}`].join(" ")}>
        <i />
        {statusText ?? statusLabels[status]}
      </span>
      <Button size="sm" variant="secondary">
        {status === "warn"
          ? t("components.engine.signIn")
          : t("components.engine.test")}
      </Button>
    </div>
  );
}
