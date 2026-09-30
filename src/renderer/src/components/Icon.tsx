import { ICON_MAP, type IconName } from "./iconMap";
import "./Icon.css";

export type { IconName };

export function Icon({
  name,
  size = 20,
  strokeWidth = 1.75,
  label,
  className,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  label?: string;
  className?: string;
}) {
  const Lucide = ICON_MAP[name];
  return (
    <Lucide
      className={["px-icon", className].filter(Boolean).join(" ")}
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    />
  );
}
