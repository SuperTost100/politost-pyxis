import { Tag as AntTag } from "antd";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import "./Tag.css";

const TAG_ICON: Partial<Record<string, IconName>> = {
  smartbook: "book-marked",
  general: "circle-alert",
  mastered: "circle-check",
  severe: "circle-x",
};

export function Tag({
  tone = "neutral",
  icon,
  children,
}: {
  tone?:
    | "neutral"
    | "smartbook"
    | "general"
    | "mastered"
    | "severe"
    | "recommended";
  icon?: IconName;
  children: ReactNode;
}) {
  const iconName = icon || TAG_ICON[tone];
  return (
    <AntTag bordered={false} className={["px-tag", `px-tag-${tone}`].join(" ")}>
      {iconName && tone !== "recommended" ? (
        <Icon name={iconName} size={12} strokeWidth={2} />
      ) : null}
      {children}
    </AntTag>
  );
}
