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
  iconEnd,
  block,
  className,
  children,
  disabled,
  expanded,
  hasPopup,
  controls,
  pressed,
  keyShortcuts,
  title,
  onClick,
  type = "button",
}: {
  "aria-label"?: string;
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  /** An icon after the label, such as the chevron of Avanti. */
  iconEnd?: IconName;
  block?: boolean;
  className?: string;
  children?: ReactNode;
  disabled?: boolean;
  /** For a button that opens a panel: whether the panel it opened is open now. */
  expanded?: boolean;
  /** For a button that opens a menu or a popover: what it opens (`aria-haspopup`). */
  hasPopup?: "menu" | "dialog";
  /** The element the button opens, while it is open (`aria-controls`). */
  controls?: string;
  /** For a button that toggles a state, such as "Segna per dopo": whether it is on. */
  pressed?: boolean;
  /** The key that presses it, for assistive technology (`aria-keyshortcuts`). */
  keyShortcuts?: string;
  title?: string;
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
      aria-haspopup={hasPopup}
      aria-controls={controls}
      aria-pressed={pressed}
      aria-keyshortcuts={keyShortcuts}
      title={title}
      htmlType={type}
      type={antType}
      danger={variant === "danger"}
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
        icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : undefined
      }
    >
      {children}
      {iconEnd ? <Icon name={iconEnd} size={size === "sm" ? 14 : 16} /> : null}
    </AntButton>
  );
}
