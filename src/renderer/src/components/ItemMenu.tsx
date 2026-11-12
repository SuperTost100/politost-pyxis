import { Button as AntButton, Dropdown, type MenuProps } from "antd";
import { useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type MutableRefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { menuTrigger, type MenuPoint } from "../lib/itemMenu";
import { Icon, type IconName } from "./Icon";
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
 * A submenu opens beside its menu, never over it: on the right of its item, on the left when the right has no room, and
 * moved up when it would end below the window, as desktop menus do. The offset takes it past the menu's 6px padding with
 * a 4px gap, and lines its first item up with the item it grows from; on the left the trigger mirrors it.
 */
const submenuPlacements: MenuProps["builtinPlacements"] = {
  rightTop: { points: ["tl", "tr"], offset: [10, -6], overflow: { adjustX: 1, shiftX: true, shiftY: true } },
};

/** The room a submenu keeps from the window's edges and from the item it grows from. */
const EDGE = 8;
const GAP = 4;

/**
 * When neither side of the menu has room for a submenu (a very narrow window), the trigger moves it along the window's
 * edge and over its menu. It then moves down below the item that opened it, or above it when there is more room there,
 * so that item stays in sight, kept inside the window, and it scrolls inside itself when it is taller than that room. The card inside the
 * submenu is moved, not the box the trigger places, so the trigger's next alignment does not undo it.
 *
 * The answer comes from what does not depend on the answer: the menu's box, the row that opened the submenu, the window
 * and the submenu's natural size (its content's height, whatever limit it has now). Where the trigger placed the box and
 * how tall the limit made it never enter the decision, so the same inputs give the same result and the placement
 * settles, instead of limiting the box, measuring the shorter box, lifting the limit and starting again.
 */
function keepOpenerInSight(root: HTMLElement) {
  for (const popup of root.querySelectorAll<HTMLElement>(".ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden)")) {
    const card = popup.querySelector<HTMLElement>(":scope > ul");
    const opener = root.querySelector<HTMLElement>(
      ".ant-dropdown-menu-root > .ant-dropdown-menu-submenu-open > .ant-dropdown-menu-submenu-title",
    );
    const menu = opener?.closest<HTMLElement>(".ant-dropdown-menu-root");
    if (!card || !opener || !menu) continue;
    const box = popup.getBoundingClientRect();
    const row = opener.getBoundingClientRect();
    const sides = menu.getBoundingClientRect();
    // The card's content height, which a limit on the card does not change, and its borders.
    const natural = card.scrollHeight + card.offsetHeight - card.clientHeight;
    const beside = sides.right + GAP + box.width <= innerWidth || sides.left - GAP - box.width >= 0;
    let transform = "";
    let maxHeight = "";
    if (!beside) {
      const below = innerHeight - EDGE - (row.bottom + GAP);
      const above = row.top - GAP - EDGE;
      const room = Math.max(below, above);
      const height = Math.min(natural, room);
      const top = below >= natural || below >= above ? row.bottom + GAP : row.top - GAP - height;
      // The trigger keeps it inside the document, which a page wider than the window outgrows: inside the window here.
      const left = Math.max(EDGE, Math.min(box.left, innerWidth - EDGE - box.width));
      transform = `translate(${Math.round(left - box.left)}px, ${Math.round(top - box.top)}px)`;
      if (height < natural) maxHeight = `${Math.floor(height)}px`;
    }
    if (card.style.transform !== transform) card.style.transform = transform;
    if (card.style.maxHeight !== maxHeight) card.style.maxHeight = maxHeight;
  }
}

/**
 * Holds a menu's list and the submenus drawn inside it, and keeps the item that opened a submenu in sight
 * (`keepOpenerInSight`) each time the trigger places the submenu.
 */
function SubmenuRoom({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        keepOpenerInSight(root);
        // What was just written is not a change to react to.
        observer.takeRecords();
      });
    };
    const observer: MutationObserver = new MutationObserver(check);
    observer.observe(root, { attributes: true, attributeFilter: ["style", "class"], subtree: true, childList: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div className="px-submenu-room" ref={ref}>
      {children}
    </div>
  );
}

/**
 * The items as the menu draws them: a submenu (an item with `children`) gets the drawn arrow and stays inside the window,
 * and choosing an item closes the menu, gives focus back to where the menu was opened and then runs the item, so a
 * dialog the item opens returns focus there when it closes.
 */
function drawn(menu: MenuProps, close: () => void): MenuProps {
  return {
    expandIcon: submenuArrow,
    builtinPlacements: submenuPlacements,
    // A submenu opens inside its menu (in the menu's landmark when it has one), so it is fixed to the window with it
    // instead of loose in the document's body, and its menu keeps the item that opened it in sight (`SubmenuRoom`).
    getPopupContainer: (node) => node.closest<HTMLElement>(".px-submenu-room") ?? document.body,
    ...menu,
    onClick: (info) => {
      // Chosen with Enter: the focus goes back to the menu's item during the key press, so the press must end here,
      // or it would also click that item (a cover's button opens its details).
      if ("key" in info.domEvent) info.domEvent.preventDefault();
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
    // At once, before the next key press when the popup is ready, and on the next frames while it is not (a menu opened
    // again right after it closed is hidden for a few frames), until the focus is in the menu.
    take();
    let tries = 0;
    let frame = 0;
    const retry = () => {
      if (ref.current?.contains(document.activeElement)) return;
      take();
      if (++tries < 12) frame = requestAnimationFrame(retry);
    };
    frame = requestAnimationFrame(retry);
    return () => {
      cancelAnimationFrame(frame);
      if (arrow) arrow.current = null;
    };
  }, [open, arrow]);
  return (
    <div role="region" aria-label={label} ref={ref}>
      <SubmenuRoom>{children}</SubmenuRoom>
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
          popupRender={(list) =>
            region ? (
              <MenuRegion label={region} open>
                {list}
              </MenuRegion>
            ) : (
              <SubmenuRoom>{list}</SubmenuRoom>
            )
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
 * The button that opens a menu below it: by default the three dots, or another `icon` such as the composer's plus; with
 * `children`, a button that shows them followed by
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
  icon = "ellipsis",
  className,
  children,
  onOpenChange,
  focusAfterChoice,
}: {
  menu: MenuProps;
  label: string;
  /** The icon of a button without `children`. */
  icon?: IconName;
  region?: string;
  disabled?: boolean;
  align?: "start" | "end";
  size?: "sm" | "md";
  className?: string;
  children?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  /** Where the focus goes after a choice, when not back to the button, such as the field the student was typing in. */
  focusAfterChoice?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Each opening draws the menu anew: a closed popup keeps its last render, so its region would not see it open again
  // and would not take the focus.
  const [openings, setOpenings] = useState(0);
  // The Dropdown hands its child a ref of its own, so the button is found by its id to give focus back.
  const id = useId();
  const report = useRef(onOpenChange);
  report.current = onOpenChange;
  useEffect(() => report.current?.(open), [open]);
  // A disabled button closes the menu it opened, as when the map starts building.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const close = (chose = false) => {
    setOpen(false);
    const back = () => (chose && focusAfterChoice ? focusAfterChoice() : document.getElementById(id)?.focus());
    back();
    // A menu closed by Escape before any item had the focus moves it to an item once more as it leaves; the button
    // takes it back a frame later when it is left in the closing menu or nowhere.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || active.closest(".px-item-menu")) back();
    });
  };
  // Escape pressed before an item has the focus closes the menu with the focus nowhere in it, so it is noted as it is
  // pressed, before the menu goes, and the focus still goes back to the button.
  const escaped = useRef(false);
  useEffect(() => {
    if (!open) return;
    escaped.current = false;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") escaped.current = true;
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);
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
        if (next) {
          setOpenings((count) => count + 1);
          return setOpen(true);
        }
        // Escape, or a choice, leaves the focus in the menu as it closes, so it goes back to the button. A click away
        // or on the button leaves it where the click put it.
        const fromMenu = document.activeElement instanceof Element && document.activeElement.closest(".px-item-menu");
        if (fromMenu || escaped.current) close();
        else setOpen(false);
      }}
      popupRender={(list) => (
        <MenuRegion key={openings} label={region ?? label} open={open} arrow={arrow}>
          {list}
        </MenuRegion>
      )}
      menu={drawn(menu, () => close(true))}
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
        icon={dots ? <Icon name={icon} size={size === "sm" ? 16 : 18} /> : undefined}
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
