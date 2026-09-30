import { useState } from "react";
import { useTranslation } from "react-i18next";
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
}: {
  subject?: string;
  sources?: string[];
  mode?: "solver" | "socratic";
  placeholder?: string;
  streaming?: boolean;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState(initialMode);
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
      />
      <div className="px-composer-bar">
        <IconButton
          icon="paperclip"
          label={t("components.composer.attach")}
          variant="ghost"
          size="sm"
        />
        <IconButton
          icon="signature"
          label={t("components.composer.whiteboard")}
          variant="ghost"
          size="sm"
        />
        <IconButton
          icon="sigma"
          label={t("components.composer.formula")}
          variant="ghost"
          size="sm"
        />
        <div className="px-mode" role="group" aria-label={t("components.composer.modeLabel")}>
          <button
            type="button"
            aria-pressed={mode === "solver"}
            onClick={() => setMode("solver")}
          >
            {t("components.composer.solver")}
          </button>
          <button
            type="button"
            aria-pressed={mode === "socratic"}
            onClick={() => setMode("socratic")}
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
          />
        ) : (
          <IconButton
            icon="send"
            label={t("components.composer.send")}
            variant="primary"
            size="sm"
          />
        )}
      </div>
    </div>
  );
}
