import type { MenuProps } from "antd";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { CHAT_TEXT_MAX } from "@shared/limits";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { MenuButton } from "./ItemMenu";
import { FormulaDock } from "./math/FormulaDock";
import { MathTextEditor, type MathTextEditorHandle } from "./math/MathTextEditor";
import { useFormulaKeys } from "./math/useFormulaKeys";
import "./Composer.css";

/**
 * The message box in Chiedi: the field, then the plus (a file or a formula), the whiteboard, the function graph and Invia.
 * Nothing in it sets how Pyxis answers or where it looks; the chat's subject is a chip in its header.
 */

export function Composer({
  placeholder,
  streaming,
  value,
  onValueChange,
  onSend,
  onStop,
  onAttach,
  onPasteImages,
  dropping,
  fieldRef,
}: {
  placeholder?: string;
  streaming?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  onSend?: () => void;
  onStop?: () => void;
  onAttach?: () => void;
  /** Images pasted without text, such as a screenshot. Text pastes into the field as usual. */
  onPasteImages?: (images: File[]) => void;
  /** Files are being dragged over the page, so the card shows it takes them. */
  dropping?: boolean;
  /** The field, for a page that gives it the focus back, as after choosing the chat's subject. */
  fieldRef?: RefObject<MathTextEditorHandle | null>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const text = value ?? draft;
  // A refused paste is explained until the text changes, by the student or by a send.
  const [refused, setRefused] = useState(false);
  useEffect(() => setRefused(false), [text]);
  function setText(next: string) {
    onValueChange?.(next);
    if (value === undefined) setDraft(next);
  }
  const ownField = useRef<MathTextEditorHandle>(null);
  const field = fieldRef ?? ownField;
  const formula = useFormulaKeys(field);
  const card = useRef<HTMLDivElement>(null);
  // Where the caret was when the plus menu opened, so a formula chosen from it opens there and not at the end.
  const caret = useRef<Range | null>(null);
  function keepCaret(open: boolean) {
    if (!open) return;
    const selection = getSelection();
    const root = card.current?.querySelector(".px-composer-field");
    caret.current =
      selection && selection.rangeCount > 0 && root?.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : null;
  }
  // The plus adds to the message: a file or a photo from the computer, or a formula at the caret. The formula keyboard
  // opens after the menu has given the focus back, in the field where the caret was.
  const add: MenuProps = {
    items: [
      { key: "file", icon: <Icon name="paperclip" size={16} />, label: t("components.composer.attach"), disabled: !onAttach },
      {
        key: "formula",
        icon: <Icon name="sigma" size={16} />,
        label: formula.open ? t("components.composer.formulaClose") : t("components.composer.formula"),
      },
    ],
    onClick: ({ key }) => {
      if (key === "file") onAttach?.();
      else
        requestAnimationFrame(() => {
          field.current?.focus();
          const range = caret.current;
          if (range && !formula.open) {
            getSelection()?.removeAllRanges();
            getSelection()?.addRange(range);
          }
          formula.toggle();
        });
    },
  };
  return (
    <div
      ref={card}
      className={dropping ? "px-composer is-dropping" : "px-composer"}
      data-keeps-draft
      onPaste={(event) => {
        const images = Array.from(event.clipboardData.files).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (!onPasteImages || images.length === 0 || event.clipboardData.getData("text/plain")) return;
        event.preventDefault();
        onPasteImages(images);
      }}
    >
      {/* The field grows with the draft up to a few lines, then scrolls. */}
      <MathTextEditor
        ref={field}
        className="px-composer-field"
        placeholder={placeholder ?? t("ask.placeholder")}
        ariaLabel={t("components.composer.messageLabel")}
        value={text}
        maxLength={CHAT_TEXT_MAX}
        onRefused={() => setRefused(true)}
        onChange={setText}
        onSubmit={() => {
          if (!streaming) onSend?.();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && streaming) onStop?.();
        }}
      />
      {refused || text.length >= CHAT_TEXT_MAX * 0.8 ? (
        // The field refuses text past the limit, so a long paste that does not appear is explained here.
        <p
          className={refused || text.length >= CHAT_TEXT_MAX ? "px-composer-count is-full" : "px-composer-count"}
          role="status"
        >
          {t(
            refused
              ? "components.composer.refused"
              : text.length >= CHAT_TEXT_MAX
                ? "components.composer.full"
                : "components.composer.count",
            { used: text.length, max: CHAT_TEXT_MAX },
          )}
        </p>
      ) : null}
      <FormulaDock {...formula.dock} />
      <div className="px-composer-bar">
        <MenuButton
          menu={add}
          icon="plus"
          label={t("components.composer.add")}
          align="start"
          onOpenChange={keepCaret}
        />
        <IconButton
          icon="pencil-line"
          label={t("components.composer.whiteboard")}
          variant="ghost"
          onClick={() => navigate("/tools/whiteboard")}
        />
        <IconButton
          icon="chart-line"
          label={t("components.composer.graph")}
          variant="ghost"
          onClick={() => navigate("/tools/graph")}
        />
        <span className="px-spacer" />
        {streaming ? (
          <Button variant="secondary" icon="square" onClick={onStop}>
            {t("components.composer.stop")}
          </Button>
        ) : (
          <Button variant="primary" onClick={onSend}>
            {t("components.composer.send")}
          </Button>
        )}
      </div>
    </div>
  );
}
