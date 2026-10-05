import { Button } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../lib/ipc";
import "./SelectionMenu.css";

/** Selection actions shared by lessons and source chapters. */
export function SelectionMenu({ children, sourceIds = [], planId, onAsk }: {
  children: ReactNode;
  sourceIds?: string[];
  planId?: string;
  onAsk: (chatId: string) => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null);
  const selected = useRef(selection);
  selected.current = selection;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const update = () => {
      if (menu.current?.contains(document.activeElement)) return;
      const current = window.getSelection();
      const text = current?.toString().trim();
      if (!text || !current?.rangeCount || !root.current) return setSelection(null);
      const range = current.getRangeAt(0);
      if (!root.current.contains(range.startContainer) || !root.current.contains(range.endContainer)) return setSelection(null);
      const rect = range.getBoundingClientRect();
      setFailed(false);
      setSelection({ text, x: Math.max(12, Math.min(rect.left, window.innerWidth - 292)), y: Math.max(12, Math.min(rect.top - 48, window.innerHeight - 60)) });
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
  async function act(action: "ask" | "copy") {
    if (!selection || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      if (action === "copy") await navigator.clipboard.writeText(selection.text);
      else {
        const { chatId } = await invoke("chats.seed", { kind: "passage", title: selection.text.slice(0, 80), body: selection.text, sourceIds, planId });
        onAsk(chatId);
      }
      setSelection(null);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  }
  return <div ref={root}>
    {children}
    {selection ? <div ref={menu} className="px-selection-menu" style={{ left: selection.x, top: selection.y }} role="group" aria-label={t("ask.askTutor")} onMouseDown={(event) => event.preventDefault()}>
      <Button type="text" disabled={busy} onClick={() => void act("ask")}>{t("ask.askTutor")}</Button>
      <Button type="text" disabled={busy} onClick={() => void act("copy")}>{t("sources.copySelection")}</Button>
      {failed ? <span className="small" role="alert">{t("quiz.actionFailed")}</span> : null}
    </div> : null}
  </div>;
}
