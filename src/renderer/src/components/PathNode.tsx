import { useTranslation } from "react-i18next";
import type { IconName } from "./Icon";
import { Icon } from "./Icon";
import "./PathNode.css";

export function PathNode({
  icon,
  label,
  detail,
  meta,
  state = "available",
  ariaLabel,
  onClick,
}: {
  icon: IconName;
  label?: string;
  /** A second line under the label, such as the topic. */
  detail?: string;
  /** A short result under the label, such as "8/10". */
  meta?: string;
  state?: "done" | "current" | "available" | "planned";
  ariaLabel?: string;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const stateLabel =
    state === "done" || state === "current"
      ? ` (${t(`components.path.state.${state}`)})`
      : "";
  return (
    <div className={["px-node-wrap", `is-${state}`].join(" ")}>
      <button
        type="button"
        className={["px-node", `is-${state}`].join(" ")}
        aria-label={
          ariaLabel ?? [label, detail, meta].filter(Boolean).join(", ") + stateLabel
        }
        onClick={onClick}
        data-path-box
      >
        <Icon name={icon} size={32} strokeWidth={1.5} />
      </button>
      {label || detail || meta ? (
        <div className="px-node-label" aria-hidden>
          {label ? <span className="px-node-title">{label}</span> : null}
          {detail ? <span className="px-node-detail">{detail}</span> : null}
          {meta ? <span className="px-node-meta">{meta}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
