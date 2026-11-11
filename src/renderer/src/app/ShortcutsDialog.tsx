import { Modal } from "antd";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { goPages } from "@shared/menu";
import { MAP_KEYS } from "../features/maps/MapMenu";
import "./ShortcutsDialog.css";

/** Keys by name: `mod` is Command on macOS and Ctrl elsewhere. Anything else is shown as typed. */
type Key = string;
/** `label` names a string outside `shortcuts.rows`, and `either` lists keys that each do the same thing. */
type Row = { id: string; keys: Key[]; label?: string; either?: boolean };
type Group = { id: string; rows: Row[] };

function groups(mac: boolean): Group[] {
  return [
    {
      id: "general",
      rows: [
        { id: "newExam", keys: ["mod", "N"] },
        { id: "newChat", keys: ["mod", "shift", "N"] },
        { id: "search", keys: ["mod", "K"] },
        { id: "settings", keys: ["mod", "comma"] },
        // The sections' number keys, in the sidebar's order (`goPages`): goAsk, goExams, goMaps…
        ...goPages.map((page) => ({
          id: `go${page.command[0]!.toUpperCase()}${page.command.slice(1)}`,
          keys: ["mod", page.accelerator.split("+").at(-1)!],
        })),
        { id: "back", keys: mac ? ["mod", "bracket"] : ["alt", "left"] },
        { id: "shortcuts", keys: ["mod", "slash"] },
        { id: "zoomIn", keys: ["mod", "plus"] },
        { id: "zoomOut", keys: ["mod", "minus"] },
        { id: "actualSize", keys: ["mod", "0"] },
      ],
    },
    {
      id: "ask",
      rows: [
        { id: "send", keys: ["enter"] },
        { id: "newLine", keys: ["shift", "enter"] },
        { id: "stop", keys: ["esc"] },
      ],
    },
    {
      id: "cards",
      rows: [
        { id: "flip", keys: ["space"] },
        { id: "rate", keys: ["1–4"] },
        { id: "undoCard", keys: ["U"] },
        { id: "editCard", keys: ["E"] },
        { id: "suspendCard", keys: ["S"] },
        { id: "deleteCard", keys: ["D"] },
      ],
    },
    {
      id: "maps",
      rows: MAP_KEYS.map((row) => ({ ...row, label: `map.keys.${row.id}` })),
    },
    {
      id: "quiz",
      rows: [
        { id: "pick", keys: ["1–4"] },
        { id: "next", keys: ["enter"] },
        { id: "dontKnow", keys: ["0"] },
        { id: "skip", keys: ["S"] },
        { id: "checkText", keys: ["mod", "enter"] },
      ],
    },
    {
      id: "whiteboard",
      rows: [
        { id: "undo", keys: ["mod", "Z"] },
        { id: "redo", keys: ["mod", "shift", "Z"] },
        { id: "pen", keys: ["P"] },
        { id: "eraser", keys: ["E"] },
      ],
    },
    {
      id: "python",
      rows: [{ id: "runCode", keys: ["mod", "enter"] }],
    },
  ];
}

const GLYPHS: Record<string, string> = {
  left: "←",
  comma: ",",
  slash: "/",
  bracket: "[",
  plus: "+",
  minus: "−",
  backspace: "⌫",
  arrows: "← ↑ → ↓",
};
const MAC_GLYPHS: Record<string, string> = { mod: "⌘", shift: "⇧", alt: "⌥" };

function KeyCap({ name, mac }: { name: Key; mac: boolean }) {
  const { t } = useTranslation();
  const word = (id: string) => t(`shortcuts.keys.${id}`);
  if (mac && MAC_GLYPHS[name]) {
    // The symbol is for the eye; screen readers get the key's name.
    const spoken =
      name === "mod"
        ? word("cmd")
        : name === "alt"
          ? word("option")
          : word("shift");
    return (
      <kbd>
        <span aria-hidden>{MAC_GLYPHS[name]}</span>
        <span className="visually-hidden">{spoken}</span>
      </kbd>
    );
  }
  if (GLYPHS[name]) {
    return (
      <kbd>
        <span aria-hidden>{GLYPHS[name]}</span>
        <span className="visually-hidden">{word(name)}</span>
      </kbd>
    );
  }
  return (
    <kbd>
      {name === "mod"
        ? word("ctrl")
        : /^[a-z]+$/.test(name)
          ? word(name)
          : name}
    </kbd>
  );
}

/** One row's keys: a combination, joined with + off the Mac, or keys that each do the same, joined with /. */
export function KeyCombo({ keys, either }: { keys: Key[]; either?: boolean }) {
  const { t } = useTranslation();
  const mac = window.pyxis.platform === "darwin";
  return keys.map((key, index) => (
    <Fragment key={key}>
      {index > 0 && (either || !mac) ? (
        <span aria-hidden>{either ? "/" : "+"}</span>
      ) : null}
      {/* Screen readers hear "or" between keys that each work, so they don't sound like a combination. */}
      {index > 0 && either ? (
        <span className="visually-hidden">{t("shortcuts.or")}</span>
      ) : null}
      <KeyCap name={key} mac={mac} />
    </Fragment>
  ));
}

/** Every shortcut in the app: the menu's and the keys pages answer to. Opens from Help > Keyboard shortcuts. */
export function ShortcutsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const mac = window.pyxis.platform === "darwin";
  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={t("shortcuts.title")}
      footer={null}
      width={560}
      className="px-shortcuts"
      destroyOnHidden
    >
      {/* The list can be taller than the window, so keyboard users need a stop that scrolls it. */}
      <div
        className="px-shortcuts-body"
        tabIndex={0}
        role="region"
        aria-label={t("shortcuts.title")}
      >
        <p className="small px-shortcuts-lead">
          {t("shortcuts.lead")} {mac ? null : t("shortcuts.altHint")}
        </p>
        {groups(mac).map((group) => (
          <section key={group.id} aria-labelledby={`px-shortcuts-${group.id}`}>
            <h3 id={`px-shortcuts-${group.id}`} className="label">
              {t(`shortcuts.groups.${group.id}`)}
            </h3>
            <dl>
              {group.rows.map((row) => (
                <div className="px-shortcuts-row" key={row.id}>
                  <dt>{t(row.label ?? `shortcuts.rows.${row.id}`)}</dt>
                  <dd>
                    <KeyCombo keys={row.keys} either={row.either} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
