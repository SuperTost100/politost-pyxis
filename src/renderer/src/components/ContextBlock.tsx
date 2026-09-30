import type { ReactNode } from "react";
import { IconButton } from "./IconButton";
import type { IconName } from "./Icon";
import { Icon } from "./Icon";
import "./ContextBlock.css";

export function ContextBlock({
  icon = "quote",
  excerpt,
  removeLabel,
  onRemove,
}: {
  icon?: IconName;
  excerpt: ReactNode;
  removeLabel: string;
  onRemove?: () => void;
}) {
  return (
    <div className="px-context-block">
      <span className="px-context-icon" aria-hidden>
        <Icon name={icon} size={18} />
      </span>
      <div className="px-context-excerpt">{excerpt}</div>
      <IconButton
        icon="x"
        label={removeLabel}
        variant="ghost"
        size="sm"
        onClick={onRemove}
      />
    </div>
  );
}
