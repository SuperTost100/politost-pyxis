import type { ReactNode } from "react";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import "./Dock.css";

export function Dock({
  eyebrow,
  title,
  reason,
  continueLabel,
  anotherLabel,
  onContinue,
  onAnother,
  children,
}: {
  eyebrow: string;
  title: string;
  reason: string;
  continueLabel: string;
  anotherLabel: string;
  onContinue?: () => void;
  onAnother?: () => void;
  children?: ReactNode;
}) {
  return (
    <aside className="px-dock" aria-label={eyebrow}>
      <p className="label px-dock-eyebrow">{eyebrow}</p>
      <h2 className="title-3 px-dock-title">{title}</h2>
      <p className="small px-dock-reason">{reason}</p>
      {children}
      <div className="px-dock-actions">
        <IconButton
          icon="refresh-cw"
          label={anotherLabel}
          variant="ghost"
          onClick={onAnother}
        />
        <Button size="lg" onClick={onContinue}>{continueLabel}</Button>
      </div>
    </aside>
  );
}
