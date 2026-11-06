import { useQueryClient } from "@tanstack/react-query";
import { App, Input } from "antd";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../lib/ipc";

/**
 * The bar above the conversation with the open chat's title. A click on the title renames the chat in place; Enter or
 * leaving the field saves, Esc cancels.
 */
export function ChatHeader({
  chatId,
  title,
}: {
  chatId?: string;
  /** The open chat's title, null when it has none yet, undefined while the list loads or for a new chat. */
  title?: string | null;
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
    </div>
  );
}
