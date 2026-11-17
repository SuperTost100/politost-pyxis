import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Select, Skeleton, type MenuProps } from "antd";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useLeaveGuard } from "../../app/useLeaveGuard";
import { Button as PxButton } from "../../components/Button";
import { Reveal } from "../../components/Controls";
import { afterDialog, useConfirm } from "../../components/Dialog";
import { EmptyArt } from "../../components/EmptyArt";
import { EmptyState } from "../../components/EmptyState";
import { MenuButton, MenuItemArea, menuTakesEscape } from "../../components/ItemMenu";
import { openSourceViewer } from "../../components/SourceViewer";
import { Notice } from "../../components/Notice";
import { ListToolbar, ToolbarSearch } from "../../components/ListToolbar";
import { invoke } from "../../lib/ipc";
import { usePlans } from "../../lib/queries";
import { NewCardDialog } from "../flashcards/NewCardDialog";
import { readPlacesAhead, whenPlacesRead } from "../flashcards/newCardPlaces";
import { AnkiDialog } from "./AnkiDialog";
import { CardEditor, CardTile, type CardActions, type Draft } from "./CardTile";
import {
  cardName,
  expandRequest,
  PER_SUBJECT,
  sectionsOf,
  type BrowsedCard,
  type SubjectSection,
} from "./cardBrowserLogic";
import "./CardBrowser.css";

/** The exam filter's value for the cards with no exam. */
const NO_EXAM = "none";

type Status = "all" | "due" | "suspended" | "removed" | "leech";
type Card = BrowsedCard;

/**
 * `planId`: the exam the browser opens filtered to, such as when that exam's page opened it. `back` and `title` make
 * its head, which holds the page's menu: the dots, and a right-click on the head.
 */
export function CardBrowser({
  planId: initialPlanId = "",
  back,
  title,
}: {
  planId?: string;
  back?: ReactNode;
  title: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const confirm = useConfirm();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [planId, setPlanId] = useState(initialPlanId);
  const [topicId, setTopicId] = useState("");
  const [status, setStatus] = useState<Status>("all");
  /** The subjects the student has opened past their first eight, by `subjectKey`. */
  const [expanded, setExpanded] = useState<string[]>([]);
  /** The card being edited where it stands. */
  const [editing, setEditing] = useState<{ card: Card } | null>(null);
  // What the functions below read when they run, which may be after the render they were made in: an answer that comes
  // back, a question that is answered, a save that ends.
  const editingNow = useRef(editing);
  editingNow.current = editing;
  /** What has been typed into it, which no redraw of the list can drop, and where the card was, which it grows out of. */
  const draft = useRef<Draft | null>(null);
  const grow = useRef<DOMRect | null>(null);
  /** The card whose save is under way, and that save. */
  const [saving, setSaving] = useState<string | null>(null);
  const savingNow = useRef<string | null>(null);
  const pendingSave = useRef<Promise<void> | null>(null);
  const [saveFailed, setSaveFailed] = useState<string | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const [done, setDone] = useState("");
  const [anki, setAnki] = useState<"import" | "export" | null>(null);
  // "Nuova flashcard", the empty page's one action: its dialog grows out of the button.
  const [newCard, setNewCard] = useState(false);
  const newButton = useRef<HTMLSpanElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);

  // The search waits for a pause in typing, then starts again from each subject's first eight. With typing in a card's
  // edit that the search would drop, it asks first, and staying puts the search back.
  useEffect(() => {
    if (text === query) return;
    const timer = window.setTimeout(
      () =>
        void startOver(
          () => setQuery(text),
          () => setText(query),
        ),
      200,
    );
    return () => window.clearTimeout(timer);
  }, [text, query]);

  const open = useMemo(() => new Set(expanded), [expanded]);
  const list = useQuery({
    queryKey: ["card-browse", query, planId, topicId, status, expandRequest(expanded)],
    queryFn: () =>
      invoke("study.browse", {
        query: query.trim() || undefined,
        planId: planId === NO_EXAM ? null : planId || undefined,
        topicId: topicId || undefined,
        status,
        perSubject: PER_SUBJECT,
        expand: expandRequest(expanded),
        // The card being edited stays in the answer wherever a change in the list ranks it.
        keep: editingNow.current ? [editingNow.current.card.id] : undefined,
      }),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  const filtered = Boolean(query.trim() || planId || topicId || status !== "all");
  // No flashcard at all, and nothing filtering: the page is empty, not a search with no result. A removed card is still a
  // card: its exam, or the cards with no exam, keep the page and its "Rimosse" filter.
  const emptyPage = Boolean(data && data.total === 0 && !filtered && data.plans.length === 0 && !data.examless);
  // The empty page's button opens it: the subjects are read as the page shows it, so the dialog finds them.
  useEffect(() => {
    if (emptyPage) readPlacesAhead(client, 0);
  }, [emptyPage]);
  // The first card replaces the empty page and its button, which the dialog gives the focus back to: once both have
  // happened, a focus that fell to the page goes to the list's summary line.
  const wasEmpty = useRef(false);
  useEffect(() => {
    if (emptyPage) wasEmpty.current = true;
    else if (wasEmpty.current && data && !newCard) {
      wasEmpty.current = false;
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) summary.current?.focus();
      });
    }
  }, [emptyPage, data, newCard]);

  // A card that is no longer there, deleted or archived behind the page's back, takes its edit with it: the answer holds
  // the card being edited wherever it ranks (`keep`), so one missing from it is gone, and there is nothing to save to.
  useEffect(() => {
    if (!editing || !data || list.isPlaceholderData || savingNow.current === editing.card.id) return;
    if (!data.cards.some((card) => card.id === editing.card.id)) setEdit(null);
  }, [data, editing, list.isPlaceholderData]);

  // The browser lists only exams that hold cards, so the exam it was opened for is looked up among all of them: an
  // exam with no flashcards yet keeps its filter and shows an empty result, and one that does not exist is dropped.
  const exams = usePlans();
  const requested = planId !== "" && planId === initialPlanId ? exams.data?.find((exam) => exam.id === planId) : undefined;
  // An exam or topic that no longer holds cards cannot filter.
  useEffect(() => {
    if (!data) return;
    if (
      planId &&
      (planId === NO_EXAM
        ? !data.examless
        : !data.plans.some((plan) => plan.id === planId) && !requested && (planId !== initialPlanId || exams.isSuccess))
    )
      setPlanId("");
    if (topicId && !data.topics.some((topic) => topic.id === topicId)) setTopicId("");
  }, [data, planId, topicId, requested, exams.isSuccess]);

  const refresh = () =>
    Promise.all(
      ["card-browse", "cards", "card-queue", "card-suspended", "review-session"].map((key) =>
        client.invalidateQueries({ queryKey: [key] }),
      ),
    );

  /** Import and export sit in the page's menu; with no flashcard to export, import alone. */
  const ankiMenu: MenuProps = {
    items: [
      { key: "import", label: t("cardImport.open") },
      ...(emptyPage ? [] : [{ key: "export", label: t("cardExport.open") }]),
    ],
    onClick: ({ key }) => setAnki(key === "export" ? "export" : "import"),
  };
  const ankiDialog = (
    <AnkiDialog
      mode={anki ?? "import"}
      open={anki !== null}
      onClose={() => setAnki(null)}
      initialPlanId={planId === NO_EXAM ? undefined : planId || undefined}
      initialTopicId={topicId || undefined}
      onImported={() => void refresh()}
    />
  );

  /** Runs a change on one card, then reloads the list and says what happened. */
  async function change(request: Promise<unknown>, message: string) {
    setActionFailed(false);
    setDone("");
    try {
      await request;
    } catch {
      setActionFailed(true);
      return false;
    }
    await refresh();
    setDone(message);
    return true;
  }

  function ask(card: Card) {
    let deleted = false;
    void confirm({
      title: t("cardBrowser.deleteTitle"),
      body: (
        <>
          <p>{cardName(card)}</p>
          <p>{t(card.handMade ? "cardBrowser.deleteHandMade" : "cardBrowser.deleteSeeded")}</p>
        </>
      ),
      confirm: t("cards.deleteConfirm"),
      tone: "danger",
      run: async () => {
        deleted = await change(
          invoke("study.remove", { cardId: card.id }),
          t(card.handMade ? "cardBrowser.deletedForever" : "cardBrowser.deleted"),
        );
      },
      // The card is gone, so the focus goes to the list's summary line once the dialog has closed. After Annulla or a
      // failed delete the card is still there, and the focus goes back to what opened the dialog.
      onClosed: () => {
        if (deleted) summary.current?.focus();
      },
    });
  }

  /** Puts the focus back on a card's own button once the list has drawn it again, after an edit or a cancelled one. */
  function focusCard(id: string) {
    let tries = 0;
    const go = () => {
      const node = document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"] .px-ct-open`);
      if (node) node.focus();
      else if (++tries < 20) requestAnimationFrame(go);
    };
    // The page behind a question is inert until the question has gone, and a focus placed then is lost.
    afterDialog(() => requestAnimationFrame(go));
  }

  /** Opens or closes the edit for the functions that run next, which read `editingNow` before the page is drawn again. */
  function setEdit(next: { card: Card } | null) {
    editingNow.current = next;
    setEditing(next);
  }

  /** Whether the typing in the edit open now differs from the card as it is saved. */
  const typed = () => {
    const open = editingNow.current;
    const held = draft.current;
    return Boolean(open && held && held.id === open.card.id && (held.front !== open.card.front || held.back !== open.card.back));
  };

  /**
   * Whether the edit open now may close. It holds typing to lose only when it differs from the card, and the student is
   * asked then. A save that is under way ends first: it closes the edit when it works, and when it fails the typing is
   * still there to ask about.
   */
  async function mayDropEdit() {
    await pendingSave.current;
    const open = editingNow.current;
    if (!open || !typed()) return true;
    const answer = await confirm({
      title: t("leave.title"),
      body: t("cardBrowser.leaveEdit"),
      cancel: t("leave.stay"),
      confirm: t("leave.go"),
      tone: "danger",
    });
    return answer === "confirm";
  }
  // Leaving the page asks the same question while an edit holds typing, a pending save included: it may still fail.
  useLeaveGuard({ dirty: typed, body: t("cardBrowser.leaveEdit") });
  // Escape closes the edit also when the focus is not in it, on another card or on the page, and asks the same question
  // (Escape in the edit's own fields is handled there). A menu, a list or a dialog that is open takes its Escape first.
  const isEditing = editing !== null;
  const closeEdit = useRef<() => void>(() => undefined);
  closeEdit.current = () => void cancelEdit();
  useEffect(() => {
    if (!isEditing) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        menuTakesEscape(event) ||
        (event.target instanceof Element && event.target.closest("dialog, [role='dialog']")) ||
        document.querySelector("dialog[open], [aria-haspopup][aria-expanded='true']")
      )
        return;
      event.preventDefault();
      closeEdit.current();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [isEditing]);
  // The draft goes with the edit it belonged to.
  useEffect(() => {
    if (!editing) draft.current = null;
  }, [editing]);

  async function openEdit(card: Card, from: DOMRect | null) {
    if (editingNow.current?.card.id === card.id) return;
    // A save that is under way ends first, so what it does to the page cannot reach the card opened now.
    await pendingSave.current;
    if (editingNow.current?.card.id === card.id) return;
    if (!(await mayDropEdit())) return;
    setSaveFailed(null);
    setDone("");
    draft.current = { id: card.id, front: card.front, back: card.back, field: "front" };
    grow.current = from;
    setEdit({ card });
  }

  async function cancelEdit() {
    const open = editingNow.current;
    if (!open) return;
    if (!(await mayDropEdit())) return;
    // Closing is for the card that was asked about, not for another opened while the question was open.
    if (editingNow.current?.card.id !== open.card.id) return;
    setEdit(null);
    focusCard(open.card.id);
  }

  function save(front: string, back: string) {
    const mine = editingNow.current;
    if (!mine) return;
    const { card } = mine;
    const run = (async () => {
      savingNow.current = card.id;
      setSaving(card.id);
      setSaveFailed(null);
      try {
        // Saving an existing card needs only its id; the exam, when it has one, has to match.
        await invoke("study.save", { planId: card.planId ?? undefined, cardId: card.id, front, back });
        await refresh();
        // The save ends the edit that started it, and only that one: the student may have opened another card since.
        if (editingNow.current === mine) {
          const held = draft.current;
          if (held && held.id === card.id && (held.front !== front || held.back !== back)) {
            // The student went on typing while it saved, and the save did not carry that: the edit stays open with it.
            setEdit({ card: { ...card, front: front.trim(), back: back.trim() } });
          } else {
            setEdit(null);
            focusCard(card.id);
          }
        }
      } catch {
        if (editingNow.current === mine) setSaveFailed(card.id);
        else setActionFailed(true);
      } finally {
        savingNow.current = null;
        setSaving(null);
      }
    })();
    pendingSave.current = run;
    void run.then(() => {
      if (pendingSave.current === run) pendingSave.current = null;
    });
  }

  // The card's buttons call these through one object that never changes, so a keystroke in an editor, or a card being
  // changed, redraws that card and not the thousand around it.
  const latest = useRef<CardActions>(null as unknown as CardActions);
  latest.current = {
    edit: (card, from) => void openEdit(card, from),
    suspend: (card) => void change(invoke("study.suspend", { cardId: card.id, suspended: !card.suspended }), ""),
    remove: ask,
    restore: (card) => void change(invoke("study.restore", { cardId: card.id }), t("cardBrowser.restored")),
    openSource: (card) =>
      openSourceViewer({ passageId: card.passageId ?? undefined, sourceId: card.sourceId ?? undefined }),
  };
  const actions = useMemo<CardActions>(
    () => ({
      edit: (card, from) => latest.current.edit(card, from),
      suspend: (card) => latest.current.suspend(card),
      remove: (card) => latest.current.remove(card),
      restore: (card) => latest.current.restore(card),
      openSource: (card) => latest.current.openSource(card),
    }),
    [],
  );

  const topics = (data?.topics ?? []).filter((topic) => topic.planId === planId);
  const planGroups: Array<{
    label: string;
    options: Array<{ value: string; label: string }>;
  }> = [];
  for (const plan of data?.plans ?? []) {
    const label = plan.subject ?? t("cardBrowser.noSubject");
    let group = planGroups.find((item) => item.label === label);
    if (!group) {
      group = { label, options: [] };
      planGroups.push(group);
    }
    group.options.push({ value: plan.id, label: plan.title });
  }
  if (requested && !data?.plans.some((plan) => plan.id === requested.id)) {
    const label = requested.subject ?? t("cardBrowser.noSubject");
    const group = planGroups.find((item) => item.label === label);
    const option = { value: requested.id, label: requested.title };
    if (group) group.options.push(option);
    else planGroups.push({ label, options: [option] });
  }

  /** A filter changes what the page shows, so it starts again from each subject's first eight. */
  async function startOver(change: () => void, stay?: () => void) {
    if (!(await mayDropEdit())) return stay?.();
    setEdit(null);
    change();
    setExpanded([]);
    setDone("");
  }
  function reset() {
    void startOver(() => {
      setText("");
      setQuery("");
      setPlanId("");
      setTopicId("");
      setStatus("all");
    });
  }
  const filter =
    <T,>(set: (value: T) => void) =>
    (value: T) =>
      void startOver(() => set(value));

  // Where the list failed to load, the head has no menu.
  const plainHead = (
    <>
      {back}
      <h1 className="title-1 px-subpage-title">{title}</h1>
    </>
  );

  if (list.isError && !data)
    return (
      <>
        {plainHead}
        <Notice
          tone="danger"
          action={{
            label: t("cardBrowser.retry"),
            onClick: () => void list.refetch(),
          }}
        >
          {t("cardBrowser.loadFailed")}
        </Notice>
      </>
    );

  const sections = data ? sectionsOf(data, open, editing?.card.id) : [];

  /** Opens a subject past its first eight, or closes it again. */
  async function toggle(section: SubjectSection) {
    if (!open.has(section.key)) {
      setExpanded((current) => [...current, section.key]);
      return;
    }
    // Closing hides the cards past the eighth: an edit open in one of them is asked about first.
    const editedNow = editingNow.current;
    if (editedNow && section.more.some((card) => card.id === editedNow.card.id)) {
      if (!(await mayDropEdit())) return;
      setEdit(null);
    }
    setExpanded((current) => current.filter((key) => key !== section.key));
  }

  /** Arrow keys move between the cards of a subject: left and right along a row, up and down by the card above or below. */
  function moveByArrow(event: KeyboardEvent<HTMLElement>) {
    const key = event.key;
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "ArrowUp" && key !== "ArrowDown") return;
    const here = event.target;
    if (!(here instanceof HTMLElement) || !here.matches(".px-ct-open")) return;
    const all = [...event.currentTarget.querySelectorAll<HTMLElement>(".px-ct-open")];
    const at = all.indexOf(here);
    let next: HTMLElement | undefined;
    if (key === "ArrowLeft" || key === "ArrowRight") next = all[at + (key === "ArrowRight" ? 1 : -1)];
    else {
      const rect = here.getBoundingClientRect();
      const centre = rect.left + rect.width / 2;
      const step = key === "ArrowDown" ? 1 : -1;
      for (let index = at + step; index >= 0 && index < all.length; index += step) {
        const other = all[index]!.getBoundingClientRect();
        const beyond = step > 0 ? other.top > rect.top + 4 : other.top < rect.top - 4;
        if (beyond && other.left <= centre && centre <= other.right) {
          next = all[index];
          break;
        }
      }
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  const tiles = (cards: Card[], lazy = false) =>
    cards.map((card) =>
      editing?.card.id === card.id ? (
        <CardEditor
          key={card.id}
          card={editing.card}
          draft={draft}
          grow={grow}
          saving={saving === card.id}
          failed={saveFailed === card.id}
          onSave={(front, back) => save(front, back)}
          onCancel={() => void cancelEdit()}
        />
      ) : (
        <CardTile key={card.id} card={card} actions={actions} lazy={lazy} />
      ),
    );

  // One line under the title: how many flashcards and of how many subjects, or the exam's own when it is the filter.
  const named = data?.groups.filter((group) => group.subjectId !== null).length ?? 0;
  const examTitle =
    planId && planId !== NO_EXAM && !query.trim() && !topicId && status === "all"
      ? (data?.plans.find((plan) => plan.id === planId)?.title ?? requested?.title)
      : undefined;
  const cards = data ? t("cardBrowser.count", { count: data.total }) : "";
  const lead =
    !data || data.total === 0
      ? ""
      : examTitle
        ? t("cardBrowser.leadExam", { count: data.total, exam: examTitle })
        : named > 0
          ? t("cardBrowser.lead", { cards, subjects: t("cardBrowser.subjectsCount", { count: named }) })
          : t("cardBrowser.leadOnly", { cards });

  return (
    <div className="px-cardbrowser">
      <div className="px-cardbrowser-head">
        {back}
        <MenuItemArea as="header" className="px-subpage-head" menu={ankiMenu} region={t("cardBrowser.more")}>
          <div className="px-cardbrowser-title">
            <h1 className="title-1">{title}</h1>
            {/* The line keeps its room while the list loads or a search finds nothing, so the toolbar stays where it is. */}
            {emptyPage ? null : <p className="px-cardbrowser-lead">{lead || "\u00a0"}</p>}
          </div>
          <MenuButton rightClick menu={ankiMenu} label={t("cardBrowser.more")} />
        </MenuItemArea>
      </div>
      {ankiDialog}
      {emptyPage ? (
        <EmptyState
          centred
          art={<EmptyArt kind="flashcards" />}
          body={t("cardBrowser.emptyBody")}
          action={
            <span ref={newButton} onPointerEnter={() => readPlacesAhead(client)} onFocus={() => readPlacesAhead(client)}>
              <PxButton icon="plus" onClick={() => whenPlacesRead(client, () => setNewCard(true))}>
                {t("flashcards.new.action")}
              </PxButton>
            </span>
          }
        />
      ) : (
        <>
          <ListToolbar
            search={
              <ToolbarSearch
                id="card-search"
                label={t("cardBrowser.search")}
                placeholder={t("cardBrowser.searchPlaceholder")}
                value={text}
                onChange={setText}
              />
            }
            filters={
              <>
                <Select
                  id="card-exam"
                  aria-label={t("cardBrowser.exam")}
                  value={planId}
                  popupMatchSelectWidth={false}
                  onChange={(value) => {
                    void startOver(() => {
                      setPlanId(value);
                      setTopicId("");
                    });
                  }}
                  options={[
                    { value: "", label: t("cardBrowser.allExams") },
                    ...planGroups,
                    ...(data?.examless ? [{ value: NO_EXAM, label: t("cardBrowser.noExam") }] : []),
                  ]}
                />
                <Select
                  id="card-topic"
                  aria-label={t("cardBrowser.topic")}
                  value={topicId}
                  disabled={!planId || planId === NO_EXAM}
                  popupMatchSelectWidth={false}
                  onChange={filter(setTopicId)}
                  options={[
                    { value: "", label: t("cardBrowser.allTopics") },
                    ...topics.map((topic) => ({
                      value: topic.id,
                      label: topic.title,
                    })),
                  ]}
                />
                <Select<Status>
                  id="card-status"
                  aria-label={t("cardBrowser.show")}
                  value={status}
                  popupMatchSelectWidth={false}
                  onChange={filter(setStatus)}
                  options={(["all", "due", "leech", "suspended", "removed"] as const).map((value) => ({
                    value,
                    label: t(`cardBrowser.status.${value}`),
                  }))}
                />
                <p className="small px-cardbrowser-summary" role="status" tabIndex={-1} ref={summary}>
                  {done || (data ? t("cardBrowser.count", { count: data.total }) : " ")}
                </p>
              </>
            }
            primary={
              filtered && data && data.total > 0 ? (
                <PxButton variant="ghost" size="sm" className="px-cardbrowser-clear" onClick={reset}>
                  {t("cardBrowser.clear")}
                </PxButton>
              ) : undefined
            }
          />
          {actionFailed ? <Notice tone="danger">{t("cards.actionFailed")}</Notice> : null}

          {!data ? (
            <ul className="px-ct-grid" aria-hidden>
              {[0, 1, 2, 3].map((key) => (
                <li key={key} className="px-ct is-loading">
                  <Skeleton active title={false} paragraph={{ rows: 4 }} />
                </li>
              ))}
            </ul>
          ) : data.total === 0 ? (
            <div className="px-cardbrowser-none">
              <p>{query.trim() ? t("cardBrowser.noMatchQuery", { query: query.trim() }) : t("cardBrowser.noMatch")}</p>
              {filtered ? (
                <PxButton variant="secondary" onClick={reset}>
                  {t("cardBrowser.clear")}
                </PxButton>
              ) : null}
            </div>
          ) : (
            sections.map((section, index) => {
              const isOpen = open.has(section.key);
              const loadingMore = isOpen && section.hidden > 0;
              return (
                <section
                  key={section.key}
                  className="px-cardbrowser-subject"
                  aria-labelledby={`card-subject-${section.key}`}
                  onKeyDown={moveByArrow}
                >
                  <header>
                    <h2 className="title-3" id={`card-subject-${section.key}`}>
                      {section.name ?? t("cardBrowser.noSubject")}
                    </h2>
                    <span className="small">{t("cardBrowser.count", { count: section.count })}</span>
                    {/* A subject's cards with no exam can be reviewed on their own. */}
                    {section.subjectId && section.noExam > 0 ? (
                      <PxButton
                        variant="ghost"
                        size="sm"
                        aria-label={t("cardBrowser.reviewSubject", { subject: section.name ?? "" })}
                        onClick={() => navigate(`/cards/subject/${section.subjectId}`)}
                      >
                        {t("cardBrowser.reviewNoExam")}
                      </PxButton>
                    ) : null}
                  </header>
                  <ul className="px-ct-grid" aria-labelledby={`card-subject-${section.key}`}>
                    {/* The first subject's cards are drawn at once; the others draw as they come near the window. */}
                    {tiles(section.shown, index > 0)}
                  </ul>
                  {/* The card being edited, when a change in the list ranked it past the eight: it stays, with its typing. */}
                  {section.pinned ? <ul className="px-ct-grid">{tiles([section.pinned])}</ul> : null}
                  {section.more.length > 0 ? (
                    <Reveal className="px-cardbrowser-more">
                      <ul className="px-ct-grid" aria-labelledby={`card-subject-${section.key}`}>
                        {tiles(section.more, true)}
                      </ul>
                    </Reveal>
                  ) : null}
                  {section.count > PER_SUBJECT ? (
                    <button
                      type="button"
                      className="px-cardbrowser-showmore"
                      aria-expanded={isOpen}
                      aria-busy={loadingMore || undefined}
                      // Not `disabled`: a disabled button drops the focus, and the button keeps it as it unfolds.
                      aria-disabled={loadingMore || undefined}
                      onClick={() => {
                        if (!loadingMore) void toggle(section);
                      }}
                    >
                      {loadingMore
                        ? t("cardBrowser.loadingMore")
                        : isOpen
                          ? t("cardBrowser.showFewer")
                          : t("cardBrowser.showMore", { count: section.count - section.shown.length })}
                      <span className="px-chevron" aria-hidden />
                    </button>
                  ) : null}
                </section>
              );
            })
          )}
        </>
      )}

      <NewCardDialog
        open={newCard}
        side="hand"
        origin={() => newButton.current?.querySelector("button") ?? null}
        onClose={() => setNewCard(false)}
        // The first card replaces the empty page and the button the dialog grew out of, so the focus has nowhere to go
        // back to: it goes to the list's summary line, once the dialog has closed.
        onClosed={() => {
          if (document.activeElement === document.body) summary.current?.focus();
        }}
        onSaved={({ name, count, closing }) => {
          if (closing) setDone(t("flashcards.new.savedTo", { count, subject: name }));
        }}
      />
    </div>
  );
}
