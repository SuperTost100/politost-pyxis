import { Button as AntButton, Dropdown, type MenuProps } from "antd";
import { useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type MutableRefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { menuTrigger, type MenuPoint } from "../lib/itemMenu";
import { Icon } from "./Icon";
import "./Button.css";
import "./ItemMenu.css";

/** A submenu's arrow is drawn, not read: its item is named by its label alone. */
const submenuArrow = <Icon name="chevron-right" size={14} className="px-item-menu-arrow" />;

/**
 * How a menu stays inside the window: it flips to the other side of its pointer or button when there is no room, and
 * moves along the edge when neither side has room. A menu taller than the window scrolls inside itself (`ItemMenu.css`).
 * antd types this option with the flips only, but hands the whole object to the trigger, which also reads the shifts.
 */
const FIT_IN_WINDOW = { adjustX: 1 as const, adjustY: 1 as const, shiftX: true, shiftY: true };

/**
 * A submenu opens beside its item, on the left when the right has no room, and moves up when it would end below the
 * window, as desktop menus do.
 */
const submenuPlacements: MenuProps["builtinPlacements"] = {
  rightTop: { points: ["tl", "tr"], overflow: { adjustX: 1, shiftY: true } },
};

/**
 * The items as the menu draws them: a submenu (an item with `children`) gets the drawn arrow and stays inside the window,
 * and choosing an item closes the menu, gives focus back to where the menu was opened and then runs the item, so a
 * dialog the item opens returns focus there when it closes.
 */
function drawn(menu: MenuProps, close: () => void): MenuProps {
  return {
    expandIcon: submenuArrow,
    builtinPlacements: submenuPlacements,
    // A submenu opens inside the menu's landmark, or the menu itself when it has none, so it is fixed to the window with
    // it instead of loose in the document's body.
    getPopupContainer: (node) => node.closest<HTMLElement>("[role=region], .px-item-menu") ?? document.body,
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
function MenuRegion({
  label,
  open,
  arrow,
  children,
}: {
  label: string;
  open: boolean;
  /** An arrow pressed on the button before the menu took the focus: the menu then takes it on its first or last item. */
  arrow?: MutableRefObject<"first" | "last" | null>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const take = () => {
      const region = ref.current;
      const edge = arrow?.current;
      const items = edge ? [...(region?.querySelectorAll<HTMLElement>(ROOT_ITEMS) ?? [])] : [];
      const target = edge ? (edge === "first" ? items[0] : items.at(-1)) : region?.querySelector<HTMLElement>(".ant-dropdown-menu");
      if (!target) return;
      target.focus({ preventScroll: true });
      if (arrow) arrow.current = null;
    };
    // At once, before the next key press when the popup is ready, and a frame later when it was not, unless the focus is
    // already in the menu.
    take();
    const frame = requestAnimationFrame(() => {
      if (!ref.current?.contains(document.activeElement)) take();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (arrow) arrow.current = null;
    };
  }, [open, arrow]);
  return (
    <div role="region" aria-label={label} ref={ref}>
      {children}
    </div>
  );
}

/** The items of a menu's first level that can be chosen, a submenu's row among them. */
const ROOT_ITEMS =
  ".ant-dropdown-menu-root > [role=menuitem]:not([aria-disabled=true]), .ant-dropdown-menu-root > li > [role=menuitem]:not([aria-disabled=true])";

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
  // Where the item sat in its list, to find its neighbour if it is removed with the menu open, and the section around the
  // list, which stays when the list goes with its last item.
  const place = useRef<{ list: Element; index: number; home: Element | null } | null>(null);
  useEffect(() => {
    const element = open ? latest.current.anchor() : null;
    if (!element) {
      place.current = null;
      return;
    }
    const row = element.closest("li, section") ?? element;
    place.current = row.parentElement
      ? {
          list: row.parentElement,
          index: [...row.parentElement.children].indexOf(row),
          home: row.parentElement.closest("section, [role=region]"),
        }
      : null;
    const start = element.getBoundingClientRect();
    // A scroll event is delivered a frame after the scroll, so one caused by what happened before the menu opened (a
    // focus that scrolled its item into view) can arrive after it. Only a scroll that moved the item counts.
    const onScroll = (event: Event) => {
      const scroller = event.target;
      if (scroller !== document && !(scroller instanceof Node && scroller.contains(element))) return;
      const now = element.getBoundingClientRect();
      if (Math.abs(now.left - start.left) > 1 || Math.abs(now.top - start.top) > 1) latest.current.close();
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
    let last = start;
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
      if (!there || (document.activeElement && document.activeElement !== document.body)) return;
      // The list can go with its last item: the section around it is what is left.
      const next = there.list.isConnected
        ? there.list.children[Math.min(there.index, there.list.children.length - 1)]
        : undefined;
      const home = there.home?.isConnected ? there.home : null;
      (next?.querySelector<HTMLElement>(FOCUSABLE) ?? home?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    },
    [],
  );
}

/**
 * What a scroll that closes a menu does with the focus: a menu opened with the keyboard holds it, and it goes back to
 * `trigger` as it does on every other way a menu closes. It does not scroll to it, since the student has just scrolled
 * away. A menu opened with the pointer leaves the focus where the click put it.
 */
export function leaveMenuTo(trigger: HTMLElement | null | undefined): void {
  const active = document.activeElement;
  if (trigger?.isConnected && active instanceof Element && active.closest(".px-item-menu")) trigger.focus({ preventScroll: true });
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
  // Whether the menu is open, kept with the events rather than the render, which may not have happened yet when the next
  // event of the same key press arrives.
  const shown = useRef(false);
  const close = (restoreFocus: boolean, scrollBack = true) => {
    shown.current = false;
    setAt(null);
    const back = origin.current;
    origin.current = null;
    // A scroll closes the menu from under the student's hand: the focus goes back, but the page stays where they took it.
    if (restoreFocus && back?.isConnected) back.focus({ preventScroll: !scrollBack });
  };
  // The item the menu belongs to, read when it opens: the menu closes when the page scrolls under it or the window resizes.
  const item = useRef<Element | null>(null);
  const bind = menuTrigger(
    (point, byKey, target) => {
      shown.current = true;
      origin.current = byKey && document.activeElement instanceof HTMLElement ? document.activeElement : null;
      item.current = target instanceof Element ? target : null;
      setAt(point);
    },
    !disabled,
    () => shown.current,
  );
  useMenuLifetime(at !== null, () => item.current, () => close(true, false));
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
          autoAdjustOverflow={FIT_IN_WINDOW}
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
} & Omit<HTMLAttributes<HTMLElement>, "onContextMenu" | "onKeyDown" | "onKeyUp" | "onPointerDown">) {
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
  // The menu takes the focus as it opens. An arrow pressed on the button before it could is kept for the menu, so a
  // quick Enter and down arrow still reach the first item.
  const arrow = useRef<"first" | "last" | null>(null);
  // The menu closes when the page scrolls, and follows its button when the window is resized or the layout shifts it.
  useMenuLifetime(
    open,
    () => document.getElementById(id),
    () => {
      setOpen(false);
      leaveMenuTo(document.getElementById(id));
    },
    true,
  );
  const dots = children === undefined;
  return (
    <Dropdown
      open={open}
      autoFocus
      trigger={["click"]}
      placement={align === "start" ? "bottomLeft" : "bottomRight"}
      rootClassName="px-item-menu"
      autoAdjustOverflow={FIT_IN_WINDOW}
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
        <MenuRegion label={region ?? label} open={open} arrow={arrow}>
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
        onKeyDown={(event) => {
          if (!open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          arrow.current = event.key === "ArrowDown" ? "first" : "last";
        }}
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
