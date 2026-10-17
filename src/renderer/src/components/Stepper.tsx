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
}: {
  steps: string[];
  /** Zero-based index of the current step. */
  current: number;
}) {
  const { t } = useTranslation();
  return (
    <ol className="px-stepper" aria-label={t("stepper.label")}>
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
              {step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
