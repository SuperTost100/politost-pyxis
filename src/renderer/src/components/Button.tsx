import { Button as AntButton } from "antd";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import "./Button.css";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export function Button({
  variant = "primary",
  size = "md",
  icon,
  block,
  className,
  children,
  disabled,
  onClick,
  type = "button",
}: {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  block?: boolean;
  className?: string;
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
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
        icon ? (
          <Icon name={icon} size={size === "sm" ? 16 : 18} />
        ) : undefined
      }
    >
      {children}
    </AntButton>
  );
}
