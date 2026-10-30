import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { spokenText } from "@shared/spoken-math";
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
  math,
  disabled,
  onClick,
}: {
  letter: string;
  children: ReactNode;
  state?: QuizOptionState;
  /** The number key that picks it, shown at the end of the row. */
  shortcut?: string;
  /**
   * The option's Markdown. A screen reader gets nothing from KaTeX inside a button, so an option with `$` math is named
   * from this text, formulas spoken as signs and words.
   */
  math?: string;
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
  const answer = math?.includes("$") ? spokenText(math) : undefined;
  return (
    <button
      type="button"
      className={["px-opt", state !== "idle" && `is-${state}`]
        .filter(Boolean)
        .join(" ")}
      aria-pressed={state === "idle" || state === "selected" ? state === "selected" : undefined}
      aria-keyshortcuts={state === "muted" ? undefined : shortcut}
      aria-label={
        answer === undefined ? undefined : [letter, answer, feedback?.word].filter(Boolean).join(" ")
      }
      disabled={disabled}
      onClick={onClick}
    >
      {/*
        The letter, the answer and the result name the button, in the order they are drawn (WCAG 2.5.3). The spaces
        between them draw nothing in a grid; they keep "A" and "F=ma" two words for a check of the visible text.
      */}
      <span className="px-opt-key">{letter}</span>{" "}
      <span className="px-opt-text">{children}</span>{" "}
      {feedback ? (
        <span className="px-opt-state">
          <Icon name={feedback.icon} size={16} strokeWidth={2} />
          {feedback.word}
        </span>
      ) : shortcut && state !== "muted" ? (
        // The key hint is drawn from data-key, so it is not text: aria-keyshortcuts already tells a screen reader.
        <kbd className="px-opt-shortcut" aria-hidden data-key={shortcut} />
      ) : null}
    </button>
  );
}
