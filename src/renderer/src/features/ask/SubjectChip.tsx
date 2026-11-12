import type { MenuProps } from "antd";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/Icon";
import { MenuButton } from "../../components/ItemMenu";
import type { ChipState } from "./scope";
import "./SubjectChip.css";

/** What the student picks from the chip: a subject, the whole Library, Pyxis's choice, or the sources already chosen. */
export type SubjectPick = { kind: "subject"; name: string } | { kind: "library" } | { kind: "auto" };

// Menu keys go into the menu's own selectors for the arrow keys, so they are plain words; a subject is keyed by its place.
const AUTO = "auto";
const LIBRARY = "library";
const PICKED = "picked";
const subjectKey = (index: number) => `subject-${index}`;

/**
 * The chat's subject, in its header: the subject Pyxis picked or the student chose, the whole Library, Pyxis's choice to
 * come, or an older chat's sources picked by hand. Its menu lists the subjects, then the whole Library; on a new chat
 * it also offers to let Pyxis pick. The label says who chose, for a screen reader.
 */
export function SubjectChip({
  chat,
  state,
  subjects,
  allowAuto,
  disabled,
  onPick,
  focusAfterChoice,
}: {
  /** The chat it belongs to, "" for a new one. */
  chat: string;
  state: ChipState;
  subjects: readonly string[];
  /** A new chat can go back to letting Pyxis pick. */
  allowAuto: boolean;
  disabled?: boolean;
  onPick: (pick: SubjectPick) => void;
  /** The field the student goes back to after choosing. */
  focusAfterChoice?: () => void;
}) {
  const { t } = useTranslation();
  // A chat can keep a subject that has since been renamed or removed in the Library; it stays in the list while chosen.
  const names = state.kind === "subject" && !subjects.includes(state.name) ? [...subjects, state.name] : [...subjects];
  const current =
    state.kind === "subject"
      ? subjectKey(names.indexOf(state.name))
      : state.kind === "library"
        ? LIBRARY
        : state.kind === "auto"
          ? AUTO
          : PICKED;
  const choice = (key: string, label: string) => ({
    key,
    role: "menuitemradio",
    "aria-checked": key === current,
    icon: (
      <span className="px-item-menu-check" aria-hidden>
        {key === current ? <Icon name="check" size={15} /> : null}
      </span>
    ),
    label: (
      <span className="px-item-menu-choice" title={label}>
        <span>{label}</span>
      </span>
    ),
  });
  const items = [
    ...(state.kind === "picked" ? [choice(PICKED, t("ask.chip.pickedItem", { count: state.count })), { type: "divider" as const }] : []),
    ...(allowAuto || state.kind === "auto" ? [choice(AUTO, t("ask.chip.letPyxis"))] : []),
    ...names.map((name, index) => choice(subjectKey(index), name)),
    { type: "divider" as const },
    choice(LIBRARY, t("ask.chip.library")),
  ] as MenuProps["items"];
  const text =
    state.kind === "subject"
      ? state.name
      : state.kind === "library"
        ? t("ask.chip.library")
        : state.kind === "auto"
          ? t("ask.chip.auto")
          : t("ask.chip.picked", { count: state.count });
  const label =
    state.kind === "subject"
      ? t(state.by === "pyxis" ? "ask.chip.labelPyxis" : "ask.chip.labelStudent", { name: state.name })
      : state.kind === "library"
        ? t("ask.chip.labelLibrary")
        : state.kind === "auto"
          ? t("ask.chip.labelAuto")
          : t("ask.chip.labelPicked", { count: state.count });
  // A new value fades up in place: Pyxis's pick after the first answer, or the student's choice. Opening another chat
  // shows its subject at once, as nothing animates on the way between chats.
  const textRef = useRef<HTMLSpanElement>(null);
  const before = useRef({ chat, text });
  useEffect(() => {
    const was = before.current;
    before.current = { chat, text };
    if (was.text === text || (was.chat !== chat && was.chat !== "")) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    textRef.current?.animate(
      still ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }],
      { duration: still ? 120 : 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
    );
  }, [chat, text]);
  return (
    <MenuButton
      menu={{
        items,
        onClick: ({ key }) => {
          if (key === current || key === PICKED) return;
          const name = names[Number(key.replace("subject-", ""))];
          onPick(key === AUTO ? { kind: "auto" } : key === LIBRARY || !name ? { kind: "library" } : { kind: "subject", name });
        },
      }}
      label={label}
      region={t("ask.chip.menu")}
      size="sm"
      align="end"
      disabled={disabled}
      focusAfterChoice={focusAfterChoice}
      className={`ask-subject-chip is-${state.kind}`}
    >
      <span ref={textRef} className="ask-subject-chip-text" title={text}>
        {text}
      </span>
    </MenuButton>
  );
}
