import katex from "katex";
import { ArrowLeft, ArrowRight, Delete } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { MATH_TABS } from "./keys";
import "katex/dist/katex.min.css";
import "./FormulaPanel.css";

const rendered = new Map<string, string>();
function glyphHtml(latex: string): string {
  let html = rendered.get(latex);
  if (html === undefined) {
    html = katex.renderToString(latex, {
      throwOnError: false,
      output: "html",
      strict: "ignore",
    });
    rendered.set(latex, html);
  }
  return html;
}

export type FormulaCommand = "moveToPreviousChar" | "moveToNextChar" | "deleteBackward";

/**
 * Four tabs of math keys. They type into the formula open in the field above, so the panel never
 * takes focus from it. It lives inside its caller's layout and pushes the page up instead of covering it.
 */
export default function FormulaPanel({
  onKey,
  onCommand,
  onDone,
}: {
  onKey: (latex: string) => void;
  onCommand: (name: FormulaCommand) => void;
  /** Closes the panel and the formula; also on Esc from anywhere on the page. */
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [tab, setTab] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      done.current();
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, []);

  // Keys must not take focus from the field, so a tap does not close the caret or the selection.
  const keepFocus = (event: MouseEvent) => event.preventDefault();

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = MATH_TABS.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % MATH_TABS.length
        : event.key === "ArrowLeft"
          ? (index + last) % MATH_TABS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  }

  const current = MATH_TABS[tab] ?? MATH_TABS[0]!;

  return (
    <div className="px-formula" role="group" aria-label={t("math.keyboard")} data-math-keys>
      <div className="px-formula-tabs" role="tablist" aria-label={t("math.tabs")}>
        {MATH_TABS.map((item, index) => (
          <button
            key={item.id}
            id={`${id}-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={index === tab}
            aria-controls={`${id}-keys`}
            tabIndex={index === tab ? 0 : -1}
            title={t(`math.tab.${item.id}`)}
            aria-label={t(`math.tab.${item.id}`)}
            onClick={() => setTab(index)}
            onKeyDown={(event) => onTabKey(event, index)}
          >
            <span aria-hidden className="is-full">
              {item.caption}
            </span>
            <span aria-hidden className="is-short">
              {item.short}
            </span>
          </button>
        ))}
      </div>
      <div
        id={`${id}-keys`}
        className="px-formula-keys"
        role="tabpanel"
        aria-labelledby={`${id}-tab-${tab}`}
      >
        {current.rows.map((row, rowIndex) => (
          <div className="px-formula-row" key={`${current.id}-${rowIndex}`}>
            {row.map((key, keyIndex) => {
              const name = key.text ?? t(`math.key.${key.id}`);
              return (
                <button
                  key={`${key.id}-${keyIndex}`}
                  type="button"
                  className={[
                    "px-formula-key",
                    key.tone === "digit" && "is-digit",
                    key.fit && `is-${key.fit}`,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-label={name}
                  title={name}
                  onMouseDown={keepFocus}
                  onClick={() => onKey(key.insert)}
                >
                  <span
                    aria-hidden
                    dangerouslySetInnerHTML={{ __html: glyphHtml(key.label) }}
                  />
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="px-formula-actions">
        <button
          type="button"
          className="px-formula-key is-action"
          aria-label={t("math.left")}
          title={t("math.left")}
          onMouseDown={keepFocus}
          onClick={() => onCommand("moveToPreviousChar")}
        >
          <ArrowLeft size={18} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          className="px-formula-key is-action"
          aria-label={t("math.right")}
          title={t("math.right")}
          onMouseDown={keepFocus}
          onClick={() => onCommand("moveToNextChar")}
        >
          <ArrowRight size={18} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          className="px-formula-key is-action"
          aria-label={t("math.backspace")}
          title={t("math.backspace")}
          onMouseDown={keepFocus}
          onClick={() => onCommand("deleteBackward")}
        >
          <Delete size={18} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          className="px-formula-insert"
          onMouseDown={keepFocus}
          onClick={() => onDone()}
        >
          {t("math.done")}
        </button>
      </div>
    </div>
  );
}
