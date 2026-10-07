import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { FormulaDock } from "./math/FormulaDock";
import { MathPreview } from "./math/MathPreview";
import { useFormulaInsert } from "./math/useFormulaInsert";
import { Tag } from "./Tag";
import "./Composer.css";

export function Composer({
  subject,
  subjectControl,
  sourcesControl,
  sources,
  mode: modeProp,
  placeholder,
  streaming,
  value,
  onValueChange,
  onSend,
  onStop,
  onModeChange,
  onAttach,
}: {
  subject?: string;
  /** Replaces the plain subject label, for a chip that opens the subject menu. */
  subjectControl?: ReactNode;
  /** Replaces the list of source tags, for a chip that opens the sources in use. */
  sourcesControl?: ReactNode;
  sources?: string[];
  mode?: "solver" | "socratic";
  placeholder?: string;
  streaming?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  onSend?: () => void;
  onStop?: () => void;
  onModeChange?: (mode: "solver" | "socratic") => void;
  onAttach?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [localMode, setMode] = useState<"solver" | "socratic">("solver");
  const mode = modeProp ?? localMode;
  const [draft, setDraft] = useState("");
  const text = value ?? draft;
  function setText(next: string) {
    onValueChange?.(next);
    if (value === undefined) setDraft(next);
  }
  const field = useRef<HTMLTextAreaElement>(null);
  const formula = useFormulaInsert({
    getField: () => field.current,
    value: text,
    onChange: setText,
  });
  // The field grows with the draft up to a few lines, then scrolls.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  return (
    <div className="px-composer">
      <div className="px-composer-top">
        {subjectControl ?? (
          <span className="px-subject">
            <Icon name="graduation-cap" size={14} />
            <span>{subject ?? t("components.composer.noSubject")}</span>
          </span>
        )}
        {sourcesControl ??
          (sources ?? []).map((s) => (
            <Tag key={s} tone="smartbook">{s}</Tag>
          ))}
      </div>
      <textarea
        ref={field}
        placeholder={placeholder ?? t("ask.placeholder")}
        rows={2}
        aria-label={t("components.composer.messageLabel")}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!streaming) onSend?.();
          }
          if (event.key === "Escape" && streaming) onStop?.();
        }}
      />
      <MathPreview text={text} />
      <FormulaDock
        open={formula.open}
        onInsert={formula.insert}
        onClose={formula.close}
      />
      <div className="px-composer-bar">
        <IconButton
          icon="paperclip"
          label={t("components.composer.attach")}
          variant="ghost"
          size="sm"
          onClick={onAttach}
        />
        <IconButton
          icon="signature"
          label={t("components.composer.whiteboard")}
          variant="ghost"
          size="sm"
          onClick={() => navigate("/tools/whiteboard")}
        />
        <IconButton
          icon="sigma"
          label={t("math.toggle")}
          variant="ghost"
          size="sm"
          pressed={formula.open}
          onClick={formula.toggle}
        />
        <IconButton
          icon="chart-line"
          label={t("components.composer.graph")}
          variant="ghost"
          size="sm"
          onClick={() => navigate("/tools/graph")}
        />
        <div className="px-mode" role="group" aria-label={t("components.composer.modeLabel")}>
          <button
            type="button"
            aria-pressed={mode === "solver"}
            onClick={() => {
              setMode("solver");
              onModeChange?.("solver");
            }}
          >
            {t("components.composer.solver")}
          </button>
          <button
            type="button"
            aria-pressed={mode === "socratic"}
            onClick={() => {
              setMode("socratic");
              onModeChange?.("socratic");
            }}
          >
            {t("components.composer.socratic")}
          </button>
        </div>
        <span className="px-spacer" />
        {streaming ? (
          <IconButton
            icon="square"
            label={t("components.composer.stop")}
            variant="secondary"
            size="sm"
            onClick={onStop}
          />
        ) : (
          <IconButton
            icon="send"
            label={t("components.composer.send")}
            variant="primary"
            size="sm"
            onClick={onSend}
          />
        )}
      </div>
    </div>
  );
}
