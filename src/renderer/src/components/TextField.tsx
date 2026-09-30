import { Input } from "antd";
import type { ChangeEventHandler } from "react";
import { Icon, type IconName } from "./Icon";
import "./TextField.css";

export function TextField({
  placeholder,
  value,
  defaultValue,
  onChange,
  icon,
  size = "md",
  label,
  type = "text",
}: {
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  icon?: IconName;
  size?: "md" | "lg";
  label?: string;
  type?: string;
}) {
  return (
    <label
      className={["px-field", size === "lg" && "px-field-lg"]
        .filter(Boolean)
        .join(" ")}
    >
      {icon ? <Icon name={icon} size={18} /> : null}
      <Input
        variant="borderless"
        placeholder={placeholder}
        value={value}
        defaultValue={defaultValue}
        onChange={onChange}
        aria-label={label || placeholder}
        type={type}
      />
    </label>
  );
}
