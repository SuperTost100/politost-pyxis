import { Button as AntButton } from "antd";
import { Icon, type IconName } from "./Icon";
import "./Button.css";

export function IconButton({
  icon,
  label,
  variant = "secondary",
  size = "md",
  onClick,
  disabled,
  pressed,
}: {
  icon: IconName;
  label: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  onClick?: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  const antType =
    variant === "primary"
      ? "primary"
      : variant === "ghost"
        ? "text"
        : "default";
  return (
    <AntButton
      type={antType}
      danger={variant === "danger"}
      shape="circle"
      size={size === "sm" ? "small" : "middle"}
      className={[
        "px-btn",
        `px-btn-${variant}`,
        "px-iconbtn",
        size === "sm" && "px-btn-sm",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      disabled={disabled}
      icon={<Icon name={icon} size={size === "sm" ? 16 : 18} />}
    />
  );
}
