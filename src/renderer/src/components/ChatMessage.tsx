import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Chip } from "./Chip";
import { IconButton } from "./IconButton";
import { Logo } from "./Logo";
import { Tag } from "./Tag";
import "./ChatMessage.css";

export function ChatMessage({
  role = "tutor",
  children,
  engine,
  suggestions,
  onSuggest,
  general,
}: {
  role?: "user" | "tutor";
  children: ReactNode;
  engine?: string;
  suggestions?: string[];
  onSuggest?: (text: string) => void;
  general?: boolean;
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
        <div className="px-msg-text">{children}</div>
        <div className="px-msg-foot">
          <IconButton icon="copy" label={t("components.chat.copy")} variant="ghost" size="sm" />
          <IconButton icon="thumbs-up" label={t("components.chat.helpful")} variant="ghost" size="sm" />
          <IconButton icon="thumbs-down" label={t("components.chat.notHelpful")} variant="ghost" size="sm" />
          <IconButton icon="refresh-cw" label={t("components.chat.regenerate")} variant="ghost" size="sm" />
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
