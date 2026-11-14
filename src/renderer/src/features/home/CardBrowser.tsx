import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Button,
  type MenuProps,
  Modal,
  Pagination,
  Select,
  Skeleton,
} from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { Button as PxButton } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { MenuButton, MenuItemArea } from "../../components/ItemMenu";
import { openSourceViewer } from "../../components/SourceViewer";
import { MarkdownView } from "../../components/MarkdownView";
import { Notice } from "../../components/Notice";
import { Tag } from "../../components/Tag";
import {
  ListToolbar,
  ToolbarSearch,
} from "../../components/ListToolbar";
import { clozeAnswer, isCloze } from "../../../../core/study/cloze";
import { invoke } from "../../lib/ipc";
import { usePlans } from "../../lib/queries";
import { i18n } from "../../locales/i18n";
import { NewCardDialog } from "../flashcards/NewCardDialog";
import { AnkiModal } from "./AnkiModal";
import "./CardBrowser.css";
import { CardFaceFields } from "../../components/CardFaceFields";

const PAGE_SIZE = 25;
/** The exam filter's value for the cards with no exam. */
const NO_EXAM = "none";

type Status = "all" | "due" | "suspended" | "removed" | "leech";
type Browse = RequestOutput<"study.browse">;
type Card = Browse["cards"][number];

/** The card as written: a cloze shows its sentence with the hidden words filled in. */
const frontText = (card: Card) =>
  isCloze(card.front) ? clozeAnswer(card.front) : card.front;

/** A short plain-text name for a card, so each button in the list says which card it acts on. */
const cardName = (card: Card) =>
  frontText(card)
    .replace(/[*$_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

function dateText(at: number) {
  const date = new Date(at);
  const year = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(i18n.language, {
    day: "numeric",
    month: "short",
    ...(year ? {} : { year: "numeric" }),
  }).format(date);
}

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
  const [modal, modalContext] = Modal.useModal();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [planId, setPlanId] = useState(initialPlanId);
  const [topicId, setTopicId] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Card | null>(null);
  const [draftFront, setDraftFront] = useState("");
  const [draftBack, setDraftBack] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [done, setDone] = useState("");
  const [anki, setAnki] = useState<"import" | "export" | null>(null);
  // "Nuova flashcard", the empty page's one action: its dialog grows out of the button.
  const [newCard, setNewCard] = useState(false);
  const newButton = useRef<HTMLSpanElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);

  // The search waits for a pause in typing, then goes back to the first page.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text), 200);
    return () => window.clearTimeout(timer);
  }, [text]);
  useEffect(() => setPage(1), [query]);

  const list = useQuery({
    queryKey: ["card-browse", query, planId, topicId, status, page],
    queryFn: () =>
      invoke("study.browse", {
        query: query.trim() || undefined,
        planId: planId === NO_EXAM ? null : planId || undefined,
        topicId: topicId || undefined,
        status,
        offset: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  const filtered = Boolean(
    query.trim() || planId || topicId || status !== "all",
  );
  // No flashcard at all, and nothing filtering: the page is empty, not a search with no result.
  const emptyPage = Boolean(data && data.total === 0 && !filtered && data.plans.length === 0);

  // A page that emptied after a delete steps back instead of showing nothing.
  useEffect(() => {
    if (data && data.cards.length === 0 && data.total > 0 && page > 1)
      setPage(Math.ceil(data.total / PAGE_SIZE));
  }, [data, page]);
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
    if (topicId && !data.topics.some((topic) => topic.id === topicId))
      setTopicId("");
  }, [data, planId, topicId, requested, exams.isSuccess]);

  const refresh = () =>
    Promise.all(
      [
        "card-browse",
        "cards",
        "card-queue",
        "card-suspended",
        "review-session",
      ].map((key) => client.invalidateQueries({ queryKey: [key] })),
    );

  /** Import and export sit in the page's menu; with no flashcard to export, import alone. */
  const ankiMenu: MenuProps = {
    items: [
      { key: "import", label: t("cardImport.open") },
      ...(emptyPage ? [] : [{ key: "export", label: t("cardExport.open") }]),
    ],
    onClick: ({ key }) => setAnki(key === "export" ? "export" : "import"),
  };
  const ankiModal = (
    <AnkiModal
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
      return;
    }
    await refresh();
    setDone(message);
  }

  function ask(card: Card) {
    modal.confirm({
      title: t("cardBrowser.deleteTitle"),
      content: (
        <>
          <p>{cardName(card)}</p>
          <p>
            {t(
              card.handMade
                ? "cardBrowser.deleteHandMade"
                : "cardBrowser.deleteSeeded",
            )}
          </p>
        </>
      ),
      okText: t(card.handMade ? "cards.deleteConfirm" : "cards.delete"),
      okButtonProps: { danger: true },
      cancelText: t("cardBrowser.cancel"),
      onOk: async () => {
        await change(
          invoke("study.remove", { cardId: card.id }),
          t(
            card.handMade
              ? "cardBrowser.deletedForever"
              : "cardBrowser.deleted",
          ),
        );
        summary.current?.focus();
      },
    });
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      // Saving an existing card needs only its id; the exam, when it has one, has to match.
      await invoke("study.save", {
        planId: editing.planId ?? undefined,
        cardId: editing.id,
        front: draftFront,
        back: draftBack,
      });
      setEditing(null);
      await refresh();
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }

  const topics = (data?.topics ?? []).filter(
    (topic) => topic.planId === planId,
  );
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

  function reset() {
    setText("");
    setQuery("");
    setPlanId("");
    setTopicId("");
    setStatus("all");
    setPage(1);
    setDone("");
  }
  const filter =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPage(1);
      setDone("");
    };

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

  // The page arrives in order, so a heading opens wherever the subject, or the exam and topic, changes.
  const sections: Array<{
    subjectId: string | null;
    subjectName: string | null;
    runs: Array<{
      key: string;
      planTitle: string | null;
      topicTitle: string | null;
      cards: Card[];
    }>;
  }> = [];
  for (const card of data?.cards ?? []) {
    let section = sections.at(-1);
    if (!section || section.subjectId !== card.subjectId) {
      section = {
        subjectId: card.subjectId,
        subjectName: card.subjectName,
        runs: [],
      };
      sections.push(section);
    }
    const key = `${card.subjectId ?? "none"}-${card.planId ?? "none"}-${card.topicId ?? "none"}`;
    let run = section.runs.at(-1);
    if (!run || run.key !== key) {
      run = {
        key,
        planTitle: card.planTitle,
        topicTitle: card.topicTitle,
        cards: [],
      };
      section.runs.push(run);
    }
    run.cards.push(card);
  }
  /** One compact row: the front, a line of the back, when it comes up next, Edit, and the rest in a menu. */
  function renderCard(card: Card) {
    const name = cardName(card);
    const label = (key: string) =>
      t("cardBrowser.action", { action: t(key), card: name });
    // The three-dots menu, which a right-click on the row opens too. A removed card has none, only Restore.
    const menu: MenuProps = {
      items: [
        ...(card.leech && card.passageId
          ? [
              {
                key: "source",
                label: t("cardBrowser.openSource"),
              },
            ]
          : []),
        {
          key: "suspend",
          label: t(card.suspended ? "cards.resume" : "cards.suspend"),
        },
        { type: "divider" },
        { key: "delete", label: t("cards.delete"), danger: true },
      ],
      onClick: ({ key }) => {
        if (key === "delete") ask(card);
        else if (key === "source")
          openSourceViewer({
            passageId: card.passageId ?? undefined,
            sourceId: card.sourceId ?? undefined,
          });
        else
          void change(
            invoke("study.suspend", {
              cardId: card.id,
              suspended: !card.suspended,
            }),
            "",
          );
      },
    };
    return (
      <MenuItemArea
        key={card.id}
        menu={menu}
        region={t("cardBrowser.moreActions")}
        disabled={card.removed}
        className={
          card.suspended || card.removed || card.leech
            ? "px-cardbrowser-row has-tags"
            : "px-cardbrowser-row"
        }
      >
        <div className="px-cardbrowser-text">
          <div className="px-cardbrowser-front">
            <span className="visually-hidden">
              {t("cardBrowser.frontText")}
            </span>
            <MarkdownView variant="body">{frontText(card)}</MarkdownView>
          </div>
          <div className="px-cardbrowser-back">
            <span className="visually-hidden">{t("cardBrowser.backText")}</span>
            <MarkdownView variant="body">{card.back}</MarkdownView>
          </div>
          {card.leech && !card.removed ? (
            <p className="small px-cardbrowser-leech">
              {t(
                card.passageId
                  ? "cardBrowser.leechHint"
                  : "cardBrowser.leechHintNoSource",
                { count: card.lapses },
              )}
            </p>
          ) : null}
        </div>
        <div className="px-cardbrowser-state">
          <span className="small">
            {card.state === "new"
              ? t("cardBrowser.stateNew")
              : card.state === "due"
                ? t("cardBrowser.stateDue")
                : t("cardBrowser.stateNext", {
                    date: dateText(card.dueAt ?? 0),
                  })}
          </span>
          {card.leech && !card.removed ? (
            <Tag tone="general">{t("cardBrowser.tagLeech")}</Tag>
          ) : null}
          {card.suspended ? <Tag>{t("cardBrowser.tagSuspended")}</Tag> : null}
          {card.removed ? <Tag>{t("cardBrowser.tagRemoved")}</Tag> : null}
        </div>
        <div className="px-cardbrowser-actions">
          {card.removed ? (
            <Button
              size="small"
              shape="round"
              aria-label={label("cardBrowser.restore")}
              onClick={() =>
                void change(
                  invoke("study.restore", { cardId: card.id }),
                  t("cardBrowser.restored"),
                )
              }
            >
              {t("cardBrowser.restore")}
            </Button>
          ) : (
            <>
              <Button
                size="small"
                shape="round"
                type="text"
                aria-label={label(
                  card.leech ? "cardBrowser.rewrite" : "cards.edit",
                )}
                onClick={() => {
                  setDraftFront(card.front);
                  setDraftBack(card.back);
                  setSaveFailed(false);
                  setEditing(card);
                }}
              >
                {t(card.leech ? "cardBrowser.rewrite" : "cards.edit")}
              </Button>
              <MenuButton
                size="sm"
                menu={menu}
                label={label("cardBrowser.moreActions")}
                region={t("cardBrowser.moreActions")}
              />
            </>
          )}
        </div>
      </MenuItemArea>
    );
  }

  const groupCount = new Map(
    (data?.groups ?? []).map((group) => [group.subjectId, group.count]),
  );

  return (
    <div className="px-cardbrowser">
      <div className="px-cardbrowser-head">
        {back}
        <MenuItemArea as="header" className="px-subpage-head" menu={ankiMenu} region={t("cardBrowser.more")}>
          <h1 className="title-1">{title}</h1>
          <MenuButton rightClick menu={ankiMenu} label={t("cardBrowser.more")} />
        </MenuItemArea>
      </div>
      {modalContext}
      {ankiModal}
      {emptyPage ? (
        <EmptyState
          body={t("cardBrowser.emptyBody")}
          action={
            <span ref={newButton}>
              <PxButton icon="plus" onClick={() => setNewCard(true)}>
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
                    filter(setPlanId)(value);
                    setTopicId("");
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
                  options={(["all", "due", "leech", "suspended", "removed"] as const).map(
                    (value) => ({ value, label: t(`cardBrowser.status.${value}`) }),
                  )}
                />
              </>
            }
          />

          <div className="px-cardbrowser-summary">
            <p className="small" role="status" tabIndex={-1} ref={summary}>
              {done ||
                (data
                  ? t(
                      data.total === 0
                        ? "cardBrowser.noMatch"
                        : "cardBrowser.count",
                      { count: data.total },
                    )
                  : "\u00a0")}
            </p>
            {filtered ? (
              <Button
                type="text"
                shape="round"
                size="small"
                className="linkish"
                onClick={reset}
              >
                {t("cardBrowser.clear")}
              </Button>
            ) : null}
          </div>
          {actionFailed ? (
            <Notice tone="danger">{t("cards.actionFailed")}</Notice>
          ) : null}

          {!data ? (
            <ul className="px-list-surface" aria-hidden>
              {[0, 1, 2].map((key) => (
                <li key={key} className="px-cardbrowser-row">
                  <Skeleton active title={false} paragraph={{ rows: 2 }} />
                </li>
              ))}
            </ul>
          ) : data.total === 0 ? null : (
            <>
              {sections.map((section) => (
                <section
                  key={section.subjectId ?? "none"}
                  className="px-cardbrowser-subject"
                  aria-labelledby={`card-subject-${section.subjectId ?? "none"}`}
                >
                  <header>
                    <h2
                      className="title-3"
                      id={`card-subject-${section.subjectId ?? "none"}`}
                    >
                      {section.subjectName ?? t("cardBrowser.noSubject")}
                    </h2>
                    <span className="small">
                      {t("cardBrowser.count", {
                        count: groupCount.get(section.subjectId) ?? 0,
                      })}
                    </span>
                  </header>
                  {section.runs.map((run) => (
                    <div key={run.key} className="px-cardbrowser-run">
                      {run.planTitle == null ? (
                        // A subject's cards with no exam can be reviewed on their own.
                        <div className="px-cardbrowser-runhead">
                          <h3
                            className="small px-cardbrowser-topic"
                            id={`card-run-${run.key}`}
                          >
                            {t("cardBrowser.noExam")}
                          </h3>
                          {section.subjectId ? (
                            <Button
                              size="small"
                              shape="round"
                              type="text"
                              aria-label={t("cardBrowser.reviewSubject", {
                                subject: section.subjectName ?? "",
                              })}
                              onClick={() => navigate(`/cards/subject/${section.subjectId}`)}
                            >
                              {t("cardBrowser.review")}
                            </Button>
                          ) : null}
                        </div>
                      ) : (
                        <h3
                          className="small px-cardbrowser-topic"
                          id={`card-run-${run.key}`}
                        >
                          {run.planTitle} ·{" "}
                          {run.topicTitle ?? t("cardBrowser.noTopic")}
                        </h3>
                      )}
                      <ul aria-labelledby={`card-run-${run.key}`}>
                        {run.cards.map((card) => renderCard(card))}
                      </ul>
                    </div>
                  ))}
                </section>
              ))}
              {data.total > PAGE_SIZE ? (
                <Pagination
                  className="px-cardbrowser-pages"
                  align="center"
                  current={page}
                  total={data.total}
                  pageSize={PAGE_SIZE}
                  showSizeChanger={false}
                  onChange={(next) => {
                    setPage(next);
                    summary.current?.scrollIntoView({ block: "start" });
                  }}
                />
              ) : null}
            </>
          )}
        </>
      )}

      <Modal
        open={editing !== null}
        title={t("cardBrowser.editTitle")}
        okText={t("cards.save")}
        cancelText={t("cardBrowser.cancel")}
        okButtonProps={{ disabled: !draftFront.trim() || !draftBack.trim() }}
        confirmLoading={saving}
        onOk={() => void save()}
        onCancel={() => setEditing(null)}
        maskClosable={false}
        destroyOnHidden
      >
        <div className="px-cardbrowser-edit">
          <p className="small">{t("cardBrowser.editHint")}</p>
          <CardFaceFields
            idPrefix="browse"
            front={draftFront}
            back={draftBack}
            onFront={setDraftFront}
            onBack={setDraftBack}
          />
          {saveFailed ? (
            <Notice tone="danger">{t("cards.actionFailed")}</Notice>
          ) : null}
        </div>
      </Modal>
      <NewCardDialog
        open={newCard}
        side="hand"
        origin={() => newButton.current?.querySelector("button") ?? null}
        onClose={() => setNewCard(false)}
        onSaved={({ name, count, closing }) => {
          if (closing) setDone(t("flashcards.new.savedTo", { count, subject: name }));
        }}
      />
    </div>
  );
}
