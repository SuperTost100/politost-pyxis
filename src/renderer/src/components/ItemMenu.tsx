import { Button as AntButton, Dropdown, type MenuProps } from "antd";
import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { menuTrigger, type MenuPoint } from "../lib/itemMenu";
import { Icon } from "./Icon";
import "./Button.css";
import "./ItemMenu.css";

/** A submenu's arrow is drawn, not read: its item is named by its label alone. */
const submenuArrow = <Icon name="chevron-right" size={14} className="px-item-menu-arrow" />;

/**
 * The items as the menu draws them: a submenu (an item with `children`) gets the drawn arrow, and choosing an item closes
 * the menu, gives focus back to where the menu was opened and then runs the item, so a dialog the item opens returns
 * focus there when it closes.
 */
function drawn(menu: MenuProps, close: () => void): MenuProps {
  return {
    expandIcon: submenuArrow,
    // A submenu opens inside the menu's landmark, not loose in the document's body.
    getPopupContainer: (node) => node.closest<HTMLElement>("[role=region]") ?? document.body,
    ...menu,
    onClick: (info) => {
      close();
      menu.onClick?.(info);
    },
  };
}

/**
 * The landmark a menu sits in, named like the button that opens it, since the menu is drawn in the document's body.
 * Each time the menu opens it takes the focus, so the arrow keys move through it at once: the popup's own focus would
 * land on this wrapper, which can't hold it.
 */
function MenuRegion({ label, open, children }: { label: string; open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLElement>(".ant-dropdown-menu")?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return (
    <div role="region" aria-label={label} ref={ref}>
      {children}
    </div>
  );
}

/**
 * Opens an item's three-dots menu on a right-click, at the pointer, and on the context-menu key and Shift+F10, under the
 * focused element (the rules are in `lib/itemMenu.ts`). Spread `bind` on the item, put `popup` inside it, and hand the
 * same `menu` to the three-dots button (`MenuButton`, or the button's own Dropdown), so both open the same items. An
 * item with `children` opens a submenu: the right arrow opens it, the left arrow and Escape close it. `region` names the
 * menu's landmark as the button's does. `open` says whether the menu is open, for an item that keeps its hover look
 * meanwhile. A disabled menu leaves right-clicks alone.
 */
export function useItemMenu({
  menu,
  region,
  disabled = false,
}: {
  menu: MenuProps;
  region?: string;
  disabled?: boolean;
}): { bind: ReturnType<typeof menuTrigger>; popup: ReactNode; open: boolean } {
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
  // The anchor is fixed to the window, but a transformed ancestor (the flashcard stage's `perspective`) becomes the
  // containing block of a fixed element and moves it, so the menu is drawn in the document's body, where none can be.
  const popup: ReactNode = at
    ? createPortal(
        <Dropdown
          open
          autoFocus
          // The anchor is never clicked: the trigger only makes a click away close the menu.
          trigger={["click"]}
          rootClassName="px-item-menu"
          onOpenChange={(next) => {
            if (!next) close(true);
          }}
          popupRender={
            region
              ? (list) => (
                  <MenuRegion label={region} open>
                    {list}
                  </MenuRegion>
                )
              : undefined
          }
          menu={drawn(menu, () => close(true))}
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
  return { bind, popup, open: at !== null };
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

/**
 * The button that opens a menu below it: by default the three dots; with `children`, a button that shows them followed by
 * a chevron, such as a map switcher. `label` is its name for screen readers, which for a switcher says what it switches
 * and what is chosen now. The menu grows from the button, lines up with its right edge (or its
 * left with `align="start"`), and closes on Escape, a click away or a choice, giving focus back to the button. Hand it the
 * same `menu` as the item's right-click (`useItemMenu`). `onOpenChange` tells the item, which may keep its hover look.
 */
export function MenuButton({
  menu,
  label,
  region,
  disabled,
  align = "end",
  size = "md",
  className,
  children,
  onOpenChange,
}: {
  menu: MenuProps;
  label: string;
  region?: string;
  disabled?: boolean;
  align?: "start" | "end";
  size?: "sm" | "md";
  className?: string;
  children?: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  // The Dropdown hands its child a ref of its own, so the button is found by its id to give focus back.
  const id = useId();
  const report = useRef(onOpenChange);
  report.current = onOpenChange;
  useEffect(() => report.current?.(open), [open]);
  // A disabled button closes the menu it opened, as when the map starts building.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const close = () => {
    setOpen(false);
    document.getElementById(id)?.focus();
  };
  const dots = children === undefined;
  return (
    <Dropdown
      open={open}
      autoFocus
      trigger={["click"]}
      placement={align === "start" ? "bottomLeft" : "bottomRight"}
      rootClassName="px-item-menu"
      disabled={disabled}
      onOpenChange={(next) => {
        if (next) return setOpen(true);
        // Escape, or a choice, leaves the focus in the menu as it closes, so it goes back to the button. A click away
        // or on the button leaves it where the click put it.
        const fromMenu = document.activeElement instanceof Element && document.activeElement.closest(".px-item-menu");
        if (fromMenu) close();
        else setOpen(false);
      }}
      popupRender={(list) => (
        <MenuRegion label={region ?? label} open={open}>
          {list}
        </MenuRegion>
      )}
      menu={drawn(menu, close)}
    >
      <AntButton
        id={id}
        type={dots ? "text" : "default"}
        size={size === "sm" ? "small" : "middle"}
        className={[
          "px-btn",
          dots ? "px-btn-ghost px-iconbtn" : "px-btn-secondary px-menu-button",
          size === "sm" && "px-btn-sm",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={dots ? label : undefined}
        disabled={disabled}
        icon={dots ? <Icon name="ellipsis" size={size === "sm" ? 16 : 18} /> : undefined}
      >
        {dots ? null : (
          <>
            <span className="px-menu-button-text">{children}</span>
            <Icon name="chevron-down" size={14} />
          </>
        )}
      </AntButton>
    </Dropdown>
  );
}
