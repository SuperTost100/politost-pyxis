import { Minus, Plus } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import "./Controls.css";

/*
 * The settings controls, one look per kind (pyxis-mockups app/index.html, "s-settings-studio"): one choice of several is
 * radio rows, on or off is a switch row, a few sizes are a segmented control, and a number is a stepper. Rows sit in a
 * white list card.
 */

/** A white card of rows. */
export function ControlList({ children, ...rest }: { children: ReactNode } & React.HTMLAttributes<HTMLUListElement>) {
  return (
    <ul className="px-ctl" {...rest}>
      {children}
    </ul>
  );
}

/** A row's name and the line under it. */
function RowText({ id, title, description }: { id?: string; title: ReactNode; description?: ReactNode }) {
  return (
    <div className="px-ctl-text">
      <span className="px-ctl-title" id={id}>
        {title}
      </span>
      {description ? (
        <span className="px-ctl-description" id={id ? `${id}-description` : undefined}>
          {description}
        </span>
      ) : null}
    </div>
  );
}

/** One choice of several, each a row with a radio dot, its name and a line on what it does. */
export function RadioRows<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** The id of the heading that names the group. */
  label: string;
  value: T;
  options: Array<{ value: T; title: ReactNode; description?: ReactNode }>;
  /** May return the save; once it settles, the row shows the stored value again, so a failed save doesn't stay picked. */
  onChange: (value: T) => void | Promise<unknown>;
}) {
  const name = useId();
  // A pick shows at once, while the setting it changes catches up (a theme or a language applies a moment later).
  const [picked, setPicked] = useState<{ from: T; to: T } | null>(null);
  const shown = picked && picked.from === value ? picked.to : value;
  return (
    // A radio group, not a list: its rows are plain blocks, so the group's role doesn't leave list items without a list.
    <div className="px-ctl" role="radiogroup" aria-labelledby={label}>
      {options.map((option) => (
        <div key={option.value} className="px-ctl-item">
          <label className="px-ctl-row is-choice">
            <input
              type="radio"
              name={name}
              checked={shown === option.value}
              onChange={() => {
                const pick = { from: value, to: option.value };
                setPicked(pick);
                void Promise.resolve(onChange(option.value))
                  .catch(() => undefined)
                  .finally(() => setPicked((current) => (current === pick ? null : current)));
              }}
            />
            <RowText title={option.title} description={option.description} />
          </label>
        </div>
      ))}
    </div>
  );
}

/** An on or off setting: its name, a line on what it does, and the switch. */
export function SwitchRow({
  title,
  description,
  checked,
  disabled,
  onChange,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  /** More controls before the switch, such as a time. */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <li>
      <div className="px-ctl-row">
        <RowText id={id} title={title} description={description} />
        {children}
        <button
          type="button"
          role="switch"
          className="px-ctl-switch"
          aria-checked={checked}
          aria-labelledby={id}
          aria-describedby={description ? `${id}-description` : undefined}
          disabled={disabled}
          onClick={() => onChange(!checked)}
        />
      </div>
    </li>
  );
}

/** A row holding any control on its right, such as a segmented control or a stepper. */
export function ControlRow({
  title,
  description,
  id,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** The id the control on the right uses for its name. */
  id: string;
  children: ReactNode;
}) {
  return (
    <li>
      <div className="px-ctl-row">
        <RowText id={id} title={title} description={description} />
        {children}
      </div>
    </li>
  );
}

/** A few choices side by side, as for sizes. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** The id of the text that names the control. */
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="px-ctl-seg"
      role="radiogroup"
      aria-labelledby={label}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      onKeyDown={(event) => {
        // Arrows move the choice, as in any radio group.
        const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const at = options.findIndex((option) => option.value === value);
        const next = options[(at + step + options.length) % options.length]!;
        onChange(next.value);
        (event.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus();
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          data-value={option.value}
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A whole number with − and +, saved when it changes. */
export function Stepper({
  label,
  value,
  min,
  max,
  step = 1,
  decreaseLabel,
  increaseLabel,
  disabled = false,
  onChange,
}: {
  /** The id of the text that names the number. */
  label: string;
  value: number;
  /** Until the stored number has loaded, so a step can't start from a guess. */
  disabled?: boolean;
  min: number;
  max: number;
  step?: number;
  decreaseLabel: string;
  increaseLabel: string;
  onChange: (value: number) => void;
}) {
  // What is typed stays in the field until it is a whole number in range; leaving the field puts the saved one back.
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  const commit = (next: number) => {
    setDraft(null);
    if (next !== value) onChange(clamp(next));
  };
  return (
    <div className="px-ctl-stepper" role="group" aria-labelledby={label}>
      <button type="button" aria-label={decreaseLabel} disabled={disabled || value <= min} onClick={() => commit(clamp(value - step))}>
        <Minus size={16} strokeWidth={1.75} aria-hidden />
      </button>
      <input
        inputMode="numeric"
        aria-labelledby={label}
        disabled={disabled}
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, "").slice(0, 3))}
        onBlur={() => {
          const typed = Number(draft);
          if (draft !== null && draft !== "" && Number.isInteger(typed)) commit(clamp(typed));
          else setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            commit(clamp(value + (event.key === "ArrowUp" ? step : -step)));
          }
        }}
      />
      <button type="button" aria-label={increaseLabel} disabled={disabled || value >= max} onClick={() => commit(clamp(value + step))}>
        <Plus size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
