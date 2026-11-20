import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import "./Chip.css";

/** A chip that does something is a button. One with nothing to do, such as a photo a message carried, is plain text. */
export function Chip({
  children,
  icon,
  onClick,
}: {
  children: ReactNode;
  icon?: IconName;
  onClick?: () => void;
}) {
  const content = (
    <>
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </>
  );
  return onClick ? (
    <button type="button" className="px-chip" onClick={onClick}>
      {content}
    </button>
  ) : (
    <span className="px-chip is-plain">{content}</span>
  );
}
