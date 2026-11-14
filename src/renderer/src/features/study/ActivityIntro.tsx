import { Button } from "antd";
import { Children, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Segmented } from "../../components/Controls";
import { Icon, type IconName } from "../../components/Icon";
import "./ActivityIntro.css";

export type ActivityFact = { icon: IconName; label: string };

/**
 * The first screen of a quiz, a review, a simulation and the diagnostic, laid out the same way: eyebrow, title, one
 * sentence, a row of facts, the options, then the one primary action. The way out is the study bar's back control.
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
              <span className="px-chevron" aria-hidden />
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

/** More options than this do not sit side by side: the choice becomes a native select in the same row. */
const MAX_SEGMENTS = 3;

/**
 * One choice among a few, in a row with its label: a duration, a question count, a scope. Up to three options are a
 * `Segmented` (one tab stop, arrows move the choice); more are a native `select`, because a growing list of durations
 * would not fit side by side at 960 px with large text.
 */
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
  const id = useId();
  // The controls speak in strings; the page keeps its own type, as numbers for a count or a length.
  const change = (key: string) => {
    const next = choices.find((choice) => String(choice.value) === key);
    if (next) onChange(next.value);
  };
  return (
    <div className="px-intro-field">
      <span id={id} className="body-strong px-intro-field-label">
        {label}
      </span>
      {choices.length > MAX_SEGMENTS ? (
        <select
          className="px-ctl-field px-intro-select"
          aria-labelledby={id}
          value={String(value)}
          disabled={disabled}
          onChange={(event) => change(event.target.value)}
        >
          {choices.map((choice) => (
            <option key={choice.value} value={String(choice.value)}>
              {choice.label}
            </option>
          ))}
        </select>
      ) : (
        <Segmented
          label={id}
          value={String(value)}
          disabled={disabled}
          options={choices.map((choice) => ({ value: String(choice.value), label: choice.label }))}
          onChange={change}
        />
      )}
    </div>
  );
}
