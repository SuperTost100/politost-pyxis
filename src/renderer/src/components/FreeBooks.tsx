import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Modal } from "antd";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import { invoke } from "../lib/ipc";
import { Notice } from "./Notice";
import "./FreeBooks.css";

type Book = RequestOutput<"sources.books">[number];
export type AddedBook = { sourceId: string; title: string; subject: string };

function errorKey(err: unknown): string {
  return err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "sources.books.offline";
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
  const books = useQuery({
    // Under "sources", so a change to the library (an import, a removal) also marks the list as out of date.
    queryKey: ["sources", "free-books"],
    queryFn: () => invoke("sources.books", {}),
    enabled: open,
    retry: false,
    staleTime: 5 * 60_000,
  });
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

  const size = (bytes: number) =>
    new Intl.NumberFormat(i18n.language, {
      style: "unit",
      unit: bytes >= 1e6 ? "megabyte" : "kilobyte",
      maximumFractionDigits: bytes >= 1e6 ? 1 : 0,
    }).format(bytes >= 1e6 ? bytes / 1e6 : Math.max(1, bytes / 1e3));

  function action(book: Book) {
    const sourceId = done[book.id] ?? book.sourceId;
    // In the library already. Without a caller to add it to, there is nothing to do.
    if (sourceId && (!onAdded || added.includes(sourceId)))
      return (
        <span className="small px-books-state">
          <Check size={14} aria-hidden />
          {t(onAdded ? "books.added" : "books.inLibrary")}
        </span>
      );
    return (
      <Button
        shape="round"
        loading={busy === book.id}
        disabled={busy !== null && busy !== book.id}
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
