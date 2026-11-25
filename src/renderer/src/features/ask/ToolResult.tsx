import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { ToolResultView } from "@shared/ipc";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { invoke } from "../../lib/ipc";
import "./ToolResult.css";

/**
 * What a Pyxis tool did, in the reply where the model called it. `line` is the body of the reply's ```pyxis-tool block:
 * `pending:<tool>` while the tool runs, else the result's id, which `view` describes. A result the reply does not carry
 * shows nothing. A state reached while the card is on screen grows out of the one before it: the working shape becomes
 * the card, and «Annulla» folds the card into its one line.
 */
export function ToolResult({
  chatId,
  line,
  view,
  onView,
}: {
  chatId: string;
  line: string;
  view?: ToolResultView;
  /** Hears the result's new state after «Annulla» or «Ripristina», for a reply still being written. */
  onView?: (view: ToolResultView) => void;
}) {
  const pending = line.startsWith("pending:");
  // The state the card was first drawn in: a later one is a change the student sees happen, so it animates.
  const [state, setState] = useState<ToolResultView | undefined>(view);
  useEffect(() => setState(view), [view]);
  const first = useRef(pending ? "pending" : stateKey(view));
  if (pending) return <Working />;
  if (!state) return null;
  const arriving = first.current !== stateKey(state);
  return (
    <Flashcards
      chatId={chatId}
      view={state}
      arriving={arriving}
      onChange={(next) => {
        setState(next);
        onView?.(next);
      }}
    />
  );
}

const stateKey = (view: ToolResultView | undefined) => (view ? (view.undone === null ? "done" : "undone") : "none");

/** The tool at work: one quiet line and a grey shape where the card will be. */
function Working() {
  const { t } = useTranslation();
  return (
    <div className="px-toolres is-working" role="status">
      <span className="small px-toolres-working-line">{t("components.toolResult.working")}</span>
      <div className="px-toolres-ghost" aria-hidden>
        <i className="px-toolres-ghost-bar is-title" />
        <i className="px-toolres-ghost-bar" />
        <i className="px-toolres-ghost-bar is-short" />
      </div>
    </div>
  );
}

function Flashcards({
  chatId,
  view,
  arriving,
  onChange,
}: {
  chatId: string;
  view: ToolResultView;
  arriving: boolean;
  onChange: (view: ToolResultView) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // After «Annulla» the focus goes to «Ripristina», and back to «Annulla» after it, so the keyboard stays in the card.
  const after = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    after.current?.querySelector<HTMLButtonElement>("button.px-toolres-act")?.focus();
  }, [view.undone]);

  async function act(request: "chats.undoTool" | "chats.restoreTool") {
    if (!chatId || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const next = await invoke(request, { chatId, resultId: view.id });
      moved.current = true;
      onChange(next);
      // The chat as read and the card browser show the change too.
      void client.invalidateQueries({ queryKey: ["chat", chatId] });
      void client.invalidateQueries({ queryKey: ["card-browse"] });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const failure = failed ? (
    <p className="small px-toolres-failed" role="alert">
      {t("components.toolResult.failed")}
    </p>
  ) : null;

  if (view.undone !== null)
    return (
      <div ref={after} className={arriving ? "px-toolres is-undone is-arriving" : "px-toolres is-undone"}>
        <p className="small px-toolres-undone-line" role="status">
          {t("components.toolResult.undone", { count: view.undone })}
        </p>
        <Button variant="ghost" size="sm" icon="rotate-ccw" disabled={busy || !chatId} onClick={() => void act("chats.restoreTool")} className="px-toolres-act">
          {t("components.toolResult.restore")}
        </Button>
        {failure}
      </div>
    );

  const more = view.count - view.fronts.length;
  return (
    <section
      ref={after}
      className={arriving ? "px-toolres is-done is-arriving" : "px-toolres is-done"}
      aria-label={t("components.toolResult.title")}
    >
      <p className="label px-toolres-title">
        <Icon name="layers" size={16} />
        {t("components.toolResult.title")}
      </p>
      <p className="body-strong px-toolres-line">
        {view.title
          ? t("components.toolResult.titled", { count: view.count, title: view.title })
          : t("components.toolResult.inDeck", { count: view.count, deck: view.deck })}
      </p>
      <ul className="px-toolres-fronts">
        {view.fronts.map((front, index) => (
          <li key={index} className="body px-toolres-front">
            <InlineMarkdown>{front}</InlineMarkdown>
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="small px-toolres-more">{t("components.toolResult.more", { count: more })}</p> : null}
      {view.duplicates > 0 ? (
        <p className="small px-toolres-more">{t("components.toolResult.duplicates", { count: view.duplicates })}</p>
      ) : null}
      <div className="px-toolres-actions">
        <Button variant="secondary" size="sm" onClick={() => navigate(`/flashcards/all?made=${encodeURIComponent(view.id)}`)}>
          {t("components.toolResult.open")}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy || !chatId} onClick={() => void act("chats.undoTool")} className="px-toolres-act">
          {t("components.toolResult.undo")}
        </Button>
      </div>
      {failure}
    </section>
  );
}
