import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import { coverColour } from "../features/home/shelf";
import { Button } from "./Button";
import { FileCover } from "./FileCover";
import "./BookChoiceRow.css";

type Book = RequestOutput<"sources.books">[number];

/**
 * A free PoliTost book offered as a ticked source: ticked unless the student leaves it out, with "Apri il libro" to read it
 * first. Ticking downloads nothing; the book is downloaded when what it comes with is made.
 */
export function BookChoiceRow({
  book,
  on,
  busy = false,
  onToggle,
  onOpen,
}: {
  book: Book;
  on: boolean;
  /** The book is downloading as part of what the student just confirmed. */
  busy?: boolean;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="px-book-choice" data-book-choice={book.id}>
      <label className="px-book-choice-pick">
        <input type="checkbox" checked={on} disabled={busy} onChange={(event) => onToggle(event.target.checked)} />
        <span className="px-book-choice-art">
          <FileCover kind="book" colour={coverColour(book.id)} symbol={book.subject || book.title} scale={0.5} />
        </span>
        <span className="px-book-choice-text">
          <span className="body-strong">{t("books.choice.name", { title: book.title })}</span>
          <span className="small ink-muted">
            {t("books.choice.lead", { chapters: t("books.chapters", { count: book.chapters }) })}
          </span>
        </span>
      </label>
      <Button variant="secondary" size="sm" aria-label={t("books.openBookNamed", { title: book.title })} onClick={onOpen}>
        {t("books.openBook")}
      </Button>
    </div>
  );
}
