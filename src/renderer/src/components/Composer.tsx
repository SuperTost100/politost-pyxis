import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { Tag } from "./Tag";
import "./Composer.css";

export function Composer({
  subject,
  sources,
  mode: initialMode = "solver",
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
  const [mode, setMode] = useState(initialMode);
  const [draft, setDraft] = useState("");
  const text = value ?? draft;
  function setText(next: string) {
    onValueChange?.(next);
    if (value === undefined) setDraft(next);
  }
  return (
    <div className="px-composer">
      <div className="px-composer-top">
        <button type="button" className="px-subject">
          <Icon name="graduation-cap" size={14} />
          {subject ?? t("components.composer.noSubject")}
        </button>
        {(sources ?? []).map((s) => (
          <Tag key={s} tone="smartbook">{s}</Tag>
        ))}
      </div>
      <textarea
        placeholder={placeholder ?? t("ask.placeholder")}
        rows={2}
        aria-label={t("components.composer.messageLabel")}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSend?.();
          }
        }}
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
          label={t("components.composer.formula")}
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
