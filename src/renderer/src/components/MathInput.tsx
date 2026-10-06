import { Input } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "./IconButton";
import { FormulaDock } from "./math/FormulaDock";
import { MathPreview } from "./math/MathPreview";
import { useFormulaInsert } from "./math/useFormulaInsert";
import "./MathInput.css";

/**
 * A written answer with the formula keyboard: a sigma button opens it under the field, and the
 * formula goes in as `$...$` at the caret. A rendered preview shows while the text holds math.
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
  const ref = useRef<TextAreaRef>(null);
  const getField = useCallback(
    () => ref.current?.resizableTextArea?.textArea ?? null,
    [],
  );
  const formula = useFormulaInsert({ getField, value, onChange });
  return (
    <div className="px-mathinput">
      <Input.TextArea
        ref={ref}
        aria-label={ariaLabel}
        placeholder={placeholder}
        rows={rows}
        autoSize={autoSize}
        maxLength={maxLength}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="px-mathinput-bar">
        <IconButton
          icon="sigma"
          label={t("math.toggle")}
          variant="ghost"
          size="sm"
          pressed={formula.open}
          disabled={disabled}
          onClick={formula.toggle}
        />
      </div>
      <FormulaDock
        open={formula.open && !disabled}
        onInsert={formula.insert}
        onClose={formula.close}
      />
      <MathPreview text={value} />
    </div>
  );
}
