import type { IconName } from "./Icon";
import { Icon } from "./Icon";
import "./PathNode.css";

export function PathNode({
  icon,
  label,
  state = "available",
  unlockHint,
  onClick,
}: {
  icon: IconName;
  label?: string;
  state?: "done" | "current" | "available" | "locked";
  unlockHint?: string;
  onClick?: () => void;
}) {
  const stateLabel =
    state === "locked"
      ? " (bloccato)"
      : state === "done"
        ? " (completato)"
        : state === "current"
          ? " (attuale)"
          : "";
  return (
    <div className="px-node-wrap">
      <button
        type="button"
        className={["px-node", `is-${state}`].join(" ")}
        disabled={state === "locked"}
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
