import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import { Button } from "../../components/Button";
import { FileCover } from "../../components/FileCover";
import { Logo } from "../../components/Logo";
import "./BookOffer.css";

type Book = RequestOutput<"sources.books">[number];

/**
 * The quiet row at the foot of a subject's shelf when a free PoliTost book is about that subject and the student does
 * not have it. It says so once, lets them read the book first, add it, or dismiss the row for this subject.
 */
export function BookOffer({
  book,
  colour,
  subjectName,
  adding,
  error,
  onOpen,
  onAdd,
  onHide,
}: {
  book: Book;
  colour: number;
  subjectName: string;
  adding: boolean;
  /** The message key of an add that failed. */
  error?: string;
  onOpen: () => void;
  onAdd: () => void;
  onHide: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <div className="px-book-offer" role="group" aria-labelledby={titleId} data-book-offer={book.id}>
      <span className="px-book-offer-art">
        <FileCover kind="book" colour={colour} symbol={subjectName} scale={0.5} />
      </span>
      <div className="px-book-offer-text">
        <p id={titleId} className="body-strong">
          {t("books.offer.title")}
        </p>
        <p className="small ink-muted">
          {t("books.offer.body", { title: book.title, chapters: t("books.chapters", { count: book.chapters }) })}
        </p>
        {error ? (
          <p className="small px-book-offer-error" role="alert">
            {t(error)}
          </p>
        ) : null}
      </div>
      {adding ? (
        <p className="small px-book-offer-working" role="status">
          <Logo working decorative size={16} />
          {t("books.downloading")}
        </p>
      ) : (
        <div className="px-book-offer-actions">
          <Button variant="secondary" size="sm" aria-label={t("books.openBookNamed", { title: book.title })} onClick={onOpen}>
            {t("books.openBook")}
          </Button>
          <Button variant="secondary" size="sm" aria-label={t("books.addNamed", { title: book.title })} onClick={onAdd}>
            {t("books.add")}
          </Button>
          <Button variant="ghost" size="sm" aria-label={t("books.offer.hideNamed", { title: book.title })} onClick={onHide}>
            {t("books.offer.hide")}
          </Button>
        </div>
      )}
    </div>
  );
}
