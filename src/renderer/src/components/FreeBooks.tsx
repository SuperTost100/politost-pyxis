import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Modal } from "antd";
import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import { invoke } from "../lib/ipc";
import { Notice } from "./Notice";
import "./FreeBooks.css";
import { formatBytes } from "@shared/format-bytes";

type Book = RequestOutput<"sources.books">[number];
export type AddedBook = { sourceId: string; title: string; subject: string };

function errorKey(err: unknown): string {
  return err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "sources.books.offline";
}

/**
 * The free books list, with each book's library source and whether a newer version can update it. Under "sources",
 * so a change to the library (an import, a removal, an update) reads it again; core keeps the catalog for a few
 * minutes, so that does not ask books.politost.it each time. Only enabled while the list or the Library is open.
 */
export function useFreeBooks(enabled: boolean) {
  return useQuery({
    queryKey: ["sources", "free-books"],
    queryFn: () => invoke("sources.books", {}),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/**
 * Updates a free book in place. A book that plans use asks first, as Replace does. Resolves with the version being
 * installed, or null when the student declined. Errors are thrown to the caller, which shows them where it acted.
 */
export function useBookUpdate() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  async function update(sourceId: string): Promise<string | null> {
    setBusy(sourceId);
    try {
      let result = await invoke("sources.updateBook", {
        sourceId,
        confirmed: false,
      });
      if (!result.started && result.inUse > 0) {
        if (!window.confirm(t("books.updateInUse", { count: result.inUse })))
          return null;
        result = await invoke("sources.updateBook", {
          sourceId,
          confirmed: true,
        });
      }
      void client.invalidateQueries({ queryKey: ["sources"] });
      return result.started ? (result.version ?? null) : null;
    } finally {
      setBusy(null);
    }
  }
  return { update, busy };
}

/**
 * The free PoliTost smartbooks from books.politost.it. Pyxis reads the list only while this dialog is open. Adding a
 * book downloads it, checks it against the catalog and imports it; a book already in the library is not downloaded
 * again. `added` lists the source ids the caller already holds, such as the sources of the exam being created.
 */
export function FreeBooks({
  open,
  onClose,
  onAdded,
  added = [],
}: {
  open: boolean;
  onClose: () => void;
  onAdded?: (book: AddedBook) => void;
  added?: string[];
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const books = useFreeBooks(open);
  const updater = useBookUpdate();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; key: string } | null>(
    null,
  );
  // Sources added while the dialog is open, so the row says so before the list reloads.
  const [done, setDone] = useState<Record<string, string>>({});
  // Once the list reloads it says which books are in the library, including one removed since it was added here.
  useEffect(() => setDone({}), [books.dataUpdatedAt]);

  async function add(book: Book) {
    setBusy(book.id);
    setFailed(null);
    try {
      const result = await invoke("sources.importBook", { id: book.id });
      setDone((current) => ({ ...current, [book.id]: result.sourceId }));
      onAdded?.(result);
      void client.invalidateQueries({ queryKey: ["sources"] });
    } catch (err) {
      setFailed({ id: book.id, key: errorKey(err) });
    } finally {
      setBusy(null);
    }
  }

  async function update(book: Book) {
    if (!book.sourceId) return;
    setFailed(null);
    try {
      await updater.update(book.sourceId);
    } catch (err) {
      setFailed({ id: book.id, key: errorKey(err) });
    }
  }

  const size = (bytes: number) => formatBytes(bytes, i18n.language);

  function action(book: Book) {
    const sourceId = done[book.id] ?? book.sourceId;
    const working = busy !== null || updater.busy !== null;
    if (sourceId && book.update === "running")
      return (
        <span className="small px-books-state">
          <LoaderCircle size={14} aria-hidden />
          {t("books.updating")}
        </span>
      );
    // A newer version updates the copy in the library. A caller that still needs the book can add the copy as it is.
    if (sourceId && book.update === "available")
      return (
        <span className="px-books-actions">
          {onAdded && !added.includes(sourceId) ? addButton(book) : null}
          <Button
            shape="round"
            type="primary"
            loading={updater.busy === sourceId}
            disabled={working && updater.busy !== sourceId}
            aria-label={t(
              updater.busy === sourceId ? "books.updatingNamed" : "books.updateNamed",
              { title: book.title },
            )}
            onClick={() => void update(book)}
          >
            {updater.busy === sourceId ? t("books.adding") : t("books.update")}
          </Button>
        </span>
      );
    // In the library already. Without a caller to add it to, there is nothing to do.
    if (sourceId && (!onAdded || added.includes(sourceId)))
      return (
        <span className="small px-books-state">
          <Check size={14} aria-hidden />
          {t(onAdded ? "books.added" : "books.inLibrary")}
        </span>
      );
    return addButton(book);
  }

  function addButton(book: Book) {
    return (
      <Button
        shape="round"
        loading={busy === book.id}
        disabled={
          (busy !== null && busy !== book.id) || updater.busy !== null
        }
        aria-label={t(busy === book.id ? "books.addingNamed" : "books.addNamed", {
          title: book.title,
        })}
        onClick={() => void add(book)}
      >
        {busy === book.id ? t("books.adding") : t("books.add")}
      </Button>
    );
  }

  return (
    <Modal
      open={open}
      width={600}
      title={t("books.title")}
      footer={null}
      onCancel={onClose}
      className="px-books"
    >
      <p className="small px-books-intro">{t("books.intro")}</p>
      {books.isPending ? (
        <p className="body" role="status">
          {t("books.loading")}
        </p>
      ) : null}
      {books.isError ? (
        <Notice
          tone="danger"
          action={{
            label: t("books.retry"),
            onClick: () => void books.refetch(),
          }}
        >
          {t(errorKey(books.error))}
        </Notice>
      ) : null}
      {books.isSuccess && books.data.length === 0 ? (
        <p className="body" role="status">
          {t("books.empty")}
        </p>
      ) : null}
      {books.isSuccess && books.data.length > 0 ? (
        <ul className="px-books-list" aria-label={t("books.title")}>
          {books.data.map((book) => (
            <li key={book.id} className="px-books-row">
              <div className="px-books-text">
                <span className="body-strong">{book.title}</span>
                <span className="meta px-books-meta">
                  {[
                    book.subject,
                    t("books.chapters", { count: book.chapters }),
                    size(book.bytes),
                    t("books.version", { version: book.version }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {book.sourceId && book.update === "available" ? (
                  <span className="small px-books-new">
                    {t("books.newVersion")}
                  </span>
                ) : null}
                {failed?.id === book.id ? (
                  <span className="small px-books-error" role="alert">
                    {t(failed.key)}
                  </span>
                ) : null}
              </div>
              {action(book)}
            </li>
          ))}
        </ul>
      ) : null}
    </Modal>
  );
}
