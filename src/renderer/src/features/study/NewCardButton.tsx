import { Button } from "antd";
import { Check, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CardFaceFields } from "../../components/CardFaceFields";

/**
 * "New flashcard" in the study bar (pyxis-mockups app/study.html, "s-cards-a-new"): a small form that grows out of the
 * button, with the front, the back, Cancel and Add. After Add it stays open, empty and with a short confirmation, so
 * the next card can follow. Tab stays inside it. Esc and a click outside close it and keep what was typed; Cancel
 * also clears it.
 */
export function NewCardButton({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Saves the card; a rejection keeps the text and says it failed. */
  onAdd: (front: string, back: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [saving, setSaving] = useState(false);
  const [added, setAdded] = useState(false);
  const [failed, setFailed] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // The form grows from the middle of the button's bottom edge; the form is right-aligned with the button.
  const [originX, setOriginX] = useState(0);
  const focusFront = () => document.getElementById("new-card-front")?.focus();

  useEffect(() => {
    if (!open) {
      setAdded(false);
      setFailed(false);
      return;
    }
    focusFront();
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function close() {
    onOpenChange(false);
    button.current?.focus();
  }

  async function add() {
    if (!front.trim() || !back.trim() || saving) return;
    setSaving(true);
    setFailed(false);
    setAdded(false);
    try {
      await onAdd(front, back);
      setFront("");
      setBack("");
      setAdded(true);
      focusFront();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="px-newcard-wrap"
      ref={wrap}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <Button
        ref={button}
        type="text"
        className="px-studybar-action"
        icon={<Plus size={16} strokeWidth={1.75} aria-hidden />}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "new-card" : undefined}
        onClick={() => {
          if (!open) setOriginX((button.current?.offsetWidth ?? 0) / 2);
          onOpenChange(!open);
        }}
      >
        <span className="px-studybar-label">{t("cards.new")}</span>
      </Button>
      {open ? (
        <div
          id="new-card"
          className="px-newcard"
          role="dialog"
          aria-label={t("cards.new")}
          onKeyDown={(event) => {
            // Tab stays in the form while it is open; Esc or Cancel lead back to the bar.
            if (event.key !== "Tab") return;
            const stops = [
              ...event.currentTarget.querySelectorAll<HTMLElement>("textarea, button:not(:disabled)"),
            ];
            const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
            if (document.activeElement !== edge) return;
            event.preventDefault();
            (event.shiftKey ? stops[stops.length - 1] : stops[0])?.focus();
          }}
          style={{ transformOrigin: `calc(100% - ${originX}px) -8px` }}
        >
          <CardFaceFields
            idPrefix="new-card"
            front={front}
            back={back}
            placeholders={{ front: t("cards.newFrontHint"), back: t("cards.newBackHint") }}
            onFront={(value) => {
              setFront(value);
              setAdded(false);
            }}
            onBack={(value) => {
              setBack(value);
              setAdded(false);
            }}
          />
          {failed ? (
            <p className="small px-newcard-error" role="alert">
              {t("cards.actionFailed")}
            </p>
          ) : null}
          <div className="px-newcard-actions">
            {/* The confirmation sits where the eye already is, beside Add. */}
            <p className="small px-newcard-note" role="status">
              {added ? (
                <>
                  <Check size={14} strokeWidth={2} aria-hidden />
                  {t("cards.newAdded")}
                </>
              ) : null}
            </p>
            <Button
              type="text"
              size="small"
              onClick={() => {
                setFront("");
                setBack("");
                close();
              }}
            >
              {t("cardBrowser.cancel")}
            </Button>
            <Button
              type="primary"
              size="small"
              loading={saving}
              disabled={!front.trim() || !back.trim()}
              onClick={() => void add()}
            >
              {t("cards.newAdd")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
