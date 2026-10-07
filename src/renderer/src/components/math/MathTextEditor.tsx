import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type CSSProperties, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { MathEditor } from "./mathEditor";
import "katex/dist/katex.min.css";
import "./MathTextEditor.css";

export type MathTextEditorHandle = {
  focus: () => void;
  /** True while a formula is open for editing. */
  editing: () => boolean;
  /** Opens a new formula at the caret, or returns to the open one. */
  insertMath: () => void;
  /** Formula keyboard: put LaTeX into the open formula, opening one when needed. */
  insertLatex: (latex: string) => void;
  command: (name: "moveToPreviousChar" | "moveToNextChar" | "deleteBackward") => void;
  /** Closes the open formula and puts the caret after it. */
  leaveMath: () => void;
};

/**
 * A text field where formulas sit inline with the words. The value is a string with LaTeX between
 * dollar signs; the student only ever sees rendered math. Typing `$` opens a formula at the caret.
 */
export function MathTextEditor({
  ref,
  value,
  onChange,
  onSubmit,
  onKeyDown,
  ariaLabel,
  placeholder,
  disabled,
  maxLength,
  className,
  style,
}: {
  ref?: Ref<MathTextEditorHandle>;
  value: string;
  onChange: (value: string) => void;
  /** Enter without Shift. Without it, Enter starts a new line. */
  onSubmit?: () => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const { t, i18n } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<MathEditor | null>(null);
  const latest = useRef({ onChange, onSubmit, onKeyDown, maxLength, label: t("math.field"), language: i18n.language });
  latest.current = { onChange, onSubmit, onKeyDown, maxLength, label: t("math.field"), language: i18n.language };

  useLayoutEffect(() => {
    const instance = new MathEditor(root.current!, {
      onChange: (next) => latest.current.onChange(next),
      onSubmit: () => {
        const submit = latest.current.onSubmit;
        submit?.();
        return submit !== undefined;
      },
      onKeyDown: (event) => latest.current.onKeyDown?.(event),
      maxLength: () => latest.current.maxLength,
      formulaLabel: () => latest.current.label,
      language: () => latest.current.language,
    });
    editor.current = instance;
    return () => {
      instance.destroy();
      editor.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    editor.current?.setValue(value);
  }, [value]);

  useEffect(() => {
    editor.current?.setDisabled(Boolean(disabled));
  }, [disabled]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editor.current?.focus(),
      editing: () => editor.current?.editing() ?? false,
      insertMath: () => editor.current?.insertMath(),
      insertLatex: (latex) => editor.current?.insertLatex(latex),
      command: (name) => editor.current?.command(name),
      leaveMath: () => editor.current?.leaveMath(),
    }),
    [],
  );

  return (
    <div
      ref={root}
      className={["px-mathtext", className].filter(Boolean).join(" ")}
      style={style}
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      aria-placeholder={placeholder}
      aria-disabled={disabled || undefined}
      data-placeholder={placeholder}
      tabIndex={disabled ? -1 : 0}
      spellCheck
    />
  );
}
