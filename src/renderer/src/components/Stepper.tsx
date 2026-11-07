import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./Stepper.css";

/**
 * Where the student is in a short flow of named steps: first setup and the new plan wizard. Past steps and the
 * current one are filled, the current label is bold, and the labels of the other steps drop out on a narrow window.
 * The position is spoken ("Step 2 of 4: Engines") by the current item instead of being printed again on screen.
 */
export function Stepper({
  steps,
  current,
  numbered = false,
}: {
  steps: string[];
  /** Zero-based index of the current step. */
  current: number;
  /**
   * First setup's short form: a fixed width per step, the number before the steps to come ("2 · L'AI") and a tick
   * before the ones done. The number is for the eye; screen readers hear the position of the current step.
   */
  numbered?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ol
      className={numbered ? "px-stepper is-numbered" : "px-stepper"}
      aria-label={t("stepper.label")}
    >
      {steps.map((step, index) => {
        const state =
          index < current ? "done" : index === current ? "current" : "next";
        return (
          <li
            key={index}
            className={`px-stepper-item is-${state}`}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="px-stepper-bar" aria-hidden />
            <span className="small px-stepper-label">
              {state === "current" ? (
                <span className="visually-hidden">
                  {t("stepper.position", {
                    current: current + 1,
                    total: steps.length,
                  })}
                  {": "}
                </span>
              ) : null}
              {numbered && state === "done" ? (
                <Check size={14} strokeWidth={2.5} aria-hidden />
              ) : null}
              {numbered && state !== "done" ? (
                <span aria-hidden>{`${index + 1} · `}</span>
              ) : null}
              {step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
