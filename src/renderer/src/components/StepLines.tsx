import { Icon } from "./Icon";
import { Logo } from "./Logo";
import type { IconName } from "./Icon";
import "./StepLines.css";

export type StepLineState = "pending" | "running" | "done" | "failed";

export type StepLine = {
  id: string;
  label: string;
  state: StepLineState;
  meta?: string;
};

// A running step shows the working mark (Logo) in place of an icon.
const STATE_ICON: Record<Exclude<StepLineState, "running">, { name: IconName; className?: string }> = {
  pending: { name: "circle" },
  done: { name: "circle-check", className: "is-done" },
  failed: { name: "circle-x", className: "is-failed" },
};

export function StepLines({
  steps,
  label,
}: {
  steps: StepLine[];
  label?: string;
}) {
  return (
    <ol className="px-steplines" aria-label={label}>
      {steps.map((step) => {
        const icon = step.state === "running" ? null : STATE_ICON[step.state];
        return (
          <li key={step.id} className={["px-stepline", `is-${step.state}`].join(" ")}>
            <span
              className={["px-stepline-icon", icon?.className]
                .filter(Boolean)
                .join(" ")}
              aria-hidden
            >
              {icon ? <Icon name={icon.name} size={18} /> : <Logo working decorative size={18} />}
            </span>
            <span className="px-stepline-label">{step.label}</span>
            {step.meta ? (
              <span className="meta px-stepline-meta">{step.meta}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
