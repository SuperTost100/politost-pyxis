import { IconButton } from "./IconButton";
import type { IconName } from "./Icon";
import "./FocusBar.css";

export type FocusBarAction = {
  icon: IconName;
  label: string;
  onClick?: () => void;
};

export function FocusBar({
  mode = "close",
  closeLabel,
  backLabel,
  onClose,
  title,
  meta,
  actions = [],
  progress,
}: {
  mode?: "close" | "back";
  closeLabel: string;
  backLabel: string;
  onClose?: () => void;
  title: string;
  meta?: string;
  actions?: FocusBarAction[];
  progress?: number;
}) {
  return (
    <header className="px-focusbar">
      <IconButton
        icon={mode === "back" ? "arrow-left" : "x"}
        label={mode === "back" ? backLabel : closeLabel}
        variant="ghost"
        size="sm"
        onClick={onClose}
      />
      <div className="px-focusbar-center">
        <h1 className="title-3 px-focusbar-title">{title}</h1>
        {meta ? <p className="meta px-focusbar-meta">{meta}</p> : null}
      </div>
      <div className="px-focusbar-actions">
        {actions.slice(0, 3).map((a) => (
          <IconButton
            key={a.label}
            icon={a.icon}
            label={a.label}
            variant="ghost"
            size="sm"
            onClick={a.onClick}
          />
        ))}
      </div>
      {progress != null ? (
        <div
          className="px-focusbar-progress"
          style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
        />
      ) : null}
    </header>
  );
}
