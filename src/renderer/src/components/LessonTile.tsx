import type { IconName } from "./Icon";
import { Icon } from "./Icon";
import { Tag } from "./Tag";
import "./LessonTile.css";

export function LessonTile({
  icon,
  label,
  recommended,
  recommendedLabel = "Consigliato",
  count,
  onClick,
}: {
  icon: IconName;
  label: string;
  recommended?: boolean;
  recommendedLabel?: string;
  count?: number;
  onClick?: () => void;
}) {
  return (
    <button type="button" className="px-ltile" onClick={onClick}>
      {recommended ? (
        <Tag tone="recommended">{recommendedLabel}</Tag>
      ) : null}
      {count ? (
        <span className="px-ltile-count" aria-label={`${count}`}>{count}</span>
      ) : null}
      <span className="px-ltile-ico">
        <Icon name={icon} size={20} />
      </span>
      {label}
    </button>
  );
}
