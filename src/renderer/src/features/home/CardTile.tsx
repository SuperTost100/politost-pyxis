import { Input } from "antd";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type Ref } from "react";
import type { MenuProps } from "antd";
import { useTranslation } from "react-i18next";
import { Button as PxButton } from "../../components/Button";
import { MenuButton, MenuItemArea } from "../../components/ItemMenu";
import { MarkdownView } from "../../components/MarkdownView";
import { Notice } from "../../components/Notice";
import { i18n } from "../../locales/i18n";
import { cardFlag, cardName, frontText, type BrowsedCard } from "./cardBrowserLogic";

/** What a card's controls do. The browser keeps these the same for as long as it is open, so a tile re-renders only for its own card. */
export type CardActions = {
  edit: (card: BrowsedCard, from: DOMRect | null) => void;
  suspend: (card: BrowsedCard) => void;
  remove: (card: BrowsedCard) => void;
  restore: (card: BrowsedCard) => void;
  openSource: (card: BrowsedCard) => void;
};

function dateText(at: number) {
  const date = new Date(at);
  const year = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(i18n.language, {
    day: "numeric",
    month: "short",
    ...(year ? {} : { year: "numeric" }),
  }).format(date);
}

/**
 * Tells a card when it is within a page or two of the window, once. One observer serves every card that scrolls in the
 * same box: the page's scroll area, which a margin on the window itself would not reach into.
 */
const watchers = new WeakMap<Element | Document, { observer: IntersectionObserver; calls: Map<Element, () => void> }>();
function scrollBoxOf(node: Element): Element | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll") return parent;
  }
  return null;
}
function whenNear(node: Element, call: () => void): () => void {
  const box = scrollBoxOf(node);
  const key = box ?? document;
  let watcher = watchers.get(key);
  if (!watcher) {
    const calls = new Map<Element, () => void>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          calls.get(entry.target)?.();
          calls.delete(entry.target);
        }
      },
      { root: box, rootMargin: "1200px 0px" },
    );
    watcher = { observer, calls };
    watchers.set(key, watcher);
  }
  watcher.calls.set(node, call);
  watcher.observer.observe(node);
  const { observer, calls } = watcher;
  return () => {
    observer.unobserve(node);
    calls.delete(node);
  };
}

/** A card's text before it is drawn as Markdown and math: the same box with the plain words, which cost nothing to lay out. */
function PlainText({ children }: { children: string }) {
  return (
    <div className="px-markdown is-body">
      <p>{children}</p>
    </div>
  );
}

/** What the foot of a card says. */
function useFootText() {
  const { t } = useTranslation();
  return (card: BrowsedCard) => {
    const flag = cardFlag(card);
    return flag === "removed"
      ? t("cardBrowser.tagRemoved")
      : flag === "suspended"
        ? t("cardBrowser.tagSuspended")
        : flag === "leech"
          ? t("cardBrowser.tagLeech")
          : flag === "new"
            ? t("cardBrowser.stateNew")
            : flag === "due"
              ? t("cardBrowser.stateDue")
              : t("cardBrowser.stateNext", { date: dateText(card.dueAt ?? 0) });
  };
}

const isFlagged = (card: BrowsedCard) => !["new", "due", "scheduled"].includes(cardFlag(card));

/**
 * One flashcard as a small card: its topic, the front above and the back below, and its state at the foot with the
 * three dots. A click, or Enter on the card, edits it where it stands; a right-click anywhere on it opens the menu the
 * dots open. A removed card has no menu and offers Restore. The card is one list item that reads its front, back and
 * state in that order, and the two buttons after them name the card they act on.
 *
 * With `lazy`, for the many cards of an opened subject, a card stays plain text, in the same box, until it is near the
 * window: it is then drawn with its formulas, its menu and its buttons. Unfolding a subject of thousands so draws a
 * screen of them and not every one.
 */
export const CardTile = memo(function CardTile({
  card,
  actions,
  lazy = false,
}: {
  card: BrowsedCard;
  actions: CardActions;
  lazy?: boolean;
}) {
  const [near, setNear] = useState(!lazy);
  const item = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (near || !item.current) return;
    return whenNear(item.current, () => setNear(true));
  }, [near]);
  return near ? (
    <LiveTile card={card} actions={actions} />
  ) : (
    <PendingTile card={card} ref={item} />
  );
});

function topicOf(card: BrowsedCard, t: (key: string) => string) {
  return card.topicTitle ?? (card.planId ? t("cardBrowser.noTopic") : t("cardBrowser.noExam"));
}

function PendingTile({ card, ref }: { card: BrowsedCard; ref: Ref<HTMLLIElement> }) {
  const { t } = useTranslation();
  const foot = useFootText();
  return (
    <li className="px-ct" data-card-id={card.id} ref={ref}>
      <span className="px-ct-topic">{topicOf(card, t)}</span>
      <div className="px-ct-front">
        <span className="visually-hidden">{t("cardBrowser.frontText")}</span>
        <PlainText>{frontText(card)}</PlainText>
      </div>
      <div className="px-ct-lower">
        <div className="px-ct-back">
          <span className="visually-hidden">{t("cardBrowser.backText")}</span>
          <PlainText>{card.back}</PlainText>
        </div>
        <p className={isFlagged(card) ? "px-ct-state is-flag" : "px-ct-state"}>{foot(card)}</p>
      </div>
    </li>
  );
}

function LiveTile({ card, actions }: { card: BrowsedCard; actions: CardActions }) {
  const { t } = useTranslation();
  const foot = useFootText();
  const name = cardName(card);
  const label = (key: string) => t("cardBrowser.action", { action: t(key), card: name });
  const rewrite = card.leech && !card.removed;
  const editKey = rewrite ? "cardBrowser.rewrite" : "cards.edit";
  // The dots' menu is open: the card keeps the look of being pointed at while the pointer is in the menu.
  const [open, setOpen] = useState(false);
  const rect = () => document.querySelector(`[data-card-id="${CSS.escape(card.id)}"]`)?.getBoundingClientRect() ?? null;

  // The three-dots menu, which a right-click on the card opens too. A removed card has none, only Restore.
  const menu: MenuProps = useMemo(
    () => ({
      items: [
        { key: "edit", label: t("cards.edit") },
        ...(card.leech && card.passageId ? [{ key: "source", label: t("cardBrowser.openSource") }] : []),
        { key: "suspend", label: t(card.suspended ? "cards.resume" : "cards.suspend") },
        { type: "divider" as const },
        { key: "delete", label: t("cards.delete"), danger: true },
      ],
      onClick: ({ key }) => {
        if (key === "delete") actions.remove(card);
        else if (key === "source") actions.openSource(card);
        else if (key === "edit") actions.edit(card, rect());
        else actions.suspend(card);
      },
    }),
    [card, actions, t],
  );

  return (
    <MenuItemArea
      menu={menu}
      region={t("cardBrowser.moreActions")}
      disabled={card.removed}
      className={["px-ct", open ? "is-pointed" : "", card.removed ? "is-removed" : ""].filter(Boolean).join(" ")}
      data-card-id={card.id}
    >
      <span className="px-ct-topic">{topicOf(card, t)}</span>
      <div className="px-ct-front">
        <span className="visually-hidden">{t("cardBrowser.frontText")}</span>
        <MarkdownView variant="body">{frontText(card)}</MarkdownView>
      </div>
      <div className="px-ct-lower">
        <div className="px-ct-back">
          <span className="visually-hidden">{t("cardBrowser.backText")}</span>
          <MarkdownView variant="body">{card.back}</MarkdownView>
        </div>
        <p className={isFlagged(card) ? "px-ct-state is-flag" : "px-ct-state"}>{foot(card)}</p>
      </div>
      {card.removed ? (
        <div className="px-ct-corner">
          <PxButton variant="secondary" size="sm" aria-label={label("cardBrowser.restore")} onClick={() => actions.restore(card)}>
            {t("cardBrowser.restore")}
          </PxButton>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="px-ct-open"
            aria-label={label(editKey)}
            onClick={() => actions.edit(card, rect())}
          />
          <div className="px-ct-corner">
            <MenuButton
              size="sm"
              menu={menu}
              label={label("cardBrowser.moreActions")}
              region={t("cardBrowser.moreActions")}
              onOpenChange={setOpen}
            />
          </div>
        </>
      )}
    </MenuItemArea>
  );
}

/**
 * A card being edited, where it stands: the card grows out of its own place into two fields, and the foot holds the
 * schedule note (or what a often-forgotten card needs), Annulla and Salva. The draft lives here, so typing redraws this
 * card and nothing else; `dirty` lets the page ask before the typing would be lost.
 */
export function CardEditor({
  card,
  from,
  saving,
  failed,
  dirty,
  onSave,
  onCancel,
}: {
  card: BrowsedCard;
  /** Where the card was when the student opened it, which it grows out of. */
  from: DOMRect | null;
  saving: boolean;
  failed: boolean;
  dirty: MutableRefObject<(() => boolean) | null>;
  onSave: (front: string, back: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);
  const root = useRef<HTMLLIElement>(null);
  dirty.current = () => front !== card.front || back !== card.back;
  const valid = front.trim() !== "" && back.trim() !== "";

  // The card opens out of the place it was in, as a mask that grows, so the text never stretches; the front field has
  // the focus. With reduced motion it only appears.
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const field = node.querySelector<HTMLTextAreaElement>("textarea");
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
    const to = node.getBoundingClientRect();
    if (!from || !from.width || !to.width || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const right = Math.max(0, to.width - from.width);
    const bottom = Math.max(0, to.height - from.height);
    const animation = node.animate(
      [
        { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, clipPath: `inset(0 ${right}px ${bottom}px 0 round 14px)` },
        { transform: "none", clipPath: "inset(0 0 0 0 round 14px)" },
      ],
      { duration: 240, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
    );
    return () => animation.cancel();
    // Runs once: the page keys this component by its card.
  }, []);

  return (
    <li
      className="px-ct is-editing"
      data-card-id={card.id}
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="px-ct-edit" role="group" aria-label={t("cardBrowser.editTitle")}>
        <label className="label" htmlFor={`browse-${card.id}-front`}>
          {t("cards.front")}
        </label>
        <Input.TextArea
          id={`browse-${card.id}-front`}
          autoSize={{ minRows: 2, maxRows: 8 }}
          value={front}
          onChange={(event) => setFront(event.target.value)}
        />
        <label className="label" htmlFor={`browse-${card.id}-back`}>
          {t("cards.back")}
        </label>
        <Input.TextArea
          id={`browse-${card.id}-back`}
          autoSize={{ minRows: 2, maxRows: 8 }}
          value={back}
          onChange={(event) => setBack(event.target.value)}
        />
        {failed ? <Notice tone="danger">{t("cards.actionFailed")}</Notice> : null}
        <div className="px-ct-editfoot">
          <p className="small">
            {card.leech
              ? t(card.passageId ? "cardBrowser.leechHint" : "cardBrowser.leechHintNoSource", { count: card.lapses })
              : t("cardBrowser.editHint")}
          </p>
          <PxButton variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
            {t("cardBrowser.cancel")}
          </PxButton>
          <PxButton size="sm" disabled={!valid || saving} onClick={() => onSave(front, back)}>
            {t("cards.save")}
          </PxButton>
        </div>
      </div>
    </li>
  );
}
