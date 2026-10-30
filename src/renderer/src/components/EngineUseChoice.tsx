import { Button, Radio } from "antd";
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
  keys,
  onRetryKeys,
}: {
  allowed: string[] | null;
  rows: ReadonlyArray<EngineState & { id: string }>;
  onChange: (allowed: string[] | null) => void;
  disabled?: boolean;
  /** Whether the saved API keys are read (see `manualChoice`). "I choose" waits for them. */
  keys: "loading" | "failed" | "ready";
  onRetryKeys: () => void;
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
          event.target.value === "auto"
            ? onChange(null)
            : keys === "ready" && start.length
              ? onChange(start)
              : undefined
        }
      >
        <Radio value="auto">
          <span className="body-strong">{t("engines.choice.auto")}</span>
          <span className="small px-engine-choice-hint">
            {t("engines.choice.autoHint")}
          </span>
        </Radio>
        <Radio
          value="chosen"
          disabled={disabled || keys !== "ready" || start.length === 0}
        >
          <span className="body-strong">{t("engines.choice.chosen")}</span>
          <span className="small px-engine-choice-hint">
            {t("engines.choice.chosenHint")}
          </span>
        </Radio>
      </Radio.Group>
      {/* Until the saved keys are read, a pick would leave the keyed API engines out, so it waits or offers a retry. */}
      {keys === "loading" ? (
        <p className="small px-engine-choice-hint" role="status">
          {t("engines.choice.keysLoading")}
        </p>
      ) : keys === "failed" ? (
        <div className="px-engine-choice-retry" role="alert">
          <span className="small">{t("engines.choice.keysFailed")}</span>
          <Button size="small" shape="round" onClick={onRetryKeys}>
            {t("engines.choice.keysRetry")}
          </Button>
        </div>
      ) : null}
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
