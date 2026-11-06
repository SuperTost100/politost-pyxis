import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { foldText } from "@shared/fold-text";
import { openSourceViewer } from "../components/SourceViewer";
import { RenameField, type ChatActions } from "../features/ask/chatActions";
import { groupChats, titleMatches, type ChatGroup } from "../features/ask/chatList";
import { invoke } from "../lib/ipc";
import { useChats, usePlans, useSources } from "../lib/queries";
import "./Finder.css";

/** "all" searches everything; "chats" lists every chat by date, as "All chats" in the sidebar opens it. */
export type FinderScope = "all" | "chats";

type Row = {
  key: string;
  title: string;
  sub?: string | null;
  snippet?: { text: string; start: number; end: number } | null;
  chat?: { id: string; title: string | null };
  /** Changes what the search lists instead of leaving it, as "All chats" does. */
  stay?: boolean;
  go: () => void;
};
type Section = { label: string; rows: Row[] };

/** How many rows each kind shows when searching everything; the full lists are a click away in their sections. */
const PER_KIND = 6;

/**
 * The search over the whole app, from the sidebar or Cmd+K (Ctrl+K): chats by title and by what was said, exams,
 * maps and material. Arrows move, Enter opens, Esc closes. Each key asks at once; the previous results stay until the
 * new ones come, so nothing waits on a timer.
 */
export function Finder({
  scope,
  onClose,
  actions,
}: {
  /** Null when closed. */
  scope: FinderScope | null;
  onClose: () => void;
  actions: ChatActions;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The control that had focus before the search opened. The search gives it back itself, without scrolling: the
  // dialog's own return of focus scrolls to it, and a control in the sticky sidebar then scrolls the page to the top.
  const before = useRef<HTMLElement | null>(null);
  const listId = useId();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  // What it lists: the scope it opened with, until "All chats" switches it to every chat.
  const [view, setView] = useState<FinderScope>("all");
  const open = scope !== null;
  const asked = text.trim();
  const wanted = foldText(asked);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      before.current?.blur();
      setText("");
      setActive(0);
      setView(scope ?? "all");
      node.showModal();
      input.current?.focus();
    }
    if (!open && node.open) node.close();
    if (!open) {
      before.current?.focus({ preventScroll: true });
      before.current = null;
    }
  }, [open, scope]);

  const chats = useChats();
  const plans = usePlans(open && view === "all");
  const sources = useSources(open && view === "all");
  const found = useQuery({
    queryKey: ["chats", "search", asked],
    queryFn: () => invoke("chats.search", { query: asked }),
    enabled: open && asked !== "",
    placeholderData: keepPreviousData,
  });
  const maps = useQuery({
    queryKey: ["maps-all", asked],
    queryFn: () => invoke("maps.all", asked ? { query: asked } : {}),
    enabled: open && view === "all",
    placeholderData: keepPreviousData,
  });

  const done = () => onClose();
  const allChats = chats.data ?? [];
  const subjectOf = new Map(allChats.map((chat) => [chat.id, chat.subject]));
  // Before core's first answer, the chats whose title matches show at once instead of an empty list.
  const chatHits: Array<{ id: string; title: string | null; updatedAt: number; snippet?: Row["snippet"] }> = asked
    ? (found.data?.hits ?? titleMatches(allChats, asked))
    : allChats;
  const chatRow = (chat: (typeof chatHits)[number]): Row => ({
    key: `chat:${chat.id}`,
    title: actions.nameOf(chat),
    sub: subjectOf.get(chat.id),
    snippet: chat.snippet,
    chat: { id: chat.id, title: chat.title },
    go: () => navigate(`/ask/${chat.id}`),
  });
  const groupName: Record<ChatGroup, string> = {
    today: t("ask.groupToday"),
    yesterday: t("ask.groupYesterday"),
    week: t("ask.groupWeek"),
    older: t("ask.groupOlder"),
  };

  const sections: Section[] = [];
  if (view === "chats") {
    for (const { group, chats: grouped } of groupChats(chatHits))
      sections.push({ label: groupName[group], rows: grouped.map(chatRow) });
  } else if (view === "all") {
    const matches = (...parts: Array<string | null | undefined>) =>
      !wanted || parts.some((part) => part && foldText(part).includes(wanted));
    sections.push(
      {
        label: t("finder.chats"),
        rows: [
          ...chatHits.slice(0, PER_KIND).map(chatRow),
          // The rest are one step away, also where the sidebar is folded and has no "All chats".
          ...(chatHits.length > PER_KIND
            ? [{ key: "all-chats", title: t("side.allChats"), stay: true, go: () => setView("chats") }]
            : []),
        ],
      },
      {
        label: t("finder.exams"),
        rows: (plans.data ?? [])
          .filter((plan) => matches(plan.title, plan.subject))
          .slice(0, PER_KIND)
          .map((plan) => ({
            key: `exam:${plan.id}`,
            title: plan.title,
            sub: plan.subject,
            go: () => navigate(`/plans/${plan.id}`),
          })),
      },
      {
        label: t("finder.maps"),
        rows: (maps.data ?? []).slice(0, PER_KIND).map((map) => ({
          key: `map:${map.planId}:${map.topicId}:${map.id}`,
          title: map.title,
          sub: map.subjectName ?? map.planTitle,
          go: () =>
            navigate(`/plans/${map.planId}/map/${map.topicId}?from=maps&map=${encodeURIComponent(map.id)}`),
        })),
      },
      {
        label: t("finder.material"),
        rows: (sources.data ?? [])
          .filter((source) => matches(source.title))
          .slice(0, PER_KIND)
          .map((source) => ({
            key: `source:${source.id}`,
            title: source.title,
            go: () => openSourceViewer({ sourceId: source.id }),
          })),
      },
    );
  }
  const shown = sections.filter((section) => section.rows.length > 0);
  const rows = shown.flatMap((section) => section.rows);
  const current = Math.min(active, Math.max(rows.length - 1, 0));
  const optionId = (index: number) => `${listId}-${index}`;
  const settled = asked !== "" && !found.isFetching && !maps.isFetching;

  function pick(row: Row) {
    if (row.stay) {
      setActive(0);
      input.current?.focus();
    } else done();
    row.go();
  }

  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, current]);

  let index = -1;
  const list: ReactNode = shown.map((section) => (
    <div key={section.label} role="group" aria-label={section.label}>
      <p className="px-finder-label" aria-hidden>
        {section.label}
      </p>
      {section.rows.map((row) => {
        index += 1;
        const at = index;
        const edit = row.chat ? actions.editing(row.chat) : null;
        if (edit)
          return (
            <div key={row.key} className="px-finder-row is-editing">
              <RenameField edit={edit} label={t("ask.renameLabel")} />
            </div>
          );
        return (
          <div
            key={row.key}
            id={optionId(at)}
            role="option"
            aria-selected={at === current}
            className={row.stay ? "px-finder-row is-more" : "px-finder-row"}
            onMouseMove={() => setActive(at)}
            onClick={() => pick(row)}
            onContextMenu={(event) => {
              if (!row.chat) return;
              event.preventDefault();
              void actions.openMenu(row.chat);
            }}
          >
            <span className="px-finder-title">{row.title}</span>
            {row.sub ? <span className="px-finder-sub">{row.sub}</span> : null}
            {row.snippet ? (
              <span className="px-finder-snippet">
                {row.snippet.text.slice(0, row.snippet.start)}
                <mark>{row.snippet.text.slice(row.snippet.start, row.snippet.end)}</mark>
                {row.snippet.text.slice(row.snippet.end)}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  ));

  return (
    <dialog
      ref={dialog}
      className="px-finder"
      aria-label={t("finder.label")}
      onClose={() => {
        // The close event comes a moment after Esc; a Cmd+K pressed in between has already opened it again.
        if (!dialog.current?.open) done();
      }}
      onCancel={(event) => {
        // Esc in a chat's rename field cancels the rename, not the search.
        if (document.activeElement?.classList.contains("px-rename")) event.preventDefault();
        // Otherwise the search closes now, before the close event, so a Cmd+K right after opens it again.
        else done();
      }}
      onMouseDown={(event) => {
        // A press on the dimmed backdrop, outside the card, closes it.
        if (event.target === dialog.current) done();
      }}
    >
      {open ? (
        <div className="px-finder-card">
          <label className="px-finder-field">
            <Search size={18} strokeWidth={1.75} aria-hidden />
            <input
              ref={input}
              // Not type="search": Chromium's search field eats the first Esc to clear itself, and Esc should close.
              type="text"
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls={rows.length > 0 ? listId : undefined}
              aria-activedescendant={rows.length > 0 ? optionId(current) : undefined}
              aria-label={t("finder.label")}
              placeholder={view === "chats" ? t("finder.chatsPlaceholder") : t("finder.placeholder")}
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  if (rows.length > 0) setActive((current + step + rows.length) % rows.length);
                }
                if (event.key === "Enter" && rows[current]) {
                  event.preventDefault();
                  pick(rows[current]);
                }
              }}
            />
            <kbd>{t("finder.close")}</kbd>
          </label>
          <div className="px-finder-list">
            {/* The listbox holds options only; the messages about it sit beside it. */}
            {rows.length > 0 ? (
              <div id={listId} role="listbox" aria-label={t("finder.label")}>
                {list}
              </div>
            ) : null}
            {rows.length === 0 && asked !== "" && settled ? (
              <p className="px-finder-none">{t("finder.none")}</p>
            ) : rows.length === 0 && asked === "" && view === "chats" && chats.isSuccess ? (
              <p className="px-finder-none">{t("ask.chatsEmpty")}</p>
            ) : null}
            {view === "chats" && settled && found.data?.capped ? (
              <p className="px-finder-none">{t("ask.searchCapped", { count: found.data.hits.length })}</p>
            ) : null}
          </div>
          <div className="visually-hidden" role="status" aria-live="polite">
            {settled && view === "chats" ? t("ask.searchCount", { count: rows.length }) : ""}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
