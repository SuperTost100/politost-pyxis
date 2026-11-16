import { useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { Check } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import { addBook, subjectForBook, useBookAdding } from "../lib/bookAdding";
import { bookErrorKey } from "../lib/bookErrors";
import { useBookUpdate, useFreeBooks } from "../lib/freeBooks";
import { useSubjects } from "../lib/queries";
import { openBook } from "./BookReaderBar";
import { Dialog } from "./Dialog";
import { Notice } from "./Notice";
import "./FreeBooks.css";
import { formatBytes } from "@shared/format-bytes";
import { Logo } from "./Logo";

type Book = RequestOutput<"sources.books">[number];
export type AddedBook = { sourceId: string; title: string; subject: string };

/**
 * The free PoliTost smartbooks from books.politost.it. Pyxis reads the list only while this dialog is open. A book the
 * student does not have opens in the reader before it is added. Adding a book downloads it, checks it against the
 * catalog and imports it; a book already in the library is not downloaded again. `added` lists the source ids the
 * caller already holds, such as the sources of the exam being created.
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
  const subjects = useSubjects();
  const updater = useBookUpdate();
  const adding = useBookAdding();
  const [failed, setFailed] = useState<{ id: string; key: string } | null>(null);
  // "Apri" closes the list and then opens the book beside the page, so the reader is not drawn over the list.
  const reading = useRef<string | null>(null);

  async function add(book: Book) {
    setFailed(null);
    // Added to the Library, the book goes on the shelf its name says; added for an exam, it only joins the exam.
    const result = await addBook(client, book.id, {
      subjectId: onAdded ? undefined : subjectForBook(subjects.data ?? [], book),
    });
    if (result) onAdded?.(result);
  }

  async function update(book: Book) {
    if (!book.sourceId) return;
    setFailed(null);
    try {
      await updater.update(book.sourceId);
    } catch (err) {
      setFailed({ id: book.id, key: bookErrorKey(err) });
    }
  }

  const size = (bytes: number) => formatBytes(bytes, i18n.language);

  function action(book: Book) {
    const sourceId = book.sourceId;
    const busy = adding.adding.has(book.id);
    const working = adding.adding.size > 0 || updater.busy !== null;
    if (sourceId && book.update === "running")
      return (
        <span className="small px-books-state">
          <Logo working decorative size={16} />
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
    return (
      <span className="px-books-actions">
        {sourceId || onAdded ? null : (
          <Button
            shape="round"
            type="text"
            disabled={busy}
            aria-label={t("books.openShortNamed", { title: book.title })}
            onClick={() => {
              reading.current = book.id;
              onClose();
            }}
          >
            {t("books.openShort")}
          </Button>
        )}
        {addButton(book)}
      </span>
    );
  }

  function addButton(book: Book) {
    const busy = adding.adding.has(book.id);
    return (
      <Button
        shape="round"
        loading={busy}
        disabled={(adding.adding.size > 0 && !busy) || updater.busy !== null}
        aria-label={t(busy ? "books.addingNamed" : "books.addNamed", {
          title: book.title,
        })}
        onClick={() => void add(book)}
      >
        {busy ? t("books.adding") : t("books.add")}
      </Button>
    );
  }

  return (
    // The list has no action of its own: each book has its own button, so the dialog only closes.
    <Dialog open={open} width="md" title={t("books.title")} cancel={t("dialog.close")} onClose={onClose}
      onClosed={() => {
        const id = reading.current;
        reading.current = null;
        if (id) openBook(id);
      }}
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
          {t(bookErrorKey(books.error))}
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
                {(failed?.id === book.id ? failed.key : adding.failed.get(book.id)) ? (
                  <span className="small px-books-error" role="alert">
                    {t((failed?.id === book.id ? failed.key : adding.failed.get(book.id)) ?? "")}
                  </span>
                ) : null}
              </div>
              {action(book)}
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}
