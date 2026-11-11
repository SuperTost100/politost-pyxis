import { Dropdown, type MenuProps } from "antd";
import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { menuTrigger, type MenuPoint } from "../lib/itemMenu";
import "./ItemMenu.css";

/**
 * Closes a menu once what it hangs from has moved on the screen: the page scrolled, the window was resized or the layout
 * shifted (a group appearing above it). A menu left behind would float over other items, away from the one it acts on.
 * `anchor` reads the element when the menu is open; `close` is called at most once.
 */
export function useCloseWhenMoved(open: boolean, anchor: () => Element | null | undefined, close: () => void): void {
  const latest = useRef({ anchor, close });
  latest.current = { anchor, close };
  useEffect(() => {
    const element = open ? latest.current.anchor() : null;
    if (!element) return;
    const start = element.getBoundingClientRect();
    let frame = 0;
    const check = () => {
      const now = element.getBoundingClientRect();
      if (!element.isConnected || Math.abs(now.left - start.left) > 1 || Math.abs(now.top - start.top) > 1) {
        latest.current.close();
        return;
      }
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [open]);
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
  // The item the menu belongs to, read when it opens: the menu closes when the item moves.
  const item = useRef<Element | null>(null);
  const bind = menuTrigger((point, byKey, target) => {
    origin.current = byKey && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    item.current = target instanceof Element ? target : null;
    setAt(point);
  }, !disabled);
  useCloseWhenMoved(at !== null, () => item.current, () => close(true));
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
