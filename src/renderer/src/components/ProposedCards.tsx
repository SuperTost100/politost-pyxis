import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isCloze } from "../../../core/study/cloze";
import { CitationChip } from "./CitationChip";
import { IconButton } from "./IconButton";
import { openSourceViewer } from "./SourceViewer";
import "./ProposedCards.css";

/**
 * A flashcard Pyxis proposed, while the student checks it. `key` stays the same while the list changes, and rises along
 * the list. `source` names where the card's passage comes from, when the reply knew.
 */
export type ProposedRow = {
  key: number;
  front: string;
  back: string;
  passageId: string | null;
  source?: { title: string; page: number | null } | null;
};

const EXIT_MS = 420;

/**
 * The flashcards Pyxis wrote, to check before they are saved: each one editable, with its source and a button that
 * drops it. A dropped card leaves `rows` at once, so it can no longer be saved; its place in the list shows a copy that
 * fades, then the gap closes after it. Focus moves to the next card's button. Shared by the dialog that makes flashcards
 * from a selection, an answer or a map, and the new-flashcard dialog, which keep it mounted while the dialog is in the
 * review step so the last card can leave the same way.
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
  /** The card is gone from the list: the dialog stops counting it, whatever the animation is still doing. */
  onDrop: (key: number) => void;
  /** The last card was dropped: the dialog puts the focus somewhere that stays. */
  onEmptied?: () => void;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLOListElement>(null);
  // Cards that left `rows` and are still fading out, with the number each had.
  const [leaving, setLeaving] = useState<Array<{ row: ProposedRow; n: number }>>([]);

  function drop(row: ProposedRow, n: number, item: HTMLElement) {
    // Focus goes to the next card's drop button, or the one before, so the keyboard stays in the list.
    const items = [...(list.current?.querySelectorAll<HTMLElement>(":scope > li:not([data-leaving])") ?? [])];
    const at = items.indexOf(item);
    const next = items[at + 1] ?? items[at - 1];
    if (next) next.querySelector<HTMLElement>(".px-pc-drop button")?.focus();
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      setLeaving((current) => [...current, { row, n }]);
    onDrop(row.key);
    if (!next && onEmptied) requestAnimationFrame(onEmptied);
  }

  // Cards in the order they were made: a leaving one keeps the place it had.
  const shown = [
    ...rows.map((row, index) => ({ row, n: index + 1, gone: false })),
    ...leaving.map(({ row, n }) => ({ row, n, gone: true })),
  ].sort((a, b) => a.row.key - b.row.key);
  if (!shown.length) return null;

  const card = (row: ProposedRow, n: number, gone: boolean): ReactNode => {
    const label = row.source
      ? row.source.page === null
        ? row.source.title
        : t("flashcards.sourcePage", { title: row.source.title, page: row.source.page })
      : t("makeCards.source");
    return (
      <>
        <div className="px-pc-head">
          <span className="label">{t("makeCards.cardN", { n })}</span>
          {row.passageId ? (
            <CitationChip onClick={() => openSourceViewer({ passageId: row.passageId ?? undefined })}>
              {/* Long names are cut with an ellipsis on screen; the whole name is the button's name and its tooltip. */}
              <span className="px-pc-source" title={label}>
                {label}
              </span>
            </CitationChip>
          ) : null}
          <span className="px-pc-spacer" />
          <span className="px-pc-drop">
            <IconButton
              icon="x"
              variant="ghost"
              size="sm"
              label={t("makeCards.drop", { n })}
              disabled={disabled || gone}
              onClick={() => {
                const item = list.current?.querySelector<HTMLElement>(`:scope > li[data-key="${row.key}"]`);
                if (item) drop(row, n, item);
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
          disabled={disabled || gone}
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
          disabled={disabled || gone}
          onChange={(event) => onChange(row.key, { back: event.target.value })}
        />
      </>
    );
  };

  return (
    <ol className="px-pc-list" aria-label={t("makeCards.listLabel")} ref={list}>
      {shown.map(({ row, n, gone }) =>
        gone ? (
          <Leaving key={row.key} onDone={() => setLeaving((current) => current.filter((item) => item.row.key !== row.key))}>
            {card(row, n, true)}
          </Leaving>
        ) : (
          <li key={row.key} className="px-pc-card" data-key={row.key}>
            {card(row, n, false)}
          </li>
        ),
      )}
    </ol>
  );
}

/** A card on its way out: it fades where it is, then the gap closes (motion.md, "An item removed"). Nothing in it works. */
function Leaving({ children, onDone }: { children: ReactNode; onDone: () => void }) {
  const item = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const node = item.current;
    if (!node) return;
    const height = node.offsetHeight;
    node.style.overflow = "hidden";
    const animation = node.animate(
      [
        { opacity: 1, height: `${height}px` },
        { opacity: 0, height: `${height}px`, offset: 0.5 },
        { opacity: 0, height: "0px", paddingTop: "0px", paddingBottom: "0px" },
      ],
      { duration: EXIT_MS, easing: "cubic-bezier(0.77, 0, 0.175, 1)", fill: "forwards" },
    );
    animation.onfinish = onDone;
    return () => animation.cancel();
    // The animation starts once, when the card starts to leave.
  }, []);
  return (
    <li ref={item} className="px-pc-card" data-leaving aria-hidden inert>
      {children}
    </li>
  );
}
