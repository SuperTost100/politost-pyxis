import {
  BookOpen,
  CircleHelp,
  Ellipsis,
  GraduationCap,
  Monitor,
  Moon,
  Network,
  PanelLeft,
  Search,
  Settings,
  SquarePen,
  Sun,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import type { ThemeSource } from "@shared/bridge";
import { RenameField, type ChatActions } from "../../features/ask/chatActions";
import { JobsButton } from "../../features/jobs/JobsButton";
import { useChats, useProfile } from "../../lib/queries";
import { useAppState } from "../app-state";
import { doorTarget } from "../doors";
import "./Sidebar.css";

/** How many recent chats the sidebar lists; "All chats" opens the rest in the search. */
const RECENT = 20;
const FOLD_KEY = "pyxis.side";
// Below this page width the sidebar folds by itself so the page keeps room: the smallest window is 960px, where Settings
// shows its own list beside each section, and zoom makes the page narrower still.
const NARROW = window.matchMedia("(max-width: 1099px)");
const subscribeNarrow = (change: () => void) => {
  NARROW.addEventListener("change", change);
  return () => NARROW.removeEventListener("change", change);
};

/** Whether the sidebar was left folded, on this computer. Storage can be missing or blocked, and then it opens. */
function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === "folded";
  } catch {
    return false;
  }
}

/** A menu accelerator as the keyboard shows it: ⇧⌘N on macOS, Ctrl+Shift+N elsewhere. */
export function keyLabel(accelerator: string): string {
  const parts = accelerator.split("+");
  if (window.pyxis.platform !== "darwin")
    return parts.map((part) => (part === "CmdOrCtrl" ? "Ctrl" : part)).join("+");
  const glyph: Record<string, string> = { CmdOrCtrl: "⌘", Shift: "⇧", Alt: "⌥" };
  // macOS writes the modifiers in a fixed order, Shift before Command.
  const order = ["Shift", "Alt", "CmdOrCtrl"];
  const mods = parts.slice(0, -1).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return mods.map((part) => glyph[part] ?? part).join("") + parts[parts.length - 1];
}

type Item = { key: string; to: string; icon: LucideIcon; label: string; accelerator: string; current: boolean };

/**
 * The app's one sidebar (pyxis-mockups app/shell.js, the Scheda style): the mark, the search, the sections, the recent
 * chats and the profile at the foot. Folded, it is a column of icons with each name on hover. A running exam
 * simulation hides everything that leads to Chiedi.
 */
export function Sidebar({
  pathname,
  simulation,
  onSearch,
  actions,
}: {
  pathname: string;
  /** True while an exam simulation runs, and while that is still being checked. */
  simulation: boolean;
  onSearch: (scope: "all" | "chats") => void;
  actions: ChatActions;
}) {
  const { t } = useTranslation();
  const [chosen, setFolded] = useState(readFolded);
  const narrow = useSyncExternalStore(subscribeNarrow, () => NARROW.matches);
  const folded = chosen || narrow;
  const chats = useChats();
  const library = pathname.startsWith("/exams/library");
  // The Library has its own row, so Exams never leads back into it.
  const examsTo = doorTarget("exams", pathname);
  const items: Item[] = [
    ...(simulation
      ? []
      : [
          {
            key: "chat",
            to: "/ask",
            icon: SquarePen,
            label: t("ask.new"),
            accelerator: "CmdOrCtrl+Shift+N",
            current: pathname === "/ask",
          },
        ]),
    {
      key: "exams",
      to: examsTo.startsWith("/exams/library") ? "/exams" : examsTo,
      icon: GraduationCap,
      label: t("doors.exams"),
      accelerator: "CmdOrCtrl+2",
      current: simulation || (!library && (pathname.startsWith("/exams") || pathname.startsWith("/plans"))),
    },
    {
      key: "maps",
      to: doorTarget("maps", pathname),
      icon: Network,
      label: t("doors.maps"),
      accelerator: "CmdOrCtrl+5",
      current: pathname.startsWith("/maps"),
    },
    {
      key: "library",
      to: "/exams/library",
      icon: BookOpen,
      label: t("nav.library"),
      accelerator: "CmdOrCtrl+3",
      current: library,
    },
  ];

  // Folding swaps the button for the mark and back, so a click that swaps them brings the focus along.
  const foldButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    foldButton.current?.focus();
  }, [folded]);

  function fold() {
    const next = !chosen;
    refocus.current = foldButton.current === document.activeElement;
    setFolded(next);
    try {
      localStorage.setItem(FOLD_KEY, next ? "folded" : "open");
    } catch {
      // The fold still holds until the window closes.
    }
  }
  const foldLabel = folded ? t("side.unfold") : t("side.fold");
  // Open, the fold button sits at the top beside the traffic lights. Folded, the mark itself unfolds the sidebar: it
  // turns into the sidebar icon on hover, as in Tost Work. A narrow page keeps the sidebar folded, so there it stays the
  // way back to Chiedi.
  const brand =
    folded && !narrow ? (
      <button
        ref={foldButton}
        type="button"
        className="px-side-brand px-side-unfold"
        data-tip={foldLabel}
        aria-label={foldLabel}
        aria-expanded={false}
        onClick={fold}
      >
        <PyxisMark />
        <PanelLeft className="px-side-unfold-icon" size={18} strokeWidth={1.75} aria-hidden />
      </button>
    ) : simulation ? (
      <span className="px-side-brand">
        <PyxisMark />
        <span>Pyxis</span>
      </span>
    ) : (
      <Link className="px-side-brand" to="/ask" aria-label="Pyxis">
        <PyxisMark />
        <span>Pyxis</span>
      </Link>
    );

  return (
    <aside className="px-side" data-folded={folded ? "" : undefined} aria-label={t("side.label")}>
      <div className="px-side-top">
        {folded || narrow ? null : (
          <button
            ref={foldButton}
            type="button"
            className="px-side-icon px-side-fold"
            data-tip={foldLabel}
            aria-label={foldLabel}
            aria-expanded
            onClick={fold}
          >
            <PanelLeft size={18} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>
      {brand}
      {simulation ? null : (
        <button
          type="button"
          className="px-side-search"
          data-tip={`${t("side.search")} · ${keyLabel("CmdOrCtrl+K")}`}
          aria-keyshortcuts={window.pyxis.platform === "darwin" ? "Meta+K" : "Control+K"}
          onClick={() => onSearch("all")}
        >
          <Search size={16} strokeWidth={1.75} aria-hidden />
          <span>{t("side.search")}</span>
          <kbd aria-hidden>{keyLabel("CmdOrCtrl+K")}</kbd>
        </button>
      )}
      <p className="px-side-label">{t("side.study")}</p>
      <nav className="px-side-nav" aria-label={t("doors.label")}>
        {items.map((item) => (
          <Link
            key={item.key}
            to={item.to}
            data-tip={item.label}
            aria-current={item.current ? "page" : undefined}
          >
            <item.icon size={18} strokeWidth={1.75} aria-hidden />
            <span>{item.label}</span>
            <kbd aria-hidden>{keyLabel(item.accelerator)}</kbd>
          </Link>
        ))}
        <JobsButton variant="row" />
      </nav>
      {simulation ? (
        <div className="px-side-fill" />
      ) : (
        <div className="px-side-recent">
          <p className="px-side-label">{t("side.recent")}</p>
          {chats.data && chats.data.length > 0 ? (
            <ul className="px-side-chats" aria-label={t("ask.history")}>
              {chats.data.slice(0, RECENT).map((chat) => {
                const edit = actions.editing(chat);
                const title = actions.nameOf(chat);
                return (
                  <li key={chat.id} className={edit ? "px-side-chat is-editing" : "px-side-chat"}>
                    {edit ? (
                      <RenameField edit={edit} label={t("ask.renameLabel")} />
                    ) : (
                      <>
                        <Link
                          to={`/ask/${chat.id}`}
                          aria-current={pathname === `/ask/${chat.id}` ? "page" : undefined}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            void actions.openMenu(chat);
                          }}
                        >
                          <span className="px-side-chat-title">{title}</span>
                          {chat.subject ? <span className="px-side-chat-sub">{chat.subject}</span> : null}
                        </Link>
                        <button
                          type="button"
                          className="px-side-chat-more"
                          aria-label={t("ask.chatActions", { title })}
                          onClick={() => void actions.openMenu(chat)}
                        >
                          <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {chats.isSuccess && chats.data.length === 0 ? (
            <p className="px-side-empty">{t("ask.chatsEmpty")}</p>
          ) : null}
          {chats.isSuccess && chats.data.length > 0 ? (
            <button type="button" className="px-side-all" onClick={() => onSearch("chats")}>
              {t("side.allChats")}
            </button>
          ) : null}
        </div>
      )}
      <ProfileFoot />
    </aside>
  );
}

/** The student's name and level at the foot, opening Profile, Settings, the theme and Help. */
function ProfileFoot() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { appearance, setTheme } = useAppState();
  const profile = useProfile();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const name = profile.data?.displayName.trim() ?? "";
  const level = profile.data ? t(`onboarding.levels.${profile.data.educationLevel}`) : "";
  const detail = [level, profile.data?.year.trim()].filter(Boolean).join(" · ");

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role=menuitem], [role=menuitemradio]")?.focus();
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  function close() {
    setOpen(false);
    button.current?.focus();
  }
  function go(path: string) {
    setOpen(false);
    navigate(path);
  }
  function keys(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const entries = [
      ...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem], [role=menuitemradio]") ?? []),
    ];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    entries[(at + step + entries.length) % entries.length]?.focus();
  }
  const themes: Array<{ source: ThemeSource; icon: LucideIcon }> = [
    { source: "light", icon: Sun },
    { source: "dark", icon: Moon },
    { source: "system", icon: Monitor },
  ];

  return (
    <div className="px-side-foot">
      <button
        ref={button}
        type="button"
        className="px-side-me"
        data-tip={name || t("side.profile")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="px-side-avatar" aria-hidden>
          {name ? name.charAt(0).toLocaleUpperCase() : <UserRound size={16} strokeWidth={1.75} />}
        </span>
        <span className="px-side-who">
          <b>{name || t("side.profile")}</b>
          {detail ? <small>{detail}</small> : null}
        </span>
        <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {open ? (
        <div ref={menu} className="px-side-menu" role="menu" aria-label={t("side.account")} onKeyDown={keys}>
          <button type="button" role="menuitem" onClick={() => go("/settings/profile")}>
            <UserRound size={16} strokeWidth={1.75} aria-hidden />
            {t("side.profile")}
          </button>
          <button type="button" role="menuitem" onClick={() => go("/settings")}>
            <Settings size={16} strokeWidth={1.75} aria-hidden />
            {t("nav.settings")}
          </button>
          <div className="px-side-theme" role="group" aria-label={t("side.theme")}>
            {themes.map(({ source, icon: Icon }) => (
              <button
                key={source}
                type="button"
                role="menuitemradio"
                aria-checked={appearance.source === source}
                onClick={() => setTheme(source)}
              >
                <Icon size={15} strokeWidth={1.75} aria-hidden />
                {t(`settings.${source}`)}
              </button>
            ))}
          </div>
          <button type="button" role="menuitem" onClick={() => go("/settings/about")}>
            <CircleHelp size={16} strokeWidth={1.75} aria-hidden />
            {t("side.help")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The Pyxis mark: three star trails and the star, in the text colour (pyxis-mockups app/index.html, #pyxis-mark). */
export function PyxisMark() {
  return (
    <svg className="px-brand-mark" viewBox="6 10 88 88" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="6.5" strokeLinecap="round">
        <path d="M34.96,48.53 A16,16 0 1 1 55.47,69.04" />
        <path d="M25.75,68.00 A28,28 0 1 1 77.57,49.14" opacity=".75" />
        <path d="M24.29,23.36 A40,40 0 0 1 80.64,79.71" opacity=".55" />
      </g>
      <path
        fill="currentColor"
        d="M50,45 C51.62,52.38 51.62,52.38 59,54 C51.62,55.62 51.62,55.62 50,63 C48.38,55.62 48.38,55.62 41,54 C48.38,52.38 48.38,52.38 50,45Z"
      />
    </svg>
  );
}
