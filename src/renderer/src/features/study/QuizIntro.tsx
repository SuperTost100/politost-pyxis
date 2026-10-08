import { Button } from "antd";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/Icon";

/** The calm first screen of a quiz: what it is for, what to expect, and Start. */
export function QuizIntro({
  eyebrow,
  title,
  sentence,
  count,
  minutes,
  answered = 0,
  starting,
  disabled,
  options,
  onStart,
  onClose,
}: {
  eyebrow: string;
  title: string;
  sentence: string;
  count?: number;
  minutes?: number;
  answered?: number;
  starting: boolean;
  disabled?: boolean;
  /** Settings a student may change before starting, folded away by default. */
  options?: ReactNode;
  onStart: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <section className="px-quiz-intro" aria-labelledby={`${panel}-title`}>
      <p className="label px-quiz-eyebrow">{eyebrow}</p>
      <h2 id={`${panel}-title`} className="display px-quiz-intro-title">
        {title}
      </h2>
      <p className="reading px-quiz-intro-text">{sentence}</p>
      <ul className="px-quiz-facts">
        {count ? (
          <li>
            <Icon name="list-checks" size={16} />
            {answered
              ? t("quiz.factAnswered", { answered, total: count })
              : t("quiz.factQuestions", { count })}
          </li>
        ) : null}
        {minutes ? (
          <li>
            <Icon name="clock" size={16} />
            {t("quiz.factMinutes", { count: minutes })}
          </li>
        ) : null}
        <li>
          <Icon name="circle-check" size={16} />
          {t("quiz.factFeedback")}
        </li>
      </ul>
      {options ? (
        <div className="px-quiz-options">
          <button
            type="button"
            className="px-quiz-options-toggle"
            aria-expanded={open}
            aria-controls={panel}
            onClick={() => setOpen((value) => !value)}
          >
            {t("quiz.options")}
            <Icon name="chevron-right" size={16} className="px-quiz-chevron" />
          </button>
          {open ? (
            <div id={panel} className="px-quiz-options-panel">
              {options}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="px-quiz-intro-actions">
        <Button shape="round" size="large" onClick={onClose}>
          {t("nav.close")}
        </Button>
        <Button
          type="primary"
          shape="round"
          size="large"
          loading={starting}
          disabled={disabled}
          onClick={onStart}
        >
          {t(answered ? "quiz.continueAttempt" : "quiz.start")}
        </Button>
      </div>
      {starting ? (
        <p className="small px-quiz-intro-status" role="status">
          {t("quiz.preparing")}
        </p>
      ) : null}
    </section>
  );
}
