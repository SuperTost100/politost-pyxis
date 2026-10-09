import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Drawer, Dropdown, Input, Modal } from "antd";
import { Ellipsis, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../lib/ipc";
import "./ChatPanel.css";

/** The saved chats as a drawer from the left. Each row opens its chat; a menu renames or deletes it on demand. */
export function ChatPanel({
  open,
  onClose,
  chatId,
  onOpenChat,
  onNew,
}: {
  open: boolean;
  onClose: () => void;
  chatId?: string;
  onOpenChat: (id: string) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const client = useQueryClient();
  const history = useQuery({
    queryKey: ["chats"],
    queryFn: () => invoke("chats.list", {}),
  });
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [removing, setRemoving] = useState(false);
  // Esc unmounts the field, so the blur that follows must not save what Esc just cancelled.
  const cancelled = useRef(false);
  const chats = history.data ?? [];
  const nameOf = (title: string | null) => title?.trim() || t("ask.untitled");

  async function saveRename() {
    const current = renaming;
    setRenaming(null);
    if (!current || cancelled.current) return;
    const title = current.title.trim();
    const old = chats.find((chat) => chat.id === current.id);
    if (!title || title === old?.title) return;
    try {
      await invoke("chats.rename", { chatId: current.id, title });
    } catch {
      void message.error(t("ask.renameFailed"));
    }
    void client.invalidateQueries({ queryKey: ["chats"] });
  }

  async function confirmDelete() {
    const target = deleting;
    if (!target || removing) return;
    setRemoving(true);
    try {
      await invoke("chats.delete", { chatId: target.id });
      setDeleting(null);
      if (target.id === chatId) onNew();
    } catch {
      void message.error(t("ask.deleteFailed"));
    } finally {
      setRemoving(false);
      void client.invalidateQueries({ queryKey: ["chats"] });
    }
  }

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        placement="left"
        size={320}
        title={t("ask.history")}
        closable={{ "aria-label": t("ask.chatsClose") }}
        rootClassName="ask-panel"
      >
        <Button
          shape="round"
          block
          icon={<Plus size={16} aria-hidden />}
          onClick={() => {
            onNew();
            onClose();
          }}
        >
          {t("ask.new")}
        </Button>
        {chats.length === 0 ? (
          <p className="small ask-panel-empty">{t("ask.chatsEmpty")}</p>
        ) : (
          <ul className="ask-panel-list" aria-label={t("ask.history")}>
            {chats.map((chat) => {
              const title = nameOf(chat.title);
              const editing = renaming?.id === chat.id;
              return (
                <li
                  key={chat.id}
                  className={
                    chat.id === chatId
                      ? "ask-panel-row is-current"
                      : "ask-panel-row"
                  }
                >
                  {editing ? (
                    <Input
                      autoFocus
                      className="ask-panel-rename"
                      aria-label={t("ask.renameLabel")}
                      maxLength={80}
                      value={renaming.title}
                      onFocus={(event) => event.target.select()}
                      onChange={(event) =>
                        setRenaming({ id: chat.id, title: event.target.value })
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          cancelled.current = false;
                          void saveRename();
                        }
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          cancelled.current = true;
                          setRenaming(null);
                        }
                      }}
                      onBlur={() => void saveRename()}
                    />
                  ) : (
                    <button
                      type="button"
                      className="ask-panel-title"
                      aria-current={chat.id === chatId ? "page" : undefined}
                      onClick={() => {
                        onOpenChat(chat.id);
                        onClose();
                      }}
                    >
                      {title}
                    </button>
                  )}
                  {editing ? null : (
                    <Dropdown
                      trigger={["click"]}
                      placement="bottomRight"
                      menu={{
                        items: [
                          { key: "rename", label: t("ask.rename") },
                          {
                            key: "delete",
                            label: t("ask.delete"),
                            danger: true,
                          },
                        ],
                        onClick: ({ key }) => {
                          if (key === "rename") {
                            cancelled.current = false;
                            setRenaming({ id: chat.id, title: chat.title ?? "" });
                          }
                          if (key === "delete")
                            setDeleting({ id: chat.id, title });
                        },
                      }}
                    >
                      <Button
                        type="text"
                        shape="circle"
                        size="small"
                        aria-label={t("ask.chatActions", { title })}
                        icon={<Ellipsis size={16} aria-hidden />}
                      />
                    </Dropdown>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Drawer>
      <Modal
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onOk={() => void confirmDelete()}
        title={t("ask.deleteTitle")}
        okText={t("ask.deleteConfirm")}
        cancelText={t("ask.cancel")}
        okButtonProps={{ danger: true }}
        confirmLoading={removing}
        width={420}
      >
        <p>{t("ask.deleteBody", { title: deleting?.title ?? "" })}</p>
      </Modal>
    </>
  );
}
