import { useQueryClient } from "@tanstack/react-query";
import { App, Button, Input } from "antd";
import { PanelLeft, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../lib/ipc";

/**
 * The bar above the conversation, as wide as the column: the chat list, the open chat's title, and New chat. A click
 * on the title renames the chat in place; Enter or leaving the field saves, Esc cancels.
 */
export function ChatHeader({
  chatId,
  title,
  panelOpen,
  onOpenPanel,
  onNew,
  usage,
}: {
  chatId?: string;
  /** The open chat's title, null when it has none yet, undefined while the list loads or for a new chat. */
  title?: string | null;
  panelOpen: boolean;
  onOpenPanel: () => void;
  onNew: () => void;
  /** The open chat's tokens: a short figure, and the breakdown for hover and screen readers. */
  usage?: { short: string; detail: string };
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const client = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  // Enter and the blur it causes both save; the first one empties this, so only it saves. Esc empties it too.
  const draft = useRef<string | null>(null);
  const name = title?.trim() || t("ask.untitled");

  async function save() {
    const next = draft.current?.trim();
    draft.current = null;
    setEditing(null);
    if (!chatId || !next || next === title) return;
    try {
      await invoke("chats.rename", { chatId, title: next });
    } catch {
      void message.error(t("ask.renameFailed"));
    }
    void client.invalidateQueries({ queryKey: ["chats"] });
  }

  return (
    <div className="ask-bar">
      <Button
        type="text"
        aria-label={t("ask.chatsOpen")}
        aria-expanded={panelOpen}
        icon={<PanelLeft size={18} aria-hidden />}
        onClick={onOpenPanel}
      />
      <div className="ask-bar-title">
        {chatId && title !== undefined ? (
          editing !== null ? (
            <Input
              autoFocus
              size="small"
              aria-label={t("ask.renameLabel")}
              maxLength={80}
              value={editing}
              onFocus={(event) => event.target.select()}
              onChange={(event) => {
                draft.current = event.target.value;
                setEditing(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
                if (event.key === "Escape") {
                  event.stopPropagation();
                  draft.current = null;
                  setEditing(null);
                }
              }}
              onBlur={() => void save()}
            />
          ) : (
            <button
              type="button"
              className="ask-bar-name"
              title={t("ask.renameTitle")}
              aria-label={t("ask.renameNamed", { title: name })}
              onClick={() => {
                draft.current = title ?? "";
                setEditing(title ?? "");
              }}
            >
              {name}
            </button>
          )
        ) : null}
      </div>
      {usage ? (
        <span className="ask-usage" title={usage.detail}>
          <span aria-hidden>{usage.short}</span>
          <span className="visually-hidden">{usage.detail}</span>
        </span>
      ) : null}
      <Button type="text" icon={<Plus size={16} aria-hidden />} onClick={onNew}>
        {t("ask.new")}
      </Button>
    </div>
  );
}
