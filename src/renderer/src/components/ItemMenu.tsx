import { Dropdown, type MenuProps } from "antd";
import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { menuTrigger, type MenuPoint } from "../lib/itemMenu";
import "./ItemMenu.css";

const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * How an open menu ends, the way a desktop menu does: when the page scrolls under it (a scroll of anything that holds
 * `anchor`), and when the window is resized, unless `followsResize` says the menu is drawn from a button that the
 * dropdown re-aligns to. A menu is not closed because the page around it changed: a file finishing its read or a shelf
 * growing moves the item, and the student's hand is already on the menu. With `followsResize`, the menu also follows the
 * button when the layout shifts it (see `follow`).
 *
 * When the item leaves the page while its menu is open (the component unmounts with the menu in it), focus that was
 * inside the menu goes to the item's neighbour instead of to the page.
 * `anchor` reads the element the menu belongs to when it opens; `close` is called at most once per opening.
 */
export function useMenuLifetime(
  open: boolean,
  anchor: () => Element | null | undefined,
  close: () => void,
  followsResize = false,
): void {
  const latest = useRef({ anchor, close });
  latest.current = { anchor, close };
  // Where the item sat in its list, to find its neighbour if it is removed with the menu open.
  const place = useRef<{ list: Element; index: number } | null>(null);
  useEffect(() => {
    const element = open ? latest.current.anchor() : null;
    if (!element) {
      place.current = null;
      return;
    }
    const row = element.closest("li, section") ?? element;
    place.current = row.parentElement ? { list: row.parentElement, index: [...row.parentElement.children].indexOf(row) } : null;
    const onScroll = (event: Event) => {
      const scroller = event.target;
      if (scroller === document || (scroller instanceof Node && scroller.contains(element))) latest.current.close();
    };
    // `scroll` does not bubble, so one listener in the capture phase hears every scroller.
    document.addEventListener("scroll", onScroll, true);
    let following = false;
    const onResize = () => {
      if (!following && !followsResize) latest.current.close();
    };
    window.addEventListener("resize", onResize);
    // shortcut: the dropdown aligns itself to its button on a window resize only, so a layout shift is passed on to it as
    // one. Upgrade when antd's Dropdown exposes its trigger's `forceAlign`.
    let frame = 0;
    let last = element.getBoundingClientRect();
    const follow = () => {
      const now = element.getBoundingClientRect();
      if (Math.abs(now.left - last.left) > 1 || Math.abs(now.top - last.top) > 1) {
        last = now;
        following = true;
        window.dispatchEvent(new Event("resize"));
        following = false;
      }
      frame = requestAnimationFrame(follow);
    };
    if (followsResize) frame = requestAnimationFrame(follow);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(frame);
    };
  }, [open, followsResize]);
  // Runs after the item and its menu left the page, when focus has already fallen back to the body.
  useEffect(
    () => () => {
      const there = place.current;
      if (!there?.list.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
      const next = there.list.children[Math.min(there.index, there.list.children.length - 1)];
      (next?.querySelector<HTMLElement>(FOCUSABLE) ?? there.list.closest("section, [role=region]")?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    },
    [],
  );
}

/**
 * Opens an item's three-dots menu on a right-click, at the pointer, and on the context-menu key and Shift+F10, under the
 * focused element (the rules are in `lib/itemMenu.ts`). Spread `bind` on the item, put `popup` inside it, and hand the
 * same `menu` to the three-dots button's own Dropdown, so both open the same items. `region` names the menu's landmark
 * as the button's does. A disabled menu leaves right-clicks alone.
 */
export function useItemMenu({
  menu,
  region,
  disabled = false,
}: {
  menu: MenuProps;
  region?: string;
  disabled?: boolean;
}): { bind: ReturnType<typeof menuTrigger>; popup: ReactNode } {
  const [at, setAt] = useState<MenuPoint | null>(null);
  // For a menu opened with the keyboard: where focus goes back to when it closes.
  const origin = useRef<HTMLElement | null>(null);
  const close = (restoreFocus: boolean) => {
    setAt(null);
    const back = origin.current;
    origin.current = null;
    if (restoreFocus && back?.isConnected) back.focus();
  };
  // The item the menu belongs to, read when it opens: the menu closes when the page scrolls under it or the window resizes.
  const item = useRef<Element | null>(null);
  const bind = menuTrigger((point, byKey, target) => {
    origin.current = byKey && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    item.current = target instanceof Element ? target : null;
    setAt(point);
  }, !disabled);
  useMenuLifetime(at !== null, () => item.current, () => close(true));
  // The anchor is fixed to the window, but a transformed ancestor (the flashcard stage's `perspective`) becomes the
  // containing block of a fixed element and moves it, so the menu is drawn in the document's body, where none can be.
  const popup: ReactNode = at
    ? createPortal(
        <Dropdown
          open
          autoFocus
          // The anchor is never clicked: the trigger only makes a click away close the menu.
          trigger={["click"]}
          onOpenChange={(next) => {
            if (!next) close(true);
          }}
          popupRender={
            region
              ? (list) => (
                  <div role="region" aria-label={region}>
                    {list}
                  </div>
                )
              : undefined
          }
          menu={{
            ...menu,
            onClick: (info) => {
              // Focus goes back before the item acts, so a dialog it opens returns focus there on close.
              close(true);
              menu.onClick?.(info);
            },
          }}
        >
          <span
            className="px-menu-anchor"
            style={{ left: at.x, top: at.y }}
            aria-hidden
          />
        </Dropdown>,
        document.body,
      )
    : null;
  return { bind, popup };
}

/**
 * An element that has a menu: right-click and the menu keys open `menu` on it (see `useItemMenu`). For items built in a
 * function or inside a conditional, where a hook can't be called.
 */
export function MenuItemArea({
  as: Tag = "li",
  menu,
  region,
  disabled,
  children,
  ...rest
}: {
  as?: "li" | "div" | "article";
  menu: MenuProps;
  region?: string;
  disabled?: boolean;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "onContextMenu" | "onKeyDown">) {
  const { bind, popup } = useItemMenu({ menu, region, disabled });
  return (
    <Tag {...rest} {...bind}>
      {children}
      {popup}
    </Tag>
  );
}
