import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import "./Chip.css";

export function Chip({
  children,
  icon,
  onClick,
}: {
  children: ReactNode;
  icon?: IconName;
  onClick?: () => void;
}) {
  return (
    <button type="button" className="px-chip" onClick={onClick}>
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}
