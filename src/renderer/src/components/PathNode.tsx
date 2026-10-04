import { useTranslation } from "react-i18next";
import type { IconName } from "./Icon";
import { Icon } from "./Icon";
import "./PathNode.css";

export function PathNode({
  icon,
  label,
  state = "available",
  unlockHint,
  inspectable = false,
  onClick,
}: {
  icon: IconName;
  label?: string;
  state?: "done" | "current" | "available" | "locked";
  unlockHint?: string;
  inspectable?: boolean;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const stateKey =
    state === "locked" || state === "done" || state === "current"
      ? `components.path.state.${state}`
      : "";
  const stateLabel = stateKey ? ` (${t(stateKey)})` : "";
  return (
    <div className="px-node-wrap">
      <button
        type="button"
        className={["px-node", `is-${state}`].join(" ")}
        disabled={state === "locked" && !inspectable}
        aria-label={(label ?? "") + stateLabel}
        title={state === "locked" ? unlockHint : undefined}
        onClick={onClick}
      >
        <Icon
          name={state === "locked" ? "lock" : icon}
          size={32}
          strokeWidth={1.5}
        />
      </button>
      {label ? <div className="px-node-label">{label}</div> : null}
    </div>
  );
}
