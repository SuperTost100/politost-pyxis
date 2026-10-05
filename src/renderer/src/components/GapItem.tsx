import type { ReactNode } from "react";
import { Button } from "./Button";
import { Tag } from "./Tag";
import "./GapItem.css";

export function GapItem({
  severity = "minor",
  topic,
  children,
  onFill,
  fillLabel = "Colma",
  fillDisabled = false,
  fillName,
  severitySevereLabel = "grave",
  severityMinorLabel = "lieve",
}: {
  severity?: "severe" | "minor";
  topic: string;
  children: ReactNode;
  onFill?: () => void;
  fillLabel?: string;
  fillDisabled?: boolean;
  /** What the fill button is named after, when the topic alone does not say which gap it is. */
  fillName?: string;
  severitySevereLabel?: string;
  severityMinorLabel?: string;
}) {
  return (
    <div className="px-card px-gap">
      <span className={["px-gap-dot", `is-${severity}`].join(" ")} />
      <div className="px-gap-body">
        <Tag tone={severity === "severe" ? "severe" : "general"} icon="target">
          {severity === "severe" ? severitySevereLabel : severityMinorLabel}
        </Tag>
        <p className="px-gap-text">{children}</p>
        <span className="px-gap-topic">{topic}</span>
      </div>
      {onFill ? (
        <Button
          aria-label={`${fillLabel} · ${fillName ?? topic}`}
          size="sm"
          variant="secondary"
          onClick={onFill}
          disabled={fillDisabled}
        >
          {fillLabel}
        </Button>
      ) : null}
    </div>
  );
}
