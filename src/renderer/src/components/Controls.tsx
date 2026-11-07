import { Minus, Plus, X } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { addTags } from "./tags";
import "./Controls.css";

/*
 * The settings controls, one look per kind (pyxis-mockups app/index.html, "s-settings-studio"): one choice of several is
 * radio rows, on or off is a switch row, a few sizes are a segmented control, and a number is a stepper. Rows sit in a
 * white list card. A short text is a field in its row ("s-settings-profile"), and a list of words is a tags field.
 */

/** A titled group of settings with an optional line under the title, as "Chi sei" or "Copie di sicurezza". */
export function ControlGroup({
  title,
  hint,
  id,
  children,
}: {
  /** Without one, the group is a single row that names itself, such as "Cancella tutti i dati". */
  title?: ReactNode;
  hint?: ReactNode;
  /** The section id links scroll to, as settings-privacy. */
  id?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="px-ctl-group" id={id} aria-labelledby={title ? titleId : undefined}>
      {title ? (
        <h2 className="px-ctl-group-title" id={titleId}>
          {title}
        </h2>
      ) : null}
      {hint ? <p className="px-ctl-group-hint">{hint}</p> : null}
      {children}
    </section>
  );
}

/** Content that opens under the control that caused it, growing from it: a confirmation, an explanation. */
export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={className ? `px-ctl-reveal ${className}` : "px-ctl-reveal"}>
      <div>{children}</div>
    </div>
  );
}

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
  below,
}: {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  /** More controls before the switch, such as a time. */
  children?: ReactNode;
  /** Content in the same card under the row, such as the tags the switch turns on. */
  below?: ReactNode;
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
      {below}
    </li>
  );
}

/** A row holding any control on its right, such as a segmented control or a stepper. */
export function ControlRow({
  title,
  description,
  id,
  children,
  below,
  path,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** The id the control on the right uses for its name. */
  id: string;
  children?: ReactNode;
  /** Content in the same card under the row, such as a confirmation that opens from it. */
  below?: ReactNode;
  /** The description is a path, set in a monospace face. */
  path?: boolean;
}) {
  return (
    <li>
      <div className={path ? "px-ctl-row has-path" : "px-ctl-row"}>
        <RowText id={id} title={title} description={description} />
        {children}
      </div>
      {below}
    </li>
  );
}

/** A short text in its row, as a name: a soft field on the right, saved when it is left or Enter is pressed. */
export function TextRow({
  title,
  value,
  maxLength,
  placeholder,
  onSave,
}: {
  title: ReactNode;
  value: string;
  maxLength: number;
  placeholder?: string;
  onSave: (value: string) => void;
}) {
  const id = useId();
  return (
    <li>
      <div className="px-ctl-row">
        <RowText id={id} title={title} />
        <input
          // A stored value that changes elsewhere, as after setup again, replaces what the field shows.
          key={value}
          className="px-ctl-field"
          aria-labelledby={id}
          autoComplete="off"
          maxLength={maxLength}
          placeholder={placeholder}
          defaultValue={value}
          onBlur={(event) => {
            const next = event.target.value.trim();
            if (next !== value) onSave(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = value;
              event.currentTarget.blur();
            }
          }}
        />
      </div>
    </li>
  );
}

/**
 * A list of words, each a tag with ×, and a field that adds what is typed on Enter or a comma, or when it is left. A
 * pasted list separated by commas adds every item. It saves the whole list on each change.
 */
export function TagsField({
  label,
  values,
  max,
  maxLength,
  placeholder,
  fullPlaceholder,
  removeLabel,
  onChange,
}: {
  label: string;
  values: readonly string[];
  /** The most tags, and the longest one. */
  max: number;
  maxLength: number;
  placeholder: string;
  /** What the field says once there are `max` tags. */
  fullPlaceholder: string;
  removeLabel: (value: string) => string;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  // Tags added here grow in place; the ones already stored are simply there.
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());
  const input = useRef<HTMLInputElement>(null);
  const full = values.length >= max;
  const commit = (text: string) => {
    const next = addTags(values, text, { max, maxLength });
    setDraft("");
    if (next.length === values.length) return;
    setAdded(new Set(next.slice(values.length)));
    onChange(next);
  };
  return (
    <div className="px-ctl-tags" onClick={(event) => event.target === event.currentTarget && input.current?.focus()}>
      {values.map((value, index) => (
        <span key={`${index}-${value}`} className={added.has(value) ? "px-ctl-tag is-new" : "px-ctl-tag"}>
          {value}
          <button
            type="button"
            aria-label={removeLabel(value)}
            onClick={() => {
              onChange(values.filter((_, at) => at !== index));
              input.current?.focus();
            }}
          >
            <X size={14} strokeWidth={2} aria-hidden />
          </button>
        </span>
      ))}
      <input
        ref={input}
        aria-label={label}
        autoComplete="off"
        disabled={full}
        // Room for a whole item, and for several when a list is pasted.
        maxLength={max * (maxLength + 2)}
        placeholder={full ? fullPlaceholder : placeholder}
        value={draft}
        onChange={(event) => {
          const text = event.target.value;
          // A comma ends an item, typed or pasted; what follows the last one stays in the field.
          const end = text.lastIndexOf(",");
          if (end < 0) setDraft(text);
          else {
            commit(text.slice(0, end));
            setDraft(text.slice(end + 1).trimStart());
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commit(draft);
        }}
        onBlur={() => {
          if (draft.trim()) commit(draft);
        }}
      />
    </div>
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

/** A whole number with − and +, saved when it changes. With no number yet it shows a dash, and + starts at the minimum. */
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
  value: number | null;
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
  const from = (direction: 1 | -1) => (value === null ? min : clamp(value + direction * step));
  return (
    <div className="px-ctl-stepper" role="group" aria-labelledby={label}>
      <button
        type="button"
        aria-label={decreaseLabel}
        disabled={disabled || value === null || value <= min}
        onClick={() => commit(from(-1))}
      >
        <Minus size={16} strokeWidth={1.75} aria-hidden />
      </button>
      <input
        inputMode="numeric"
        aria-labelledby={label}
        disabled={disabled}
        placeholder="–"
        value={draft ?? (value === null ? "" : String(value))}
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
            commit(from(event.key === "ArrowUp" ? 1 : -1));
          }
        }}
      />
      <button
        type="button"
        aria-label={increaseLabel}
        disabled={disabled || (value !== null && value >= max)}
        onClick={() => commit(from(1))}
      >
        <Plus size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
