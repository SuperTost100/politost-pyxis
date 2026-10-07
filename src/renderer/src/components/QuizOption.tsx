import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import "./QuizOption.css";

export type QuizOptionState =
  | "idle"
  | "selected"
  | "correct"
  | "wrong"
  /** The right option the student did not pick, shown after the check. */
  | "answer"
  /** Any other option after the check. */
  | "muted";

export function QuizOption({
  letter,
  children,
  state = "idle",
  shortcut,
  label,
  disabled,
  onClick,
}: {
  letter: string;
  children: ReactNode;
  state?: QuizOptionState;
  /** The number key that picks it, shown at the end of the row. */
  shortcut?: string;
  /** Accessible name when the visible text needs a plainer reading (math). */
  label?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const feedback =
    state === "correct"
      ? { icon: "circle-check" as const, word: t("components.quiz.correct") }
      : state === "wrong"
        ? { icon: "circle-x" as const, word: t("components.quiz.wrong") }
        : state === "answer"
          ? { icon: "circle-check" as const, word: t("components.quiz.answer") }
          : null;
  return (
    <button
      type="button"
      className={["px-opt", state !== "idle" && `is-${state}`]
        .filter(Boolean)
        .join(" ")}
      aria-pressed={state === "idle" || state === "selected" ? state === "selected" : undefined}
      aria-keyshortcuts={shortcut}
      aria-label={label && feedback ? `${label}, ${feedback.word}` : label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="px-opt-key" aria-hidden>
        {letter}
      </span>
      <span className="px-opt-text">{children}</span>
      {feedback ? (
        <span className="px-opt-state">
          <Icon name={feedback.icon} size={16} strokeWidth={2} />
          {feedback.word}
        </span>
      ) : shortcut ? (
        <kbd className="px-opt-shortcut" aria-hidden>
          {shortcut}
        </kbd>
      ) : null}
    </button>
  );
}
