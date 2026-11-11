import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { isCloze } from "../../../core/study/cloze";
import { CitationChip } from "./CitationChip";
import { IconButton } from "./IconButton";
import { openSourceViewer } from "./SourceViewer";
import "./ProposedCards.css";

/** A flashcard Pyxis proposed, while the student checks it. `key` stays the same while the list changes. */
export type ProposedRow = { key: number; front: string; back: string; passageId: string | null };

/**
 * The flashcards Pyxis wrote, to check before they are saved: each one editable, with its source and a button that
 * drops it. A dropped card shrinks in place and the gap closes after it; focus moves to the next card's button. Shared by
 * the dialog that makes flashcards from a selection, an answer or a map, and the new-flashcard dialog.
 */
export function ProposedCards({
  rows,
  disabled,
  idPrefix,
  onChange,
  onDrop,
  onEmptied,
}: {
  rows: ProposedRow[];
  disabled?: boolean;
  /** Makes the field ids `<idPrefix>-front-<key>` and `<idPrefix>-back-<key>`. */
  idPrefix: string;
  onChange: (key: number, patch: Partial<Pick<ProposedRow, "front" | "back">>) => void;
  onDrop: (key: number) => void;
  /** The last card was dropped: the dialog puts the focus somewhere that stays. */
  onEmptied?: () => void;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLOListElement>(null);
  const leaving = useRef(new Set<number>());

  function drop(key: number, item: HTMLElement) {
    if (leaving.current.has(key)) return;
    leaving.current.add(key);
    // Focus goes to the next card's drop button, or the one before, so the keyboard stays in the list.
    const items = [...(list.current?.querySelectorAll<HTMLElement>(":scope > li") ?? [])];
    const at = items.indexOf(item);
    const next = items[at + 1] ?? items[at - 1];
    const done = () => {
      leaving.current.delete(key);
      onDrop(key);
      requestAnimationFrame(() => {
        if (next) next.querySelector<HTMLElement>(".px-pc-drop button")?.focus();
        else onEmptied?.();
      });
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return done();
    // It fades where it is, then the gap closes (motion.md, "An item removed").
    const height = item.offsetHeight;
    item.style.overflow = "hidden";
    item.animate(
      [
        { opacity: 1, height: `${height}px` },
        { opacity: 0, height: `${height}px`, offset: 0.5 },
        { opacity: 0, height: "0px", paddingTop: "0px", paddingBottom: "0px" },
      ],
      { duration: 420, easing: "cubic-bezier(0.77, 0, 0.175, 1)" },
    ).onfinish = done;
  }

  return (
    <ol className="px-pc-list" aria-label={t("makeCards.listLabel")} ref={list}>
      {rows.map((row, index) => (
        <li key={row.key} className="px-pc-card">
          <div className="px-pc-head">
            <span className="label">{t("makeCards.cardN", { n: index + 1 })}</span>
            {row.passageId ? (
              <CitationChip onClick={() => openSourceViewer({ passageId: row.passageId ?? undefined })}>
                {t("makeCards.source")}
              </CitationChip>
            ) : null}
            <span className="px-pc-spacer" />
            <span className="px-pc-drop">
              <IconButton
                icon="x"
                variant="ghost"
                size="sm"
                label={t("makeCards.drop", { n: index + 1 })}
                disabled={disabled}
                onClick={() => {
                  const item = list.current?.children[index] as HTMLElement | undefined;
                  if (item) drop(row.key, item);
                }}
              />
            </span>
          </div>
          <label className="small px-pc-face" htmlFor={`${idPrefix}-front-${row.key}`}>
            {t("makeCards.front")}
          </label>
          <textarea
            id={`${idPrefix}-front-${row.key}`}
            className="px-pc-field"
            rows={1}
            value={row.front}
            disabled={disabled}
            onChange={(event) => onChange(row.key, { front: event.target.value })}
          />
          {isCloze(row.front) ? (
            <p className="small px-pc-cloze">{t("makeCards.cloze", { markup: "{{c1::…}}" })}</p>
          ) : null}
          <label className="small px-pc-face" htmlFor={`${idPrefix}-back-${row.key}`}>
            {t("makeCards.back")}
          </label>
          <textarea
            id={`${idPrefix}-back-${row.key}`}
            className="px-pc-field"
            rows={1}
            value={row.back}
            disabled={disabled}
            onChange={(event) => onChange(row.key, { back: event.target.value })}
          />
        </li>
      ))}
    </ol>
  );
}
