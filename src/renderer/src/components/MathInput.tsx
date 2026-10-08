import { useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "./IconButton";
import { FormulaDock } from "./math/FormulaDock";
import { MathTextEditor, type MathTextEditorHandle } from "./math/MathTextEditor";
import { useFormulaKeys } from "./math/useFormulaKeys";
import "./MathInput.css";

/**
 * A written answer with formulas inline: typing `$` or the sigma button opens a formula at the
 * caret, and the formula keyboard types into it. The value holds the formulas as `$...$`.
 */
export function MathInput({
  value,
  onChange,
  disabled,
  ariaLabel,
  placeholder,
  rows,
  autoSize,
  maxLength,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  placeholder?: string;
  rows?: number;
  autoSize?: { minRows?: number; maxRows?: number };
  maxLength?: number;
}) {
  const { t } = useTranslation();
  const field = useRef<MathTextEditorHandle>(null);
  const formula = useFormulaKeys(field);
  const minRows = autoSize?.minRows ?? rows ?? 2;
  const maxRows = Math.max(autoSize?.maxRows ?? 12, minRows);
  return (
    <div className="px-mathinput">
      <MathTextEditor
        ref={field}
        className="px-mathinput-field"
        style={{ "--min-rows": minRows, "--max-rows": maxRows } as CSSProperties}
        ariaLabel={ariaLabel}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        value={value}
        onChange={onChange}
      />
      <FormulaDock {...formula.dock} open={formula.open && !disabled} />
      <div className="px-mathinput-bar">
        <IconButton
          icon="sigma"
          label={t("math.toggle")}
          variant="ghost"
          size="sm"
          pressed={formula.open}
          disabled={disabled}
          keepFocus
          onClick={formula.toggle}
        />
      </div>
    </div>
  );
}
