import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";

/**
 * The map's keys, listed in its "…" menu and under Maps in Help > Keyboard shortcuts. Each row's label is
 * `map.keys.<id>`, and `either` marks keys that each do the same thing.
 */
export const MAP_KEYS: ReadonlyArray<{
  id: "select" | "rename" | "delete" | "move";
  keys: string[];
  either?: boolean;
}> = [
  { id: "select", keys: ["Tab"] },
  { id: "rename", keys: ["enter"] },
  { id: "delete", keys: ["delete", "backspace"], either: true },
  { id: "move", keys: ["arrows"] },
];

export type MapMenuItem = {
  key: string;
  label: string;
  icon?: IconName;
  /** Set for a choice among the group's items (a radio item), such as the layout. */
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};
export type MapMenuGroup = {
  key: string;
  label?: string;
  items: MapMenuItem[];
};

const ITEMS =
  "[role=menuitem]:not(:disabled), [role=menuitemradio]:not(:disabled)";

/**
 * The map's "…" menu: groups of actions, and below them `footer` (the keyboard shortcuts), outside the menu role so it
 * stays plain text. It grows out of its button; arrows move between items, Esc closes and gives focus back.
 */
export function MapMenu({
  label,
  groups,
  footer,
  disabled,
}: {
  label: string;
  groups: MapMenuGroup[];
  footer?: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = () =>
    wrap.current?.querySelector<HTMLButtonElement>(":scope > button");

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>(ITEMS)?.focus();
    const away = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  function close() {
    setOpen(false);
    trigger()?.focus();
  }
  function keys(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const entries = [
      ...(panel.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []),
    ];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? (at + 1) % entries.length
        : event.key === "ArrowUp"
          ? (at - 1 + entries.length) % entries.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? entries.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    entries[next]?.focus();
  }

  return (
    <div className="px-map-more" ref={wrap}>
      <IconButton
        icon="ellipsis"
        label={label}
        variant="ghost"
        menu
        expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <div className="px-map-more-panel" ref={panel} onKeyDown={keys}>
          <div role="menu" aria-label={label}>
            {groups.map((group) => (
              <div
                key={group.key}
                role="group"
                aria-label={group.label}
                className="px-map-more-group"
              >
                {group.label ? (
                  <div className="px-map-more-label" aria-hidden>
                    {group.label}
                  </div>
                ) : null}
                {group.items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role={
                      item.checked === undefined ? "menuitem" : "menuitemradio"
                    }
                    aria-checked={item.checked}
                    disabled={item.disabled}
                    onClick={() => {
                      close();
                      item.onSelect();
                    }}
                  >
                    {item.checked !== undefined ? (
                      <span className="px-map-more-check" aria-hidden>
                        {item.checked ? <Icon name="check" size={15} /> : null}
                      </span>
                    ) : item.icon ? (
                      <Icon name={item.icon} size={15} />
                    ) : null}
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
          {footer}
        </div>
      ) : null}
    </div>
  );
}
