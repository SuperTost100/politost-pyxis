import { Button as AntButton, Dropdown } from "antd";
import { ArrowRight, Ellipsis } from "lucide-react";
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
  onMakeCards,
  reaction,
  onReact,
  onRegenerate,
  onAnswerStronger,
  regenerateDisabled,
  stopped,
  failure,
  onContinue,
  checking,
  streaming,
}: {
  role?: "user" | "tutor";
  children: ReactNode;
  engine?: string;
  suggestions?: string[];
  onSuggest?: (text: string) => void;
  general?: boolean;
  text?: string;
  /** Opens the flashcard dialog for this reply. */
  onMakeCards?: () => void;
  reaction?: "up" | "down" | null;
  onRegenerate?: () => void;
  /** Answer the question again with the strongest model, from the reply's menu. */
  onAnswerStronger?: () => void;
  regenerateDisabled?: boolean;
  onReact?: (reaction: "up" | "down") => void;
  /** The student stopped this reply before it finished. */
  stopped?: boolean;
  /** Why the engine cut the reply short. Such a reply is kept and can be continued. */
  failure?: string;
  onContinue?: () => void;
  /** The math check for this reply is still running. */
  checking?: boolean;
  /** The reply is still being written, so there is nothing yet to copy, rate or rewrite. */
  streaming?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  if (role === "user") {
    return (
      <div className="px-msg px-msg-user">
        <div className="px-msg-bubble">
          <span className="visually-hidden">{t("components.chat.you")}: </span>
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="px-msg">
      <span className="px-msg-avatar" aria-hidden>
        <Logo size={22} />
      </span>
      <div className="px-msg-body">
        <span className="visually-hidden">{t("components.chat.pyxis")}: </span>
        {general || stopped ? (
          <div className="px-msg-tags">
            {general ? <Tag tone="general">{t("components.chat.generalTag")}</Tag> : null}
            {stopped ? <Tag>{failure ? t("components.chat.cutOff") : t("ask.stopped")}</Tag> : null}
          </div>
        ) : null}
        <div className="px-msg-text">
          <RunnablePython.Provider value>{children}</RunnablePython.Provider>
        </div>
        {failure ? (
          <div className="px-msg-cut">
            <p className="px-msg-status">{failure}</p>
            {onContinue ? (
              <AntButton
                shape="round"
                size="small"
                icon={<ArrowRight size={14} aria-hidden />}
                iconPlacement="end"
                disabled={regenerateDisabled}
                onClick={onContinue}
              >
                {t("components.chat.continue")}
              </AntButton>
            ) : null}
          </div>
        ) : null}
        {checking ? (
          <p className="px-msg-status px-msg-checking" role="status">
            {t("components.chat.checking")}
          </p>
        ) : null}
        {streaming ? null : (
          <div className="px-msg-foot">
            <IconButton
              icon={copied === "done" ? "check" : "copy"}
              label={
                copied === "done"
                  ? t("components.chat.copied")
                  : copied === "failed"
                    ? t("components.chat.copyFailed")
                    : t("components.chat.copy")
              }
              variant="ghost"
              size="sm"
              onClick={() => {
                if (!text) return;
                navigator.clipboard.writeText(text).then(
                  () => setCopied("done"),
                  () => setCopied("failed"),
                );
              }}
            />
            <span className="visually-hidden" role="status">
              {copied === "done"
                ? t("components.chat.copied")
                : copied === "failed"
                  ? t("components.chat.copyFailed")
                  : ""}
            </span>
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
            {onMakeCards ? (
              <IconButton
                icon="layers"
                label={t("components.chat.makeCards")}
                variant="ghost"
                size="sm"
                onClick={onMakeCards}
              />
            ) : null}
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
            {onAnswerStronger ? (
              <Dropdown
                trigger={["click"]}
                placement="bottomLeft"
                disabled={regenerateDisabled}
                menu={{
                  items: [{ key: "strong", label: t("components.chat.answerStronger") }],
                  onClick: () => onAnswerStronger(),
                }}
              >
                <AntButton
                  type="text"
                  shape="circle"
                  size="small"
                  className="px-btn px-btn-ghost px-iconbtn px-btn-sm"
                  aria-label={t("components.chat.more")}
                  title={t("components.chat.more")}
                  disabled={regenerateDisabled}
                  icon={<Ellipsis size={16} aria-hidden />}
                />
              </Dropdown>
            ) : null}
            {engine ? <span className="px-msg-engine">{engine}</span> : null}
          </div>
        )}
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
        <Logo size={22} working />
      </span>
      <div className="px-msg-body">
        <p className="px-msg-status">
          {reading ? t("components.chat.readingSources") : t("components.chat.thinking")}
        </p>
      </div>
    </div>
  );
}
