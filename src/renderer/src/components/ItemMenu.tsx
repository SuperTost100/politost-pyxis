import { Dropdown, type MenuProps } from "antd";
import { useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { menuTrigger, type MenuPoint } from "../lib/itemMenu";
import "./ItemMenu.css";

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
  const bind = menuTrigger((point, byKey) => {
    origin.current = byKey && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAt(point);
  }, !disabled);
  const popup: ReactNode = at ? (
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
      <span className="px-menu-anchor" style={{ left: at.x, top: at.y }} aria-hidden />
    </Dropdown>
  ) : null;
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
