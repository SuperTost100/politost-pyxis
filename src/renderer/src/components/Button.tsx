import { Button as AntButton } from "antd";
import type { MouseEvent, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import "./Button.css";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export function Button({
  "aria-label": ariaLabel,
  variant = "primary",
  size = "md",
  icon,
  block,
  className,
  children,
  disabled,
  expanded,
  onClick,
  type = "button",
}: {
  "aria-label"?: string;
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  block?: boolean;
  className?: string;
  children?: ReactNode;
  disabled?: boolean;
  /** For a button that opens a panel: whether the panel it opened is open now. */
  expanded?: boolean;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  type?: "button" | "submit" | "reset";
}) {
  const antType =
    variant === "primary"
      ? "primary"
      : variant === "ghost"
        ? "text"
        : "default";
  const antSize = size === "sm" ? "small" : size === "lg" ? "large" : "middle";
  return (
    <AntButton
      aria-label={ariaLabel}
      aria-expanded={expanded}
      htmlType={type}
      type={antType}
      danger={variant === "danger"}
      shape="round"
      size={antSize}
      block={block}
      disabled={disabled}
      onClick={onClick}
      className={[
        "px-btn",
        `px-btn-${variant}`,
        size !== "md" && `px-btn-${size}`,
        block && "px-btn-block",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      icon={
        icon ? <Icon name={icon} size={size === "sm" ? 16 : 18} /> : undefined
      }
    >
      {children}
    </AntButton>
  );
}
