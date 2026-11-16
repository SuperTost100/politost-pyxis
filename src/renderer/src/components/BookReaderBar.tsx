import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { addBook, subjectForBook, useBookAdding } from "../lib/bookAdding";
import { useSources, useSubjects } from "../lib/queries";
import { Button } from "./Button";
import { useFreeBooks } from "../lib/freeBooks";
import { Logo } from "./Logo";
import { openSourceViewer, type FocusAfter } from "./SourceViewer";
import "./BookReaderBar.css";

/**
 * Opens the source reader on a free book that may not be in the Library yet. Under its head the reader says whether the
 * book is in the Library and, when it is not, adds it. `subjectId` is the shelf an add puts it on: the subject whose row
 * opened it; without one the subject is found by name. `focusAfter` says where the focus goes when the reader closes and
 * the row that opened it is gone, as it is once the book is added from the reader.
 */
export function openBook(bookId: string, options: { subjectId?: string; choice?: BookChoice; focusAfter?: FocusAfter } = {}): void {
  const { choice, focusAfter } = options;
  openSourceViewer(
    { bookId },
    {
      bar: () => (choice ? <ChoiceBookBar choice={choice} /> : <LibraryBookBar bookId={bookId} subjectId={options.subjectId} />),
      focusAfter,
    },
  );
}

/**
 * A book the student has ticked to come along with something else, an exam's sources or a subject's first file. The reader
 * says whether it is ticked and toggles it. `on` is read each time the reader draws; call `refreshSourceViewer` when the
 * tick changes elsewhere.
 */
export type BookChoice = {
  words: "exam" | "subject";
  on: () => boolean;
  set: (on: boolean) => void;
  /** What the choice is for is being made, so the choice no longer changes: the reader says so and takes it away. */
  locked: () => boolean;
};

function ChoiceBookBar({ choice }: { choice: BookChoice }) {
  const { t } = useTranslation();
  const on = choice.on();
  const locked = choice.locked();
  return (
    <div className={on ? "px-book-bar is-in" : "px-book-bar"}>
      <p className="px-book-bar-text" role="status">
        {on ? <Check size={15} aria-hidden /> : null}
        <span>{t(`books.choice.${choice.words}${locked ? "Locked" : ""}${on ? "In" : "Out"}`)}</span>
      </p>
      <Button size="sm" variant={on ? "secondary" : "primary"} disabled={locked} onClick={() => choice.set(!on)}>
        {t(`books.choice.${choice.words}${on ? "Remove" : "Add"}`)}
      </Button>
    </div>
  );
}

/** The row under the reader's head for a free book. After an add the reader stays open and says where the book went. */
function LibraryBookBar({ bookId, subjectId }: { bookId: string; subjectId?: string }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const books = useFreeBooks(true);
  const sources = useSources();
  const subjects = useSubjects();
  const state = useBookAdding();
  const book = books.data?.find((item) => item.id === bookId);
  const sourceId = book?.sourceId ?? null;
  const adding = state.adding.has(bookId);
  const failed = state.failed.get(bookId);
  const source = sourceId ? sources.data?.find((item) => item.id === sourceId) : undefined;
  const where = !source
    ? t("books.reader.inLibrary")
    : source.subject
      ? t("books.reader.inShelf", { subject: source.subject })
      : t("books.reader.inUnsorted");
  // Until the catalog answers, the reader has nothing to add: it can read the book from the address alone.
  const target = subjectId ?? (book ? subjectForBook(subjects.data ?? [], book) : undefined);
  // The add button goes when the book is in the Library, and with it the focus; the line that says where the book went
  // takes it, so the reader still hears Escape.
  const text = useRef<HTMLParagraphElement>(null);
  const added = useRef(false);
  useEffect(() => {
    if (!sourceId || !added.current) return;
    added.current = false;
    const active = document.activeElement;
    // Only a focus that is lost moves; one the student put somewhere else in the meantime stays there.
    if (!active || active === document.body) text.current?.focus({ preventScroll: true });
  }, [sourceId]);
  return (
    <div className={sourceId ? "px-book-bar is-in" : "px-book-bar"}>
      <p className="px-book-bar-text" role="status" ref={text} tabIndex={-1}>
        {sourceId ? <Check size={15} aria-hidden /> : null}
        <span>{sourceId ? where : t("books.reader.notInLibrary")}</span>
      </p>
      {!sourceId && book ? (
        <Button
          size="sm"
          disabled={adding}
          onClick={() => {
            added.current = true;
            void addBook(client, bookId, { subjectId: target }).then((result) => {
              if (!result) added.current = false;
            });
          }}
        >
          {adding ? <Logo working decorative size={14} /> : null}
          {t(adding ? "books.adding" : "books.reader.addToLibrary")}
        </Button>
      ) : null}
      {failed ? (
        <p className="small px-book-bar-error" role="alert">
          {t(failed)}
        </p>
      ) : null}
    </div>
  );
}
