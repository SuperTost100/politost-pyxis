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
  severitySevereLabel = "grave",
  severityMinorLabel = "lieve",
}: {
  severity?: "severe" | "minor";
  topic: string;
  children: ReactNode;
  onFill?: () => void;
  fillLabel?: string;
  severitySevereLabel?: string;
  severityMinorLabel?: string;
}) {
  return (
    <div className="px-card px-gap">
      <span className={["px-gap-dot", `is-${severity}`].join(" ")} />
      <div className="px-gap-body">
        <Tag
          tone={severity === "severe" ? "severe" : "general"}
          icon="target"
        >
          {severity === "severe" ? severitySevereLabel : severityMinorLabel}
        </Tag>
        <p className="px-gap-text">{children}</p>
        <span className="px-gap-topic">{topic}</span>
      </div>
      {onFill ? (
        <Button size="sm" variant="secondary" onClick={onFill}>
          {fillLabel}
        </Button>
      ) : null}
    </div>
  );
}
