import { Button } from "antd";
import { Children, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "../../components/Icon";
import "./ActivityIntro.css";

export type ActivityFact = { icon: IconName; label: string };

/**
 * The first screen of a quiz, a review, a simulation and the diagnostic, laid out the same way: eyebrow, title, one
 * sentence, a row of facts, the options, then Back and the one primary action. The focus bar's X stays the exit.
 */
export function ActivityIntro({
  eyebrow,
  title,
  sentence,
  facts,
  options,
  folded = false,
  children,
  startLabel,
  starting = false,
  startingLabel,
  disabled,
  onStart,
  onBack,
}: {
  eyebrow: string;
  title: string;
  sentence?: string;
  facts: ActivityFact[];
  /** Choices made before starting: ActivityChoice rows, fields, toggles. */
  options?: ReactNode;
  /** Fold the options behind "Customize" when the defaults suit most students. */
  folded?: boolean;
  /** State that belongs to the start: notices, a session to resume, questions being written. */
  children?: ReactNode;
  startLabel: string;
  starting?: boolean;
  /** Said under the actions while starting. */
  startingLabel?: string;
  disabled?: boolean;
  onStart: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!folded);
  const id = useId();
  return (
    <section className="px-intro" aria-labelledby={`${id}-title`}>
      <p className="label px-intro-eyebrow">{eyebrow}</p>
      <h2 id={`${id}-title`} className="display px-intro-title">
        {title}
      </h2>
      {sentence ? <p className="reading px-intro-text">{sentence}</p> : null}
      {facts.length ? (
        <ul className="px-intro-facts">
          {facts.map((fact) => (
            <li key={fact.label}>
              <Icon name={fact.icon} size={16} />
              {fact.label}
            </li>
          ))}
        </ul>
      ) : null}
      {options ? (
        <div className="px-intro-options">
          {folded ? (
            <button
              type="button"
              className="px-intro-options-toggle"
              aria-expanded={open}
              aria-controls={`${id}-options`}
              onClick={() => setOpen((value) => !value)}
            >
              {t("quiz.options")}
              <Icon name="chevron-right" size={16} className="px-intro-chevron" />
            </button>
          ) : null}
          {open ? (
            <div id={`${id}-options`} className="px-intro-options-panel">
              {options}
            </div>
          ) : null}
        </div>
      ) : null}
      {Children.toArray(children).length ? <div className="px-intro-state">{children}</div> : null}
      <div className="px-intro-actions">
        <Button shape="round" size="large" onClick={onBack}>
          {t("nav.back")}
        </Button>
        <Button
          type="primary"
          shape="round"
          size="large"
          loading={starting}
          disabled={disabled}
          onClick={onStart}
        >
          {startLabel}
        </Button>
      </div>
      {starting && startingLabel ? (
        <p className="small px-intro-starting" role="status">
          {startingLabel}
        </p>
      ) : null}
    </section>
  );
}

/** One choice among a few, as a row of pills under its label: a duration, a question count, a scope. */
export function ActivityChoice<T extends string | number>({
  label,
  value,
  choices,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  choices: Array<{ value: T; label: string }>;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="px-intro-field">
      <legend className="body-strong">{label}</legend>
      <div className="px-intro-pills">
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className={choice.value === value ? "choice is-selected" : "choice"}
            aria-pressed={choice.value === value}
            disabled={disabled}
            onClick={() => onChange(choice.value)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
