import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { Reveal } from "../../components/Controls";
import { Icon } from "../../components/Icon";
import { Logo } from "../../components/Logo";
import type { Given } from "./quizSheet";
import "./QuizColumn.css";

/** One number of the Domande card. */
export type SheetItem = {
  id: string;
  given: Given;
  marked: boolean;
};

/** Where the Consegna confirmation opened from, so it grows out of that button and focus goes back to it. */
export type HandInFrom = "card" | "nav";

/**
 * The quiz in one column: the question on a white card, Indietro and Avanti
 * under it on its edges, and beside it the Domande card with every question's number and state and Consegna. The page
 * is the container the layout answers to, so when its own width is small (a narrow window, large text, zoom) the
 * Domande card becomes a strip over the question.
 */
export function QuizColumn({
  items,
  current,
  waiting = 0,
  loading = false,
  onJump,
  handIn,
  confirm,
  before,
  card,
  nav,
  hint,
  busyLine,
}: {
  items: SheetItem[];
  current: number;
  /** Questions still being written: drawn as numbers that cannot be opened yet. */
  waiting?: number;
  /** The attempt is being read from this computer: the numbers are drawn as their shapes. */
  loading?: boolean;
  onJump: (index: number) => void;
  handIn: {
    disabled: boolean;
    /** Why Consegna waits, under it, such as questions still being written. */
    note?: string;
    onRequest: (from: HandInFrom) => void;
  };
  /** The confirmation, open under the button that asked for it. */
  confirm?: { from: HandInFrom; content: ReactNode };
  /** Notices and errors about the whole quiz, above the question. */
  before?: ReactNode;
  card: ReactNode;
  nav?: ReactNode;
  hint?: string;
  /** Work going on for the quiz, such as questions still being written, with the working mark in the card. */
  busyLine?: string;
}) {
  const { t } = useTranslation();
  const given = items.filter((item) => item.given !== "none").length;
  const total = items.length + waiting;
  return (
    <div className="px-qz-page">
      <div className="px-qz">
        {before ? <div className="px-qz-before">{before}</div> : null}
        <div className="px-qz-card">{card}</div>
        {nav ? <div className="px-qz-nav">{nav}</div> : null}
        {confirm?.from === "nav" ? (
          <div className="px-qz-nav-confirm">
            <Reveal>{confirm.content}</Reveal>
          </div>
        ) : null}
        {hint ? <p className="px-qz-hint">{hint}</p> : null}
        {/* Last in the page's order, so Tab goes from the answers to Avanti before the numbers; the grid draws it beside. */}
        <aside className="px-qz-side" aria-labelledby="px-qz-side-title">
          <div className="px-qz-side-head">
            <h2 id="px-qz-side-title">{t("quiz.sheet.title")}</h2>
            {loading ? null : <span className="px-qz-count">{t("quiz.sheet.given", { count: given, total })}</span>}
          </div>
          <nav className="px-qz-nums" aria-label={t("quiz.sheet.nav")}>
            {items.map((item, index) => (
              <SheetNumber
                key={item.id}
                item={item}
                number={index + 1}
                current={index === current}
                onClick={() => onJump(index)}
              />
            ))}
            {loading
              ? Array.from({ length: 8 }, (_, index) => (
                  <span key={`loading-${index}`} className="px-qz-num is-loading" aria-hidden />
                ))
              : null}
            {Array.from({ length: waiting }, (_, index) => (
              <span key={`waiting-${index}`} className="px-qz-num is-waiting" aria-hidden>
                {items.length + index + 1}
              </span>
            ))}
          </nav>
          {busyLine ? (
            <p className="px-qz-busy" role="status">
              <Logo working decorative size={16} />
              {busyLine}
            </p>
          ) : null}
          <div className="px-qz-handin">
            <Button
              variant="secondary"
              block
              disabled={handIn.disabled}
              expanded={confirm ? confirm.from === "card" : undefined}
              title={handIn.note ?? t("quiz.sheet.blankNote")}
              onClick={() => handIn.onRequest("card")}
            >
              {t("quiz.sheet.handIn")}
            </Button>
            {confirm?.from === "card" ? <Reveal>{confirm.content}</Reveal> : null}
          </div>
          {/* The reason Consegna waits shows in every layout; the narrow strip drops only the standing note. */}
          <p className={handIn.note ? "px-qz-note is-reason" : "px-qz-note"}>{handIn.note ?? t("quiz.sheet.blankNote")}</p>
        </aside>
      </div>
    </div>
  );
}

function SheetNumber({
  item,
  number,
  current,
  onClick,
}: {
  item: SheetItem;
  number: number;
  current: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const state = [
    item.given === "answer" ? t("quiz.sheet.answered") : item.given === "dontKnow" ? t("quiz.sheet.dontKnow") : "",
    item.marked ? t("quiz.sheet.marked") : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      type="button"
      className={[
        "px-qz-num",
        item.given !== "none" && "is-given",
        item.marked && "is-marked",
        current && "is-current",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-current={current ? "step" : undefined}
      aria-label={state ? t("quiz.sheet.numberState", { number, state }) : t("quiz.sheet.number", { number })}
      onClick={onClick}
    >
      {number}
      {item.marked ? <Icon name="flag" size={15} strokeWidth={2.4} className="px-qz-flag" /> : null}
    </button>
  );
}

/**
 * What Consegna asks when something is blank or marked for later: how many, and that blank ones count as "Non lo so".
 * Focus starts on Consegna; Escape and "Torna alle domande" close it and give focus back to the button that opened it.
 */
export function HandInConfirm({
  blank,
  marked,
  busy,
  onConfirm,
  onCancel,
}: {
  blank: number;
  marked: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>(".px-btn-primary")?.focus();
  }, []);
  const parts = [
    blank ? t("quiz.sheet.confirmBlank", { count: blank }) : "",
    marked ? t("quiz.sheet.confirmMarked", { count: marked }) : "",
  ].filter(Boolean);
  return (
    <div
      ref={box}
      className="px-qz-confirm"
      role="group"
      aria-labelledby="px-qz-confirm-text"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <p id="px-qz-confirm-text">
        {t("quiz.sheet.confirm", { list: parts.join(t("quiz.sheet.confirmAnd")) })}
        {blank ? ` ${t("quiz.sheet.confirmBlankNote", { count: blank })}` : ""}
      </p>
      <div className="px-qz-confirm-actions">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("quiz.sheet.keepGoing")}
        </Button>
        <Button size="sm" disabled={busy} onClick={onConfirm}>
          {t("quiz.sheet.handIn")}
        </Button>
      </div>
    </div>
  );
}
