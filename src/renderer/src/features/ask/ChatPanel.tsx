import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Drawer, Dropdown, Input, Modal } from "antd";
import { Ellipsis, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../lib/ipc";
import { textBase64 } from "../share/ExportButton";
import "./ChatPanel.css";

/** The saved chats as a drawer from the left. A search box narrows them by title and message text. Each row opens its chat; a menu renames, exports or deletes it on demand. */
export function ChatPanel({
  open,
  onClose,
  chatId,
  onOpenChat,
  onNew,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  chatId?: string;
  onOpenChat: (id: string) => void;
  onNew: () => void;
  /** Called once the chat is gone, so a reply still being written for it can be stopped. */
  onDeleted?: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const client = useQueryClient();
  const history = useQuery({
    queryKey: ["chats"],
    queryFn: () => invoke("chats.list", {}),
  });
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [exporting, setExporting] = useState(false);
  // Leaving the drawer clears the search, so the next visit starts with the whole list.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  useEffect(() => {
    const timer = setTimeout(() => setAsked(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const searching = query.trim() !== "";
  const found = useQuery({
    queryKey: ["chats", "search", asked],
    queryFn: () => invoke("chats.search", { query: asked }),
    enabled: asked !== "",
    placeholderData: keepPreviousData,
  });
  const [renaming, setRenamingState] = useState<{ id: string; title: string } | null>(
    null,
  );
  // Enter and the blur it causes both save. Each reads the field here and empties it, so only the first one saves.
  const draft = useRef<{ id: string; title: string } | null>(null);
  const setRenaming = (next: { id: string; title: string } | null) => {
    draft.current = next;
    setRenamingState(next);
  };
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [removing, setRemoving] = useState(false);
  // Esc unmounts the field, so the blur that follows must not save what Esc just cancelled.
  const cancelled = useRef(false);
  const chats = history.data ?? [];
  const hits = searching ? (found.data?.hits ?? []) : null;
  const rows: Array<{
    id: string;
    title: string | null;
    snippet?: { text: string; start: number; end: number } | null;
  }> = hits ?? chats;
  const settled = searching && asked === query.trim() && !found.isFetching && found.data;
  const nameOf = (title: string | null) => title?.trim() || t("ask.untitled");

  async function saveRename() {
    const current = draft.current;
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

  async function exportChat(id: string, format: "markdown" | "pdf") {
    if (exporting) return;
    setExporting(true);
    const key = "ask-export";
    void message.open({ key, type: "loading", content: t("ask.exporting"), duration: 0 });
    try {
      const file = await invoke("chats.export", {
        chatId: id,
        language: i18n.language === "en" ? "en" : "it",
      });
      const result =
        format === "pdf"
          ? await window.pyxis.exportPdf({
              filename: file.filename.replace(/\.md$/i, ".pdf"),
              markdown: file.markdown,
            })
          : await window.pyxis.saveArtifact({
              filename: file.filename,
              base64: textBase64(file.markdown),
            });
      if (result === "saved") void message.success({ key, content: t("export.saved") });
      else message.destroy(key);
    } catch {
      void message.error({ key, content: t("export.failed") });
    } finally {
      setExporting(false);
    }
  }

  async function confirmDelete() {
    const target = deleting;
    if (!target || removing) return;
    setRemoving(true);
    try {
      await invoke("chats.delete", { chatId: target.id });
      onDeleted?.(target.id);
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
        <div role="search">
          <Input
            aria-label={t("ask.searchLabel")}
            placeholder={t("ask.searchPlaceholder")}
            prefix={<Search size={16} strokeWidth={1.75} aria-hidden />}
            allowClear
            maxLength={200}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Esc clears the search first; only an empty box lets it close the drawer.
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
        </div>
        <div className="visually-hidden" role="status" aria-live="polite">
          {settled ? t("ask.searchCount", { count: found.data.hits.length }) : ""}
        </div>
        {searching && settled && rows.length === 0 ? (
          <p className="small ask-panel-empty">
            {t("ask.searchNone", { query: query.trim() })}
          </p>
        ) : !searching && chats.length === 0 ? (
          <p className="small ask-panel-empty">{t("ask.chatsEmpty")}</p>
        ) : rows.length > 0 ? (
          <ul
            className="ask-panel-list"
            aria-label={searching ? t("ask.searchResults") : t("ask.history")}
          >
            {rows.map((chat) => {
              const title = nameOf(chat.title);
              const editing = renaming?.id === chat.id;
              const snippet = chat.snippet;
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
                      <span className="ask-panel-name">{title}</span>
                      {snippet ? (
                        <span className="ask-panel-snippet">
                          {snippet.text.slice(0, snippet.start)}
                          <mark>{snippet.text.slice(snippet.start, snippet.end)}</mark>
                          {snippet.text.slice(snippet.end)}
                        </span>
                      ) : null}
                    </button>
                  )}
                  {editing ? null : (
                    <Dropdown
                      trigger={["click"]}
                      placement="bottomRight"
                      menu={{
                        items: [
                          { key: "rename", label: t("ask.rename") },
                          { key: "markdown", label: t("ask.exportMarkdown") },
                          { key: "pdf", label: t("ask.exportPdf") },
                          { type: "divider" },
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
                          if (key === "markdown" || key === "pdf")
                            void exportChat(chat.id, key);
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
        ) : null}
        {searching && settled && found.data.capped ? (
          <p className="small ask-panel-empty">
            {t("ask.searchCapped", { count: found.data.hits.length })}
          </p>
        ) : null}
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
