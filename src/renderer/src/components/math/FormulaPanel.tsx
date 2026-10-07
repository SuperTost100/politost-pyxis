import katex from "katex";
import { MathfieldElement } from "mathlive";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../Icon";
import { MATH_TABS, type MathKey } from "./keys";
import "katex/dist/katex.min.css";
import "./FormulaPanel.css";

// The app serves everything from its own bundle. The glyphs come from the KaTeX fonts that
// katex.min.css already declares, and nothing is fetched or played.
MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;
MathfieldElement.computeEngine = null;
MathfieldElement.keypressSound = null;
MathfieldElement.plonkSound = null;

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

/**
 * A math field with a four-tab key panel under it. It lives inside its caller's layout, so it
 * pushes the page up instead of covering it. `onInsert` receives the LaTeX of the field.
 */
export default function FormulaPanel({
  onInsert,
  onClose,
}: {
  onInsert: (latex: string) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const host = useRef<HTMLDivElement>(null);
  const field = useRef<MathfieldElement | null>(null);
  const [tab, setTab] = useState(0);
  const [empty, setEmpty] = useState(true);
  const callbacks = useRef({ onInsert, onClose });
  callbacks.current = { onInsert, onClose };

  useEffect(() => {
    const el = new MathfieldElement();
    MathfieldElement.locale = i18n.language.startsWith("it") ? "it" : "en";
    el.mathVirtualKeyboardPolicy = "manual";
    el.smartMode = false;
    el.setAttribute("aria-label", t("math.field"));
    el.className = "px-formula-field";
    el.addEventListener("input", () => setEmpty(!el.getValue("latex-without-placeholders").trim()));
    host.current?.prepend(el);
    field.current = el;
    const focus = requestAnimationFrame(() => el.focus());
    // Esc closes from anywhere on the page, not only from inside the panel.
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      callbacks.current.onClose();
    };
    document.addEventListener("keydown", onEscape, true);
    return () => {
      cancelAnimationFrame(focus);
      document.removeEventListener("keydown", onEscape, true);
      el.remove();
      field.current = null;
    };
    // The field is created once; its label follows the language on the next open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commit() {
    const el = field.current;
    if (!el) return;
    const latex = el.getValue("latex-without-placeholders");
    if (!latex.trim()) return;
    callbacks.current.onInsert(latex);
  }

  function press(key: MathKey) {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.executeCommand(["insert", key.insert, { format: "latex", focus: true, feedback: false }]);
  }

  function command(name: "moveToPreviousChar" | "moveToNextChar" | "deleteBackward") {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.executeCommand(name);
  }

  // Keys must not take focus from the field, so a tap does not close the caret or the selection.
  const keepFocus = (event: MouseEvent) => event.preventDefault();

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      event.target instanceof HTMLElement &&
      (event.target === field.current || event.target.closest("math-field"))
    ) {
      event.preventDefault();
      event.stopPropagation();
      commit();
    }
  }

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
    <div
      className="px-formula"
      role="group"
      aria-label={t("math.keyboard")}
      onKeyDownCapture={onKeyDown}
    >
      <div className="px-formula-head" ref={host}>
        <button
          type="button"
          className="px-formula-close"
          aria-label={t("math.close")}
          title={t("math.close")}
          onMouseDown={keepFocus}
          onClick={() => callbacks.current.onClose()}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
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
                  onClick={() => press(key)}
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
          onClick={() => command("moveToPreviousChar")}
        >
          <span aria-hidden>←</span>
        </button>
        <button
          type="button"
          className="px-formula-key is-action"
          aria-label={t("math.right")}
          title={t("math.right")}
          onMouseDown={keepFocus}
          onClick={() => command("moveToNextChar")}
        >
          <span aria-hidden>→</span>
        </button>
        <button
          type="button"
          className="px-formula-key is-action"
          aria-label={t("math.backspace")}
          title={t("math.backspace")}
          onMouseDown={keepFocus}
          onClick={() => command("deleteBackward")}
        >
          <span aria-hidden>⌫</span>
        </button>
        <button
          type="button"
          className="px-formula-insert"
          disabled={empty}
          onMouseDown={keepFocus}
          onClick={commit}
        >
          {t("math.insert")}
        </button>
      </div>
    </div>
  );
}
