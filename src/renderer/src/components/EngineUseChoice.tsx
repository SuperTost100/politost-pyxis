import { Radio } from "antd";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { chosenStart, type EngineState } from "../lib/engineStatus";
import "./EngineUseChoice.css";

/**
 * Automatic (every engine that is ready, now or later) or the engines the student ticks. `rows` are every engine the
 * student can tick (see `choiceRows`), API providers included. Picking "I choose" starts from the engines that are
 * ready, or the installed ones when none is, so nothing changes until a box is unticked.
 */
export function EngineUseChoice({
  allowed,
  rows,
  onChange,
  disabled,
}: {
  allowed: string[] | null;
  rows: ReadonlyArray<EngineState & { id: string }>;
  onChange: (allowed: string[] | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const legend = useId();
  const start = chosenStart(rows);
  return (
    <div className="px-engine-choice">
      <h2 className="title-3" id={legend}>
        {t("engines.choice.title")}
      </h2>
      <Radio.Group
        className="px-engine-choice-options"
        value={allowed === null ? "auto" : "chosen"}
        disabled={disabled}
        aria-labelledby={legend}
        onChange={(event) =>
          onChange(event.target.value === "auto" ? null : start)
        }
      >
        <Radio value="auto">
          <span className="body-strong">{t("engines.choice.auto")}</span>
          <span className="small px-engine-choice-hint">
            {t("engines.choice.autoHint")}
          </span>
        </Radio>
        <Radio value="chosen" disabled={disabled || start.length === 0}>
          <span className="body-strong">{t("engines.choice.chosen")}</span>
          <span className="small px-engine-choice-hint">
            {t("engines.choice.chosenHint")}
          </span>
        </Radio>
      </Radio.Group>
    </div>
  );
}

/**
 * The checkbox of one engine row while the student picks engines. The last ticked engine cannot be unticked, so Pyxis
 * always has one to use.
 */
export function engineBox(
  allowed: string[] | null,
  id: string,
  onChange: (allowed: string[] | null) => void,
  disabled?: boolean,
) {
  if (allowed === null) return undefined;
  const checked = allowed.includes(id);
  return {
    checked,
    disabled: disabled || (checked && allowed.length === 1),
    onChange: (next: boolean) =>
      onChange(
        next
          ? [...allowed, id]
          : allowed.filter((other) => other !== id),
      ),
  };
}
