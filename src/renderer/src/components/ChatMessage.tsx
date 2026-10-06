import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Chip } from "./Chip";
import { IconButton } from "./IconButton";
import { Logo } from "./Logo";
import { RunnablePython } from "./PythonBlock";
import { Tag } from "./Tag";
import "./ChatMessage.css";

export function ChatMessage({
  role = "tutor",
  children,
  engine,
  suggestions,
  onSuggest,
  general,
  text,
  reaction,
  onReact,
  onRegenerate,
  regenerateDisabled,
}: {
  role?: "user" | "tutor";
  children: ReactNode;
  engine?: string;
  suggestions?: string[];
  onSuggest?: (text: string) => void;
  general?: boolean;
  text?: string;
  reaction?: "up" | "down" | null;
  onRegenerate?: () => void;
  regenerateDisabled?: boolean;
  onReact?: (reaction: "up" | "down") => void;
}) {
  const { t } = useTranslation();
  if (role === "user") {
    return (
      <div className="px-msg px-msg-user">
        <div className="px-msg-bubble">{children}</div>
      </div>
    );
  }
  return (
    <div className="px-msg">
      <span className="px-msg-avatar" aria-hidden>
        <Logo size={22} />
      </span>
      <div className="px-msg-body">
        {general ? (
          <div style={{ marginBottom: 8 }}>
            <Tag tone="general">{t("components.chat.generalTag")}</Tag>
          </div>
        ) : null}
        <div className="px-msg-text">
          <RunnablePython.Provider value>{children}</RunnablePython.Provider>
        </div>
        <div className="px-msg-foot">
          <IconButton
            icon="copy"
            label={t("components.chat.copy")}
            variant="ghost"
            size="sm"
            onClick={() => {
              if (text) void navigator.clipboard.writeText(text);
            }}
          />
          <IconButton
            icon="thumbs-up"
            label={t("components.chat.helpful")}
            variant="ghost"
            size="sm"
            pressed={reaction === "up"}
            onClick={() => onReact?.("up")}
          />
          <IconButton
            icon="thumbs-down"
            label={t("components.chat.notHelpful")}
            variant="ghost"
            size="sm"
            pressed={reaction === "down"}
            onClick={() => onReact?.("down")}
          />
          {onRegenerate ? (
            <IconButton
              icon="refresh-cw"
              label={t("components.chat.regenerate")}
              variant="ghost"
              size="sm"
              disabled={regenerateDisabled}
              onClick={onRegenerate}
            />
          ) : null}
          {engine ? <span className="px-msg-engine">{engine}</span> : null}
        </div>
        {suggestions ? (
          <div className="px-msg-chips">
            {suggestions.map((s) => (
              <Chip key={s} onClick={() => onSuggest?.(s)}>
                {s}
              </Chip>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The tutor's turn before any text has streamed: the mark and one status line, so the wait is never blank.
 * With sources it says it is reading them first, then that it is thinking.
 */
export function ThinkingMessage({ usesSources }: { usesSources?: boolean }) {
  const { t } = useTranslation();
  const [reading, setReading] = useState(Boolean(usesSources));
  useEffect(() => {
    if (!usesSources) return;
    const timer = setTimeout(() => setReading(false), 1600);
    return () => clearTimeout(timer);
  }, [usesSources]);
  return (
    <div className="px-msg px-msg-thinking" role="status">
      <span className="px-msg-avatar" aria-hidden>
        <Logo size={22} />
      </span>
      <div className="px-msg-body">
        <p className="px-msg-status">
          {reading ? t("components.chat.readingSources") : t("components.chat.thinking")}
        </p>
      </div>
    </div>
  );
}
