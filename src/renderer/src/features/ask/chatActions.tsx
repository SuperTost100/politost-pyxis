import { useQueryClient } from "@tanstack/react-query";
import { App, Modal } from "antd";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMatch, useNavigate } from "react-router";
import { invoke } from "../../lib/ipc";
import { textBase64 } from "../share/ExportButton";
import { draftKey, writePendingFiles } from "./attachments";
import { runsIn, turns } from "./turns";

export type ChatRef = { id: string; title: string | null };

/**
 * A chat's actions wherever a chat is listed: rename in place, export as Markdown or PDF, delete after asking. The
 * menu is the system's own context menu, from a right-click on the row or its "…" button. Render `dialog` once.
 */
export function useChatActions() {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const client = useQueryClient();
  const navigate = useNavigate();
  const open = useMatch("/ask/:chatId")?.params.chatId;
  const [renaming, setRenamingState] = useState<{ id: string; title: string } | null>(null);
  // Enter and the blur it causes both save. Each reads the draft here and empties it, so only the first one saves.
  const draft = useRef<{ id: string; title: string } | null>(null);
  const setRenaming = (next: { id: string; title: string } | null) => {
    draft.current = next;
    setRenamingState(next);
  };
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const exporting = useRef(false);
  const nameOf = (chat: ChatRef) => chat.title?.trim() || t("ask.untitled");

  async function saveRename(previous: string | null) {
    const current = draft.current;
    setRenaming(null);
    if (!current) return;
    const title = current.title.trim();
    if (!title || title === previous) return;
    try {
      await invoke("chats.rename", { chatId: current.id, title });
    } catch {
      void message.error(t("ask.renameFailed"));
    }
    void client.invalidateQueries({ queryKey: ["chats"] });
  }

  async function exportChat(id: string, format: "markdown" | "pdf") {
    if (exporting.current) return;
    exporting.current = true;
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
      exporting.current = false;
    }
  }

  /** Opens the chat's menu and acts on the pick, which it returns. */
  async function openMenu(chat: ChatRef): Promise<string | null> {
    const picked = await window.pyxis.contextMenu([
      { id: "rename", label: t("ask.rename") },
      { id: "markdown", label: t("ask.exportMarkdown") },
      { id: "pdf", label: t("ask.exportPdf") },
      null,
      { id: "delete", label: t("ask.delete") },
    ]);
    if (picked === "rename") setRenaming({ id: chat.id, title: chat.title ?? "" });
    if (picked === "markdown" || picked === "pdf") void exportChat(chat.id, picked);
    // Deleting asks first, in Pyxis's own dialog: a system menu can't mark the item red.
    if (picked === "delete") setDeleting({ id: chat.id, title: nameOf(chat) });
    return picked;
  }

  async function confirmDelete() {
    const target = deleting;
    if (!target || removing) return;
    setRemoving(true);
    try {
      await invoke("chats.delete", { chatId: target.id });
      // A reply still being written for it stops, and its saved draft and files go with it.
      sessionStorage.removeItem(draftKey(target.id));
      writePendingFiles(sessionStorage, target.id, []);
      const running = turns.get();
      if (running && runsIn(running, target.id)) {
        running.dropped = true;
        running.stop();
      }
      setDeleting(null);
      if (target.id === open) navigate("/ask");
    } catch {
      void message.error(t("ask.deleteFailed"));
    } finally {
      setRemoving(false);
      void client.invalidateQueries({ queryKey: ["chats"] });
    }
  }

  const dialog: ReactNode = (
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
  );

  return {
    nameOf,
    openMenu,
    dialog,
    /** The row being renamed and its field's props, or null. */
    editing: (chat: ChatRef) =>
      renaming?.id === chat.id
        ? {
            value: renaming.title,
            onChange: (title: string) => setRenaming({ id: chat.id, title }),
            save: () => void saveRename(chat.title),
            cancel: () => setRenaming(null),
          }
        : null,
  };
}

export type ChatActions = ReturnType<typeof useChatActions>;

/** The field a chat row turns into while it is renamed. Enter or leaving it saves, Esc cancels. */
export function RenameField({
  edit,
  label,
}: {
  edit: NonNullable<ReturnType<ChatActions["editing"]>>;
  label: string;
}) {
  return (
    <input
      autoFocus
      className="px-rename"
      aria-label={label}
      maxLength={80}
      value={edit.value}
      onFocus={(event) => event.target.select()}
      onChange={(event) => edit.onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") edit.save();
        if (event.key === "Escape") {
          event.stopPropagation();
          edit.cancel();
        }
      }}
      onBlur={() => edit.save()}
    />
  );
}
