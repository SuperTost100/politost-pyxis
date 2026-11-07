import { ArrowRight, BookOpen, FileText, Folder, Lock } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { FreeBooks } from "../../components/FreeBooks";
import { useSources } from "../../lib/queries";
import { LibraryPanel } from "../home/LibraryPanel";

/**
 * The last step of first setup: files or a folder go into the Library with the Library's own import, which copies them
 * into Pyxis and leaves the originals alone. A free PoliTost book goes in the same way. What came in is listed below the
 * choices, and the page's button then starts studying. Nothing here needs an exam: exams are made later from Esami.
 */
export function MaterialStep({
  added,
  onAdded,
}: {
  /** Sources added in this step, oldest first. */
  added: string[];
  onAdded: (sourceIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const sources = useSources(added.length > 0);
  const [importing, setImporting] = useState<{
    tab: "file" | "folder";
    dropped?: File[];
  } | null>(null);
  const [books, setBooks] = useState(false);
  const [dragging, setDragging] = useState(false);
  const filesTitle = useId();
  const filesBody = useId();
  const folderTitle = useId();
  const folderBody = useId();
  const list = added
    .map((id) => sources.data?.find((source) => source.id === id))
    .filter((source) => source !== undefined);
  const reading = list.some((source) => source.status !== "ready");

  return (
    <>
      <div className="px-material-choices">
        {/* The whole card is the button's target, and a drop anywhere on it imports the files. */}
        <div
          className={
            dragging ? "px-material-choice is-dragging" : "px-material-choice"
          }
          onDragEnter={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const files = Array.from(event.dataTransfer.files);
            if (files.length) setImporting({ tab: "file", dropped: files });
          }}
        >
          <h2 className="px-material-title" id={filesTitle}>
            <button
              type="button"
              className="px-material-pick"
              aria-describedby={filesBody}
              onClick={() => setImporting({ tab: "file" })}
            >
              {t("onboarding.material.files.title")}
            </button>
            <ArrowRight size={18} aria-hidden />
          </h2>
          <span className="px-material-tree" aria-hidden>
            {(["one", "two", "three", "four"] as const).map((key) => (
              <span key={key}>
                <FileText size={16} />
                {t(`onboarding.material.files.example.${key}`)}
              </span>
            ))}
          </span>
          <p className="px-material-body" id={filesBody}>
            {dragging
              ? t("sources.dropActive")
              : t("onboarding.material.files.body")}
          </p>
        </div>
        <div className="px-material-choice">
          <h2 className="px-material-title" id={folderTitle}>
            <button
              type="button"
              className="px-material-pick"
              aria-describedby={folderBody}
              onClick={() => setImporting({ tab: "folder" })}
            >
              {t("onboarding.material.folder.title")}
            </button>
            <ArrowRight size={18} aria-hidden />
          </h2>
          <span className="px-material-tree" aria-hidden>
            <span className="is-head">
              <Folder size={16} />
              {t("onboarding.material.folder.example.folder")}
            </span>
            {(["one", "two", "three"] as const).map((key) => (
              <span key={key} className="is-sub">
                <FileText size={16} />
                {t(`onboarding.material.folder.example.${key}`)}
              </span>
            ))}
          </span>
          <p className="px-material-body" id={folderBody}>
            {t("onboarding.material.folder.body")}
          </p>
        </div>
      </div>
      <p className="small px-material-copy">
        <Lock size={15} aria-hidden />
        {t("onboarding.material.copy")}
      </p>
      <p className="small px-material-books">
        <button
          type="button"
          className="px-material-books-link"
          onClick={() => setBooks(true)}
        >
          <BookOpen size={16} aria-hidden />
          {t("books.open")}
        </button>
      </p>
      {list.length ? (
        <section
          className="px-material-added px-grow"
          aria-labelledby={`${filesTitle}-added`}
        >
          <h2 className="title-3" id={`${filesTitle}-added`}>
            {t("onboarding.material.added", { count: list.length })}
          </h2>
          <ul>
            {list.map((source) => (
              <li key={source.id}>
                <FileText size={16} aria-hidden />
                <span>{source.title}</span>
              </li>
            ))}
          </ul>
          {reading ? (
            <p className="small px-onboarding-note">
              {t("onboarding.material.reading")}
            </p>
          ) : null}
        </section>
      ) : null}
      {importing ? (
        <LibraryPanel
          importOnly
          tab={importing.tab}
          droppedFiles={importing.dropped}
          onClose={() => setImporting(null)}
          onImported={onAdded}
        />
      ) : null}
      <FreeBooks
        open={books}
        added={added}
        onClose={() => setBooks(false)}
        onAdded={(book) => onAdded([book.sourceId])}
      />
    </>
  );
}
