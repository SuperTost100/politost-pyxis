import { Button } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CHAT_SEED_BODY_MAX } from "@shared/limits";
import { invoke } from "../lib/ipc";
import { selectedText } from "../lib/selectionText";
import { openMakeCards } from "./MakeCardsDialog";
import "./SelectionMenu.css";

/** Selection actions shared by lessons and source chapters. */
export function SelectionMenu({ children, sourceIds = [], planId, topicId, passageIds, onAsk }: {
  children: ReactNode;
  sourceIds?: string[];
  planId?: string;
  /** The lesson's topic: flashcards made from a selection go there. */
  topicId?: string;
  /** The passages the shown text comes from; the flashcards link to them. */
  passageIds?: string[];
  onAsk: (chatId: string) => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null);
  const selected = useRef(selection);
  selected.current = selection;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"quiz.actionFailed" | "errors.inputTooLong" | null>(null);
  useEffect(() => {
    const update = () => {
      if (menu.current?.contains(document.activeElement)) return;
      const current = window.getSelection();
      if (!current?.rangeCount || current.isCollapsed || !root.current) return setSelection(null);
      const range = current.getRangeAt(0);
      if (!root.current.contains(range.startContainer) || !root.current.contains(range.endContainer)) return setSelection(null);
      // Text covered by a dialog (the flashcard maker over a lesson) gets no menu, which would float above the dialog.
      // A source opened over that dialog is on top, so its text does.
      const box = range.getClientRects()[0] ?? range.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (top && !root.current.contains(top)) return setSelection(null);
      const text = selectedText(range);
      if (!text) return setSelection(null);
      const rect = range.getBoundingClientRect();
      setFailed(null);
      setSelection({ text, x: Math.max(12, Math.min(rect.left, window.innerWidth - 392)), y: Math.max(12, Math.min(rect.top - 48, window.innerHeight - 60)) });
    };
    const hide = () => setSelection(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selected.current) {
        event.preventDefault();
        event.stopPropagation();
        hide();
      }
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);
  async function act(action: "ask" | "copy" | "cards") {
    if (!selection || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      if (action === "copy") await navigator.clipboard.writeText(selection.text);
      else if (action === "cards") openMakeCards({ text: selection.text, origin: "selection", planId, topicId, passageIds });
      else {
        const { chatId } = await invoke("chats.seed", { kind: "passage", title: selection.text.slice(0, 80), body: selection.text, sourceIds, planId });
        onAsk(chatId);
      }
      setSelection(null);
    } catch (err) {
      const tooLong = typeof err === "object" && err !== null && "messageKey" in err && err.messageKey === "errors.inputTooLong";
      setFailed(tooLong ? "errors.inputTooLong" : "quiz.actionFailed");
    }
    finally { setBusy(false); }
  }
  return <div ref={root}>
    {children}
    {selection ? <div ref={menu} className="px-selection-menu" style={{ left: selection.x, top: selection.y }} role="group" aria-label={t("ask.askTutor")} onMouseDown={(event) => event.preventDefault()}>
      <Button type="text" disabled={busy} onClick={() => void act("ask")}>{t("ask.askTutor")}</Button>
      <Button type="text" disabled={busy} onClick={() => void act("cards")}>{t("makeCards.action")}</Button>
      <Button type="text" disabled={busy} onClick={() => void act("copy")}>{t("sources.copySelection")}</Button>
      {failed ? <span className="small" role="alert">{t(failed, { max: CHAT_SEED_BODY_MAX })}</span> : null}
    </div> : null}
  </div>;
}
