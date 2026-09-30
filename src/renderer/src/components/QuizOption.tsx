import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import "./QuizOption.css";

export function QuizOption({
  letter,
  children,
  state = "idle",
  onClick,
}: {
  letter: string;
  children: ReactNode;
  state?: "idle" | "selected" | "correct" | "wrong";
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const feedback =
    state === "correct"
      ? { icon: "circle-check" as const, word: t("components.quiz.correct") }
      : state === "wrong"
        ? { icon: "circle-x" as const, word: t("components.quiz.wrong") }
        : null;
  return (
    <button
      type="button"
      className={["px-opt", state !== "idle" && `is-${state}`]
        .filter(Boolean)
        .join(" ")}
      aria-pressed={state === "selected"}
      onClick={onClick}
    >
      <span className="px-opt-key">{letter}</span>
      <span className="px-opt-text">{children}</span>
      {feedback ? (
        <span className="px-opt-state">
          <Icon name={feedback.icon} size={16} strokeWidth={2} />
          {feedback.word}
        </span>
      ) : null}
    </button>
  );
}
