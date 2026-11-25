import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { MathText } from "../../components/math/MathText";
import { plainReading, outlineLeft, type OutlineMark } from "./outline";
import "./ConversationOutline.css";

/**
 * Short marks along the left edge of the chat pane beside the sidebar, one per question. The part in view has the
 * longer, darker mark. Pointer hover or keyboard focus on a mark shows a card to its right with the question and the
 * start of its answer, and a click or Enter jumps there. The marks are one Tab stop, and arrow keys move between them.
 */
export function ConversationOutline({
  marks,
  current,
  onJump,
}: {
  marks: readonly OutlineMark[];
  /** The index in `marks` of the part in view. */
  current: number;
  onJump: (mark: OutlineMark) => void;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLUListElement>(null);
  // Where the Tab stop is: the mark last focused, else the one in view.
  const [stop, setStop] = useState<number | null>(null);
  // The card is drawn beside the marks, outside their scrolling list, at the height of the mark it belongs to.
  const [card, setCard] = useState<{ index: number; top: number } | null>(null);
  const nav = useRef<HTMLElement>(null);
  const showCard = (index: number, button: HTMLElement) => {
    const at = button.getBoundingClientRect();
    const box = nav.current?.getBoundingClientRect();
    if (box) setCard({ index, top: at.top + at.height / 2 - box.top });
  };
  const [left, setLeft] = useState<number | null>(null);

  // The marks sit along the left edge of the chat pane, beside the sidebar, when there is room left of the answer column.
  useLayoutEffect(() => {
    const pane = document.querySelector(".ask-page");
    const composer = document.querySelector(".ask-dock .px-composer");
    const place = () => {
      const paneLeft = (pane ?? document.querySelector(".ask-page"))?.getBoundingClientRect().left;
      const columnLeft = (composer ?? document.querySelector(".ask-dock .px-composer"))?.getBoundingClientRect().left;
      setLeft(outlineLeft(paneLeft, columnLeft));
    };
    place();
    window.addEventListener("resize", place);
    const watch = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    watch?.observe(document.body);
    if (pane) watch?.observe(pane);
    if (composer) watch?.observe(composer);
    return () => {
      window.removeEventListener("resize", place);
      watch?.disconnect();
    };
  }, []);

  useEffect(() => setStop((now) => (now !== null && now >= marks.length ? null : now)), [marks.length]);

  // A list taller than the window scrolls inside itself, and follows the part in view.
  useEffect(() => {
    const box = list.current;
    const mark = box?.querySelectorAll<HTMLElement>("li")[current];
    if (!box || !mark || box.scrollHeight <= box.clientHeight) return;
    box.scrollTop = mark.offsetTop - box.clientHeight / 2 + mark.offsetHeight / 2;
  }, [current, marks.length, left]);

  if (left === null) return null;
  const tabbable = stop ?? Math.max(0, current);

  function focusMark(index: number) {
    const next = Math.max(0, Math.min(marks.length - 1, index));
    setStop(next);
    list.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const at = Number((event.target as HTMLElement).dataset.index);
    if (Number.isNaN(at)) return;
    const move: Record<string, number> = {
      ArrowUp: at - 1,
      ArrowDown: at + 1,
      Home: 0,
      End: marks.length - 1,
    };
    if (!(event.key in move)) return;
    event.preventDefault();
    focusMark(move[event.key]!);
  }

  return (
    <nav ref={nav} className="ask-outline" style={{ left, "--marks": marks.length } as CSSProperties} aria-label={t("ask.outline.label")}>
      <ul ref={list} onKeyDown={onKeyDown}>
        {marks.map((mark, index) => (
          <li key={mark.id}>
            <button
              type="button"
              data-index={index}
              tabIndex={index === tabbable ? 0 : -1}
              aria-current={index === current ? "true" : undefined}
              aria-label={t("ask.outline.mark", { number: index + 1, total: marks.length, question: plainReading(mark.question) })}
              onClick={() => onJump(mark)}
              onPointerEnter={(event) => event.pointerType === "mouse" && showCard(index, event.currentTarget)}
              onPointerLeave={() => setCard(null)}
              onFocus={(event) => {
                setStop(index);
                if (event.currentTarget.matches(":focus-visible")) showCard(index, event.currentTarget);
              }}
              onBlur={() => setCard(null)}
            >
              <i />
            </button>
          </li>
        ))}
      </ul>
      {card ? (
        <div className="ask-outline-card" style={{ top: card.top }} aria-hidden>
          <small>{t("ask.outline.card", { number: card.index + 1, total: marks.length })}</small>
          <b>
            <MathText text={marks[card.index]!.question} />
          </b>
          {marks[card.index]!.answer ? (
            <p>
              <InlineMarkdown>{marks[card.index]!.answer}</InlineMarkdown>
            </p>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
