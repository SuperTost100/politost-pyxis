import { Button } from "antd";
import { CircleX, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

const tones = {
  info: { icon: Info, bg: "var(--primary-soft)", fg: "var(--primary-text)" },
  warning: {
    icon: TriangleAlert,
    bg: "var(--star-soft)",
    fg: "var(--star-text)",
  },
  danger: { icon: CircleX, bg: "var(--danger-soft)", fg: "var(--danger)" },
} as const;

export function Notice({
  tone,
  children,
  action,
}: {
  tone: keyof typeof tones;
  children: ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  const Icon = tones[tone].icon;
  return (
    <div
      className="notice"
      style={{ background: tones[tone].bg, color: tones[tone].fg }}
      role="status"
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden />
      <p>{children}</p>
      {action ? (
        <Button type="text" size="small" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
