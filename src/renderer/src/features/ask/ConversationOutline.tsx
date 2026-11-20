import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { OutlineMark } from "./outline";
import "./ConversationOutline.css";

/**
 * Short marks just outside the answer column, one per question. The part in view has the longer, darker mark. The pointer
 * or the keyboard focus on a mark shows a card with the question and the start of its answer, and a click or Enter
 * jumps there. The marks are one Tab stop: the arrows move between them.
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
  const [card, setCard] = useState<number | null>(null);
  const [left, setLeft] = useState<number | null>(null);

  // The marks sit just outside the composer's right edge, which is the answer column's.
  useLayoutEffect(() => {
    const place = () => {
      const edge = document.querySelector(".ask-dock .px-composer")?.getBoundingClientRect().right;
      setLeft(edge === undefined || window.innerWidth - edge < 40 ? null : Math.min(edge + 10, window.innerWidth - 40));
    };
    place();
    window.addEventListener("resize", place);
    const watch = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    watch?.observe(document.body);
    return () => {
      window.removeEventListener("resize", place);
      watch?.disconnect();
    };
  }, []);

  useEffect(() => setStop((now) => (now !== null && now >= marks.length ? null : now)), [marks.length]);

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
    <nav className="ask-outline" style={{ left, "--marks": marks.length } as CSSProperties} aria-label={t("ask.outline.label")}>
      <ul ref={list} onKeyDown={onKeyDown}>
        {marks.map((mark, index) => (
          <li key={mark.id}>
            <button
              type="button"
              data-index={index}
              tabIndex={index === tabbable ? 0 : -1}
              aria-current={index === current ? "true" : undefined}
              aria-label={t("ask.outline.mark", { number: index + 1, total: marks.length, question: mark.question })}
              onClick={() => onJump(mark)}
              onPointerEnter={(event) => event.pointerType === "mouse" && setCard(index)}
              onPointerLeave={() => setCard(null)}
              onFocus={(event) => {
                setStop(index);
                if (event.currentTarget.matches(":focus-visible")) setCard(index);
              }}
              onBlur={() => setCard(null)}
            >
              <i />
            </button>
            {card === index ? (
              <div className="ask-outline-card" aria-hidden>
                <small>{t("ask.outline.card", { number: index + 1, total: marks.length })}</small>
                <b>{mark.question}</b>
                {mark.answer ? <p>{mark.answer}</p> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </nav>
  );
}
