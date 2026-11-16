import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { answerReading } from "@shared/math-words";
import { MathInput } from "../../components/MathInput";

/** What the contract takes of one field of a draft; a longer text is refused as it is typed, so a draft always saves. */
const FIELD_MAX = 20_000;

/** `value` once it has stayed the same for `delay` ms. */
function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * A quiz's open answer: the answer, a line that reads its formulas back in words so the student sees how they were
 * understood, and an optional field for the steps that led to the answer, which the grader reads with it.
 */
export function OpenAnswer({
  answer,
  steps,
  disabled,
  onAnswer,
  onSteps,
}: {
  answer: string;
  steps: string;
  disabled: boolean;
  onAnswer: (value: string) => void;
  onSteps: (value: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.language.startsWith("it") ? "it" : "en";
  const reading = useMemo(() => answerReading(answer, language), [answer, language]);
  // A screen reader hears the reading once the typing pauses, not at every key. A question opened with its answer
  // already written says nothing: the region changes only when the answer does.
  const spoken = useSettled(reading, 800);
  // The line closes over its last words, so it folds away instead of going blank first.
  const shown = useRef(reading);
  if (reading) shown.current = reading;
  return (
    <div className="px-quiz-open">
      <div className="px-quiz-open-part">
        {/* The field carries the same words as its name. */}
        <span className="label" aria-hidden="true">
          {t("quiz.yourAnswer")}
        </span>
        <MathInput
          ariaLabel={t("quiz.yourAnswer")}
          formulaLabel={t("quiz.formulaInAnswer")}
          keysGroup="quiz-open"
          rows={4}
          maxLength={FIELD_MAX}
          disabled={disabled}
          value={answer}
          onChange={onAnswer}
          note={
            <div className={`px-quiz-reads${reading ? " is-shown" : ""}`} aria-hidden="true">
              <p>
                <span>{t("quiz.reads")}</span>
                {shown.current}
              </p>
            </div>
          }
        />
        <span className="visually-hidden" role="status">
          {spoken ? t("quiz.readsSpoken", { text: spoken }) : ""}
        </span>
      </div>
      <div className="px-quiz-open-part">
        <span className="label" aria-hidden="true">
          {t("quiz.steps")}
        </span>
        <MathInput
          ariaLabel={t("quiz.steps")}
          formulaLabel={t("quiz.formulaInSteps")}
          keysGroup="quiz-open"
          rows={3}
          maxLength={FIELD_MAX}
          disabled={disabled}
          value={steps}
          onChange={onSteps}
        />
      </div>
    </div>
  );
}
