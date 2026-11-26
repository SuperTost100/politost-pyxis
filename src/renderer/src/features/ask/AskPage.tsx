import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Skeleton } from "antd";
import { RefreshCw } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { usePlace } from "../../app/usePlace";
import { ChatMessage, ThinkingMessage } from "../../components/ChatMessage";
import { AttachmentChip } from "./AttachmentChip";
import { SentFiles, type SentFile } from "./SentFiles";
import { formatBytes } from "@shared/format-bytes";
import { Composer } from "../../components/Composer";
import { openMakeCards } from "../../components/MakeCardsDialog";
import { MathText } from "../../components/math/MathText";
import { ContextBlock } from "../../components/ContextBlock";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { MarkdownView, type ChatBlocks } from "../../components/MarkdownView";
import { chatQuestions } from "@shared/chat-blocks";
import { ToolResult } from "./ToolResult";
import { savedToolLine } from "@shared/tool-blocks";
import { Notice } from "../../components/Notice";
import { OcrDataCard } from "../../components/OcrData";
import { isOcrRefusal } from "../../components/ocrErrors";
import { invoke, onBroadcast } from "../../lib/ipc";
import { MAX_ATTACHED_FILES, MAX_DROPPED_FILES } from "@shared/source-types";
import type { AttachmentView } from "@shared/ipc";
import {
  ATTACH_EXTENSIONS,
  attachable,
  attachmentLine,
  chipLine,
  composerHolds,
  draftKey,
  filesReading,
  isLocalFile,
  type PickedFile,
  readPendingSubject,
  takeBoardAttachment,
  writePendingSubject,
} from "./attachments";
import { attachQueue, drafts, syncDraftFiles, useDraftFiles, useFilePreviews, useFileViews } from "./draftSession";
import { mergeFiles, type Preview } from "./draftFiles";
import { ChatHeader } from "./ChatHeader";
import { pastedPng } from "./paste";
import { answerPreview, replyPlainText } from "./replyText";
import { chipState, newChipState, settleNewSubject, subjectToSend, type NewChatSubject } from "./scope";
import { SubjectChip, type SubjectPick } from "./SubjectChip";
import { UsedSources } from "./UsedSources";
import { SourcesRow } from "../../components/SourcesRow";
import { citedOrder } from "../../lib/sourcePlaces";
import { textClaims } from "../../lib/mathChecks";
import { canContinue } from "./continuable";
import { ConversationOutline } from "./ConversationOutline";
import { currentMark, jumpRange, outlineMarks, pinnedMark, type OutlineMark } from "./outline";
import { dayPart } from "./greeting";
import { useEngineError } from "../../lib/engineError";
import { useEngineNames } from "../../lib/useEngineNames";
import { questionStored, runsIn, turns, type Turn } from "./turns";
import "./AskPage.css";
import { useChats, usePlan, useProfile, useSources, useSubjects } from "../../lib/queries";
import type { MathTextEditorHandle } from "../../components/math/MathTextEditor";

function errorKey(err: unknown): string {
  return err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "errors.internal";
}

function errorDetail(err: unknown): string {
  const detail =
    err && typeof err === "object" && "detail" in err
      ? (err as { detail: unknown }).detail
      : "";
  return typeof detail === "string" ? detail.slice(0, 2000) : "";
}

function errorParams(err: unknown): Record<string, unknown> {
  const params =
    err && typeof err === "object" && "params" in err
      ? (err as { params: unknown }).params
      : undefined;
  return params && typeof params === "object" ? (params as Record<string, unknown>) : {};
}

type ChatRow = Awaited<ReturnType<typeof invoke<"chats.read">>>["messages"][number];
/** A message taken out of the composer as it was sent, put back if its turn fails or is stopped. */
type Held = { draft: string; files: PickedFile[] };
type Skipped = Array<"too-large" | "unreadable" | "over-limit">;
/** The files a sent question went without. `key` is given when they arrive, so closing one notice leaves the others as they are. */
type LeftOutFile = { name: string; kind: "document" | "photo"; error: AttachmentView["error"] & string };
type LeftOut = Array<LeftOutFile & { key: number }>;
let leftOutKeys = 0;

/** Whether each chat's latest question was asked with "Answer generally", which Try again and Regenerate keep. */
const askedGeneral = new Map<string, boolean>();
/** The chats on screen, so a remount in the same tick does not count as leaving one. */
const onScreen = new Set<string>();

/**
 * What a turn needs from the Ask page when it ends. That can be a later mount than the one it was sent from, or none
 * when the student is on another page: then nothing navigates, and the message goes back to its chat's saved draft.
 */
type Screen = {
  /** The chat on screen, "" for a new one. */
  chat: () => string;
  /** The chat whose draft and files the composer holds. */
  composer: () => string;
  restore: (held: Held) => void;
  /** The reply was saved in `to`: the notices for it, and a move there from a new chat. */
  replied: (to: string, uncovered: string | null, skipped: Skipped, announce: boolean, leftOut?: LeftOutFile[]) => void;
  fail: (err: unknown) => void;
};
let screen: { current: Screen } | null = null;
/** The page on screen, if it shows the turn's chat. */
const showing = (turn: Turn) =>
  screen && runsIn(turn, screen.current.chat()) ? screen.current : null;
/** Stands in for a turn's chat while none runs. */
const noChat = { subscribe: () => () => undefined, get: () => "" };

/** Replies that have just been written and not drawn yet: their sources row grows out of the text when they appear. */
const arrivedReplies = new Set<string>();

/** A chat opens with this many recent messages; older ones join as the student scrolls up to them. */
const RECENT = 8;

/** One function identity across renders that always calls the latest `fn`, so a memoized message keeps its props. */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: A) => latest.current(...args), []);
}

const Question = memo(function Question({ id, body, files }: { id?: string; body: string; files?: readonly SentFile[] }) {
  return (
    <ChatMessage role="user" messageId={id} attachments={files && files.length > 0 ? <SentFiles files={files} /> : undefined}>
      <MathText text={body} />
    </ChatMessage>
  );
});

/**
 * A finished reply. The chat query hands back the same row object until the row changes, so with stable handlers a
 * new message or a streamed piece leaves this one alone instead of parsing its Markdown and math again.
 */
const Reply = memo(function Reply({
  chatId,
  row,
  last,
  busy,
  onRegenerate,
  onAnswerStronger,
  onSuggest,
  onReact,
  onMakeCards,
  onAnswer,
  onPicking,
}: {
  chatId: string;
  row: ChatRow;
  /** The reply that ends the chat: it carries Regenerate and the suggestions. */
  last: boolean;
  busy: boolean;
  onRegenerate?: () => void;
  onAnswerStronger?: () => void;
  onSuggest: (text: string) => void;
  onReact: (messageId: string, reaction: "up" | "down") => void;
  onMakeCards: (row: ChatRow) => void;
  onAnswer: (messageId: string, questionId: string, pick: number) => Promise<number>;
  /** A pick waits for «Controlla» (true) or no longer (false), by the reply and the question it is in. */
  onPicking: (pick: string, picking: boolean) => void;
}) {
  const describeEngineError = useEngineError();
  const engineNames = useEngineNames();
  // A reply the engine cut short because its sign-in was refused names that engine and offers its sign-in.
  const failure = row.error
    ? describeEngineError(row.error, row.provider ?? undefined)
    : undefined;
  // The passages the reply cites, as the row under it lists them; a mark for any other is left out of the text.
  const places = useMemo(
    () =>
      row.citations.map((cite) => ({
        n: cite.index,
        passageId: cite.passageId,
        sourceId: cite.sourceId || undefined,
        title: cite.sourceTitle,
        page: cite.locator.page,
        slide: cite.locator.slide,
        chapter: cite.locator.chapter,
        picture: cite.locator.picture,
        section: cite.label,
        version: cite.version,
      })),
    [row.citations],
  );
  const knownPassage = useCallback((index: number) => row.citations.some((cite) => cite.index === index), [row.citations]);
  const order = useMemo(() => citedOrder(row.body), [row.body]);
  const claims = useMemo(() => textClaims(row.body, row.checks), [row.body, row.checks]);
  // Only the reply that has just been written grows its row out of the text; the ones already there are drawn as they are.
  const [arriving] = useState(() => arrivedReplies.delete(row.id));
  const makeCards = useCallback(() => onMakeCards(row), [onMakeCards, row]);
  const { t, i18n } = useTranslation();
  // The reply's practice questions: «Controlla» keeps the pick with the reply, «Un'altra domanda» asks for one more
  // while no other answer is being written.
  const blocks = useMemo<ChatBlocks>(
    () => ({
      answers: row.answers,
      onCheck: (questionId, pick) => onAnswer(row.id, questionId, pick),
      onAnother: busy ? undefined : () => onSuggest(t("components.question.anotherMessage")),
      // Only the chat's latest question offers one more: the request says "on the same topic", which an older card's
      // topic may no longer be.
      anotherFor: last ? [...chatQuestions(row.body).keys()].at(-1) : undefined,
      // Two replies can hold the same question, so a pick waiting for «Controlla» is known by its reply too.
      onPicking: (questionId, picking) => onPicking(`${row.id}\n${questionId}`, picking),
    }),
    [row.answers, row.id, row.body, last, onAnswer, busy, onSuggest, t, onPicking],
  );
  // The model that wrote the reply, and the stronger one when it solved the exercise: "Claude · Sonnet 5.5 con Opus 5.5".
  // A solver of another tool, pinned in Settings, is named with its tool.
  const engineTag = (reply: typeof row) => {
    const main = engineNames.label(reply.provider, reply.modelId);
    const solved = Object.values(reply.tools ?? {}).find((view) => view.tool === "ask_stronger_model");
    if (!main || !solved) return main || undefined;
    const model =
      solved.provider === reply.provider
        ? engineNames.modelName(solved.provider, solved.model)
        : engineNames.label(solved.provider, solved.model);
    return t("components.chat.engineWithSolver", { engine: main, model });
  };
  // A saved reply never has a tool at work: a `pending:` block in it is drawn as nothing (`savedToolLine`). A proposal
  // waiting for the student counts as a pick waiting for «Controlla»: its confirming button is the primary, so «Invia»
  // is quiet.
  const proposalWaiting = useCallback(
    (id: string, waiting: boolean) => onPicking(`${row.id}\nproposal:${id}`, waiting),
    [onPicking, row.id],
  );
  const toolBlock = useCallback((line: string) => {
    const saved = savedToolLine(line);
    return saved ? (
      <ToolResult
        chatId={chatId}
        line={saved}
        view={row.tools?.[saved]}
        onWaiting={proposalWaiting}
        onAsk={busy ? undefined : onSuggest}
        fresh={arriving}
      />
    ) : null;
  }, [chatId, row.tools, proposalWaiting, busy, onSuggest, arriving]);
  return (
    <ChatMessage
      engine={engineTag(row)}
      lead={<UsedSources grounding={row.grounding} citations={row.citations} searched={row.searched} body={row.body} results={row.results} />}
      sources={<SourcesRow places={places} order={order} claims={claims} arriving={arriving} />}
      stopped={row.stopped}
      failure={failure?.text}
      failureAction={failure?.action}
      checking={row.checking}
      text={replyPlainText(row.body, i18n.language, row.answers)}
      onMakeCards={makeCards}
      reaction={row.reaction}
      regenerateDisabled={busy}
      onRegenerate={last ? onRegenerate : undefined}
      onAnswerStronger={last ? onAnswerStronger : undefined}
      suggestions={last && !busy && row.followups.length > 0 ? row.followups : undefined}
      onSuggest={onSuggest}
      onReact={(reaction) => onReact(row.id, reaction)}
    >
      <MarkdownView checks={row.checks} figures={row.figures} knownPassage={knownPassage} toolBlock={toolBlock} blocks={blocks}>
        {row.body}
      </MarkdownView>
    </ChatMessage>
  );
});

/** A reply being written draws its chart and question blocks, and no question can be answered until it is saved. */
const STREAMING_BLOCKS: ChatBlocks = {};

/** The question just sent, until the chat as read holds it. Core names a reused question only once the reply has begun. */
function PendingQuestion({ turn, last }: { turn: Turn; last: ChatRow | undefined }) {
  useSyncExternalStore(turn.questionId.subscribe, turn.questionId.get);
  return turn.question === null || questionStored(turn, last) ? null : <Question body={turn.question} files={turn.files} />;
}

/** The reply being written. Only this component follows the stream, so the conversation above it does not re-render. */
function StreamingReply({
  turn,
  usesSources,
  onGrow,
}: {
  turn: Turn;
  usesSources: boolean;
  onGrow: () => void;
}) {
  const text = useSyncExternalStore(turn.live.subscribe, turn.live.get);
  const passages = useSyncExternalStore(turn.passages.subscribe, turn.passages.get);
  const figures = useSyncExternalStore(turn.figures.subscribe, turn.figures.get);
  const tools = useSyncExternalStore(turn.tools.subscribe, turn.tools.get);
  const chatId = useSyncExternalStore(turn.chat.subscribe, turn.chat.get);
  // «Annulla» pressed while the reply is written goes into the turn, so a page that mounts the reply again shows it.
  const toolBlock = useCallback(
    (line: string) => (
      <ToolResult chatId={chatId} line={line} view={tools[line]} onView={(view) => turns.toolChanged(turn, view)} />
    ),
    [chatId, tools, turn],
  );
  // Only the marks of the passages retrieved for this turn stay as anchors; the row comes with the saved reply.
  const knownPassage = useCallback((index: number) => passages.some((passage) => passage.index === index), [passages]);
  useEffect(() => onGrow(), [text, onGrow]);
  return text ? (
    <ChatMessage role="tutor" streaming>
      <MarkdownView drawing figures={figures} knownPassage={knownPassage} toolBlock={toolBlock} blocks={STREAMING_BLOCKS}>
        {text}
      </MarkdownView>
    </ChatMessage>
  ) : (
    <ThinkingMessage usesSources={usesSources} />
  );
}

export function AskPage() {
  const { t, i18n } = useTranslation();
  const { chatId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  // The draft and picked files belong to the chat on screen; each chat keeps its own for the session (see draftKey).
  const composerFor = useRef(chatId);
  const [draft, setDraft] = useState(
    () => sessionStorage.getItem(draftKey(chatId)) ?? "",
  );
  const profile = useProfile();
  // A new chat's subject before its first question: Pyxis picks unless the student chooses one on the first page. The
  // choice stays in the session with the new chat's draft, so the whiteboard, the graph or the Library do not lose it.
  const [newSubject, setNewSubject] = useState<NewChatSubject>(() => readPendingSubject(sessionStorage));
  const field = useRef<MathTextEditorHandle>(null);
  const [uncovered, setUncovered] = useState<string | null>(null);
  // The reply being written, kept outside the page so it survives leaving Ask and coming back. Its text shows only in
  // the chat it was sent from, and the page follows it to its new chat only if the student is still there.
  const turn = useSyncExternalStore(turns.subscribe, turns.get);
  const busy = turn !== null;
  // A new chat's reply shows on its own page too, once core has named the chat it created.
  const turnChat = useSyncExternalStore((turn?.chat ?? noChat).subscribe, (turn?.chat ?? noChat).get);
  const streamHere = turn !== null && (turn.from === (chatId ?? "") || turnChat === chatId);
  // The question just sent, shown at once: the stored message only arrives with the reply.
  const pendingQuestion = turn?.question ?? null;
  const regenerating = turn?.regenerating ?? false;
  // The finished reply, read out once by screen readers.
  const [announcement, setAnnouncement] = useState("");
  const chatNow = useRef(chatId);
  chatNow.current = chatId;
  const arrived = useRef<string | null>(null);
  // The files of the draft on screen. They live in the session store, so an attach that finishes while another chat is on
  // screen lands in the draft that started it, and each draft is attached to one batch at a time (see `draftFiles.ts`).
  const files = useDraftFiles(chatId ?? "");
  // What core says of each picked file, kept by its id: its reading, or why it failed. A chip refused before core held it
  // has a `local-` id and a view made here.
  const views = useFileViews();
  const previews = useFilePreviews();
  // Files the last question went without, because they could not be read.
  const [leftOut, setLeftOut] = useState<LeftOut>([]);
  useEffect(() => onBroadcast("chats.attachment", (view) => drafts.views.put(view)), []);
  // Files kept for a chat that was left are asked about again, and the ones core no longer holds drop off.
  useEffect(() => {
    void syncDraftFiles(chatId ?? "").catch(() => undefined);
  }, [chatId]);
  // Moving to another chat shows that chat's own draft and files.
  useLayoutEffect(() => {
    if (composerFor.current === chatId) return;
    composerFor.current = chatId;
    setDraft(sessionStorage.getItem(draftKey(chatId)) ?? "");
    // A new chat shows the subject kept for it, which is Pyxis's choice once its first question has gone.
    setNewSubject(readPendingSubject(sessionStorage));
  }, [chatId]);
  useEffect(() => {
    const board = takeBoardAttachment(sessionStorage);
    if (!board) return;
    void attachPaths([board.path], board.preview ? { src: board.preview, alt: t("tools.whiteboardTitle") } : undefined);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [errorValues, setErrorValues] = useState<Record<string, unknown>>({});
  const [errorText, setErrorText] = useState("");
  function fail(err: unknown) {
    setError(errorKey(err));
    setErrorValues(errorParams(err));
    setErrorText(errorDetail(err));
  }
  const describeEngineError = useEngineError();
  // A refused sign-in names its engine and offers its sign-in; every other failure keeps its own message.
  const failure = error
    ? describeEngineError(
        error,
        typeof errorValues.provider === "string" ? errorValues.provider : undefined,
        errorValues,
      )
    : null;
  // Saved photos the last answer did not see, so a shorter context is never silent.
  const [skipped, setSkipped] = useState<Skipped>([]);

  const sources = useSources();
  const subjects = useSubjects();

  const thread = useQuery({
    queryKey: ["chat", chatId],
    enabled: Boolean(chatId),
    queryFn: () => invoke("chats.read", { chatId: chatId ?? "" }),
  });
  // A chat being read has a state of its own, so the greeting does not flash first, and one that can't be read says so.
  const threadLoading = Boolean(chatId) && thread.isPending;
  const threadFailed = Boolean(chatId) && thread.isError && !thread.data;

  // Notices belong to the chat they were raised in; the chat a new reply just moved to keeps its own.
  useEffect(() => {
    if (chatId && arrived.current === chatId) {
      arrived.current = null;
      return;
    }
    setUncovered(null);
    setSkipped([]);
    setLeftOut([]);
    setError(null);
  }, [chatId]);

  // The kept choice follows a subject renamed in the Library meanwhile, and gives way when the subject is gone.
  useEffect(() => {
    if (!subjects.data) return;
    const settled = settleNewSubject(newSubject, subjects.data);
    if (JSON.stringify(settled) === JSON.stringify(newSubject)) return;
    setNewSubject(settled);
    writePendingSubject(sessionStorage, settled);
  }, [subjects.data, newSubject]);

  // A reply's math check runs after the reply is saved. When it ends, the chat is read again for its badges.
  useEffect(
    () =>
      onBroadcast("chats.checks", (event) => {
        void client.invalidateQueries({ queryKey: ["chat", event.chatId] });
      }),
    [client],
  );

  // Core keeps the engine's conversation, and a live CLI process, for the chat on screen. Leaving it lets that stop, and
  // removes a chat that was opened and never sent, unless its composer holds text or files. A remount in the same tick
  // (StrictMode in development) is not leaving.
  useEffect(() => {
    if (!chatId) return;
    onScreen.add(chatId);
    return () => {
      onScreen.delete(chatId);
      setTimeout(() => {
        if (onScreen.has(chatId)) return;
        const draft = composerHolds(sessionStorage, chatId, attachQueue.busy(chatId));
        void invoke("chats.leave", { chatId, draft }).catch(() => undefined);
      }, 0);
    };
  }, [chatId]);

  /** The student picks the chat's subject from its chip. A new chat keeps the choice for its first question. */
  async function pickSubject(pick: SubjectPick) {
    const said =
      pick.kind === "subject"
        ? t("ask.chip.nowSubject", { name: pick.name })
        : pick.kind === "library"
          ? t("ask.chip.nowLibrary")
          : t("ask.chip.nowPyxis");
    if (!chatId) {
      const row = pick.kind === "subject" ? subjects.data?.find((subject) => subject.name === pick.name) : undefined;
      const choice: NewChatSubject = pick.kind === "subject" ? { ...pick, id: row?.id } : pick;
      setNewSubject(choice);
      writePendingSubject(sessionStorage, choice);
      setAnnouncement(said);
      return;
    }
    try {
      await invoke("chats.setSubject", { chatId, subject: pick.kind === "subject" ? pick.name : null });
      setAnnouncement(said);
    } catch {
      fail({ messageKey: "ask.chip.failed" });
    }
    void client.invalidateQueries({ queryKey: ["chat", chatId] });
    void client.invalidateQueries({ queryKey: ["chats"] });
  }

  const messages = thread.data?.messages ?? [];
  const held = thread.data?.held ?? [];
  // Regenerate and the suggestions belong to the answer that ends the chat. A question left without one gets Try again.
  const lastRow = messages.at(-1);
  const lastTutor = lastRow?.role === "assistant" ? lastRow : undefined;
  const unanswered = lastRow?.role === "user";
  // The exam a chat was opened from names the chip when the chat has no subject of its own.
  const plan = usePlan(thread.data?.planId, Boolean(thread.data?.planId) && !thread.data?.subject);
  const chip = chatId
    ? thread.data
      ? chipState({ ...thread.data, planTitle: plan.data?.title })
      : null
    : newChipState(newSubject);
  const subjectNames = (subjects.data ?? []).map((row) => row.name);

  // The page fills the viewport, so the composer sits at the foot of the window even with one short message. The shell
  // around it has its own padding, so the page borrows that space back with a negative bottom margin.
  useLayoutEffect(() => {
    const node = page.current;
    const root = document.scrollingElement;
    if (!node || !root) return;
    const fit = () => {
      const top = node.getBoundingClientRect().top + root.scrollTop;
      let below = 0;
      for (let el: HTMLElement | null = node; el && el !== document.body; el = el.parentElement) {
        for (let sib = el.nextElementSibling; sib; sib = sib.nextElementSibling) {
          const style = getComputedStyle(sib);
          if (style.position !== "fixed" && style.position !== "absolute")
            below += (sib as HTMLElement).offsetHeight;
        }
        if (el === node) continue;
        const style = getComputedStyle(el);
        below +=
          (parseFloat(style.marginBottom) || 0) +
          (parseFloat(style.paddingBottom) || 0) +
          (parseFloat(style.borderBottomWidth) || 0);
      }
      const min = `${Math.max(320, Math.round(window.innerHeight - top))}px`;
      const gap = `${-Math.round(below)}px`;
      if (node.style.minHeight !== min) node.style.minHeight = min;
      if (node.style.marginBottom !== gap) node.style.marginBottom = gap;
    };
    fit();
    window.addEventListener("resize", fit);
    const watch =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    if (node.parentElement) watch?.observe(node.parentElement);
    return () => {
      window.removeEventListener("resize", fit);
      watch?.disconnect();
    };
  }, []);

  // Keep the newest text in view while the student has not scrolled up.
  const page = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  function toBottom() {
    const root = document.scrollingElement;
    if (root) root.scrollTo({ top: root.scrollHeight });
  }
  useEffect(() => {
    const root = () => document.scrollingElement ?? document.documentElement;
    let last = root().scrollTop;
    let lastHeight = root().scrollHeight;
    // Only scrolling up stops following. Layout also lowers the scroll position: a skipped message settles to its real
    // height (content-visibility), a reply swaps the live text for the saved one. The page is then shorter than at the
    // previous event, and chips that arrive right after make it look far from the bottom. A drop with the same page
    // height is the student; a drop with a new height is layout, and the resize watcher below pins the end again.
    const onScroll = () => {
      const el = root();
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 96) following.current = true;
      else if (el.scrollTop < last && el.scrollHeight === lastHeight) following.current = false;
      last = el.scrollTop;
      lastHeight = el.scrollHeight;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // Opening a chat lands on its latest message.
  useLayoutEffect(() => {
    following.current = true;
  }, [chatId]);
  useEffect(() => {
    if (following.current) toBottom();
  }, [messages.length, busy, pendingQuestion, thread.dataUpdatedAt]);
  const followStream = useCallback(() => {
    if (following.current) toBottom();
  }, []);
  useEffect(() => {
    const node = page.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      if (following.current) toBottom();
    });
    watch.observe(node);
    return () => watch.disconnect();
  }, []);

  // A suggestion chip or "Answer generally" sends only its own text: the typed draft and pending photos stay in the composer, unsent.
  async function send(
    text: string,
    options: { allowGeneral?: boolean; textOnly?: boolean } = {},
  ) {
    const trimmed = text.trim();
    if (!trimmed || turns.get()) return;
    if (chatId && !thread.data) return;
    const startedIn = chatId ?? "";
    /** The draft's files that go with the question, as the question shows them. */
    const sentFiles = () =>
      options.textOnly
        ? []
        : drafts.files
            .get(startedIn)
            .filter((file) => !isLocalFile(file))
            .map((file) => ({
              id: file.id,
              name: file.name,
              kind: drafts.views.get()[file.id]?.kind ?? "document",
              src: drafts.previews.get()[file.id]?.src,
            }));
    // The turn starts now and belongs to the draft it was sent from: the composer shows it working (and offers Stop) while
    // files still being registered with core, from a pick Enter caught half way, finish and go with this question.
    const turn = turns.start(startedIn, trimmed, false, messages.at(-1)?.id ?? null, sentFiles());
    if (!turn) return;
    setError(null);
    setAnnouncement("");
    setSkipped([]);
    setLeftOut([]);
    following.current = true;
    // The submitted text leaves the composer, which is not editable while the turn works; a failed or stopped turn puts it back.
    const held: Held = { draft, files: drafts.files.get(startedIn) };
    if (!options.textOnly) {
      setDraft("");
      sessionStorage.removeItem(draftKey(chatId));
    }
    // A new chat's first question takes the subject chosen for it, which stays kept only until the question has gone.
    const sentSubject = chatId ? null : newSubject;
    if (sentSubject) writePendingSubject(sessionStorage, { kind: "auto" });
    // The message goes back to the chat it was sent from, even if the student has moved to another one or left Ask.
    const restore = () => {
      if (sentSubject && readPendingSubject(sessionStorage).kind === "auto") writePendingSubject(sessionStorage, sentSubject);
      if (options.textOnly || turn.dropped) return;
      const from = startedIn || undefined;
      // The files go back to the draft the question was sent from, whatever is on screen now.
      drafts.files.set(startedIn, (current) => mergeFiles(held.files, current));
      const page = screen?.current;
      if (page && page.composer() === startedIn) page.restore(held);
      if (held.draft && !sessionStorage.getItem(draftKey(from)))
        sessionStorage.setItem(draftKey(from), held.draft);
    };
    if (!options.textOnly && attachQueue.busy(startedIn)) {
      let stopped = false;
      let wake = () => {};
      turn.stop = () => {
        stopped = true;
        wake();
      };
      await Promise.race([attachQueue.idle(startedIn), new Promise<void>((resolve) => (wake = resolve))]);
      if (stopped) {
        restore();
        turns.end(turn);
        return;
      }
    }
    // Only now are the draft's files known: the ones still being registered have been applied to it.
    const picked = drafts.files.get(startedIn);
    if (!options.textOnly) turns.setFiles(turn, sentFiles());
    // A file refused before core held it never goes with the question.
    const attached = options.textOnly ? [] : picked.filter((file) => !isLocalFile(file));
    held.files = picked;
    if (!options.textOnly) drafts.files.set(startedIn, []);
    if (startedIn) askedGeneral.set(startedIn, options.allowGeneral === true);
    const handle = window.pyxis.stream(
      "chats.ask",
      {
        chatId,
        text: trimmed,
        // A new chat's first question carries the subject chosen on its first page; a saved chat keeps its own.
        subject: chatId ? undefined : subjectToSend(newSubject),
        attachments: attached.length > 0 ? attached.map((file) => file.id) : undefined,
        allowGeneral: options.allowGeneral === true,
      },
      turn.onEvent,
    );
    turn.stop = handle.cancel;
    try {
      const result = (await handle.result) as Awaited<
        ReturnType<typeof invoke<"chats.ask">>
      >;
      if (!result) {
        restore();
        return;
      }
      askedGeneral.set(result.chatId, options.allowGeneral === true);
      // A new chat's first question made the chat: the files picked meanwhile for its composer follow it, in core (`rehome`) and
      // here, whether or not Chiedi is on screen.
      if (!startedIn) {
        drafts.files.set(result.chatId, (current) => [...current, ...drafts.files.get("")]);
        drafts.files.set("", []);
      }
      // The files went with the question, so their previews are not needed any more.
      drafts.previews.drop(attached.map((file) => file.id));
      if (result.message) arrivedReplies.add(result.message.id);
      // Store the new messages in the cache before the placeholder goes, so the reply replaces it without a gap.
      await client
        .fetchQuery({
          queryKey: ["chat", result.chatId],
          queryFn: () => invoke("chats.read", { chatId: result.chatId }),
          staleTime: 0,
        })
        .catch(() => undefined);
      void client.invalidateQueries({ queryKey: ["chats"] });
      showing(turn)?.replied(
        result.chatId,
        result.covered ? null : trimmed,
        result.skippedImages ?? [],
        Boolean(result.message),
        result.leftOut,
      );
    } catch (err) {
      restore();
      // An existing chat keeps the question it stored, so the thread shows it with Try again.
      if (startedIn && !turn.dropped)
        void client.invalidateQueries({ queryKey: ["chat", startedIn] });
      if (errorKey(err) !== "errors.aborted" && !turn.dropped) showing(turn)?.fail(err);
    } finally {
      turns.end(turn);
    }
  }

  // A short notice, not the reply itself: the reply is already in the message list, and a second copy of its text would
  // be read twice and confuse anything that looks the reply up by its words.
  function announce() {
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(t("ask.replied")), 50);
  }

  const here = useRef<Screen>(null!);
  here.current = {
    chat: () => chatNow.current ?? "",
    composer: () => composerFor.current ?? "",
    restore(held) {
      setDraft((current) => current || held.draft);
      // Core kept the files while the send ran, so the chips come back as they are now, ready.
      const ids = held.files.filter((file) => !isLocalFile(file)).map((file) => file.id);
      if (ids.length > 0)
        void invoke("chats.attachments", { ids }).then(
          (list) => drafts.views.put(...list),
          () => undefined,
        );
    },
    replied(to, notCovered, skippedImages, reply, left = []) {
      setUncovered(notCovered);
      setSkipped(skippedImages);
      setLeftOut(left.map((file) => ({ ...file, key: (leftOutKeys += 1) })));
      if (reply) announce();
      if (to === (chatNow.current ?? "")) return;
      arrived.current = to;
      // Anything typed or picked while the first reply was written moves with the student to the new chat.
      if (!chatNow.current) {
        const typed = sessionStorage.getItem(draftKey());
        if (typed) sessionStorage.setItem(draftKey(to), typed);
        sessionStorage.removeItem(draftKey());
        composerFor.current = to;
      }
      // The new chat takes the place of the empty page it was written on, which starts the trail as Nuova chat does: a
      // chat made here has no way back, and Back never returns to an empty Chiedi.
      navigate(`/ask/${to}`, { replace: true, state: { via: "sidebar" } });
    },
    fail,
  };
  // Only a mounted page takes a turn's ending: one the student left does not navigate or show notices.
  useLayoutEffect(() => {
    const mine = here;
    screen = mine;
    return () => {
      if (screen === mine) screen = null;
    };
  }, []);

  /**
   * Answers the last question again. `strong` uses the strongest model; `resume` continues a reply that was cut short.
   */
  function regenerate(options: { engine?: "strong"; resume?: boolean } = {}) {
    if (!chatId) return;
    const turn = turns.start(chatId, null, true);
    if (!turn) return;
    setError(null);
    setAnnouncement("");
    // Continue keeps the saved part on screen, with its citation chips: the cut-off reply is hidden while it runs, core
    // adds to this text, and it answers from the same passages in the same numbering.
    if (options.resume && lastTutor) turns.continueFrom(turn, lastTutor);
    following.current = true;
    const question = messages.filter((message) => message.role === "user").at(-1)?.body ?? "";
    const handle = window.pyxis.stream(
      "chats.regenerate",
      {
        chatId,
        ...options,
        allowGeneral: askedGeneral.get(chatId) === true,
      },
      turn.onEvent,
    );
    turn.stop = handle.cancel;
    void handle.result
      .then(async (result) => {
        const reply = result as Awaited<
          ReturnType<typeof invoke<"chats.regenerate">>
        >;
        await client.invalidateQueries({ queryKey: ["chat", chatId] });
        // Answering a stored question lets its files go: the chips that came back to the composer with it go too.
        void syncDraftFiles(chatId).catch(() => undefined);
        const last = client
          .getQueryData<Awaited<ReturnType<typeof invoke<"chats.read">>>>(["chat", chatId])
          ?.messages.at(-1);
        showing(turn)?.replied(
          chatId,
          reply.covered ? null : question,
          reply.skippedImages ?? [],
          reply.covered && last?.role === "assistant",
        );
      })
      .catch((err: unknown) => {
        if (errorKey(err) !== "errors.aborted" && !turn.dropped) showing(turn)?.fail(err);
      })
      .finally(() => {
        turns.end(turn);
      });
  }

  const conversation =
    messages.length > 0 || (streamHere && pendingQuestion !== null);
  const shownMessages = regenerating && streamHere
    ? messages.filter((row) => row.id !== lastTutor?.id)
    : messages;
  const usesSources = (sources.data?.length ?? 0) > 0 || files.length > 0;
  const name = profile.data?.displayName.trim() ?? "";
  // Home is a chat with nothing in it yet: the greeting with the composer under it, in the middle of the page.
  const home = !conversation && !threadLoading && !threadFailed;
  const part = dayPart(new Date().getHours());

  // Where the rendered part of a long chat starts. It is fixed when the chat opens, so new messages add to the end
  // without pushing older ones out, and it moves back as the student scrolls up.
  const [range, setRange] = useState<{ chat?: string; from: number }>({ from: 0 });
  const firstShown =
    range.chat === chatId ? range.from : Math.max(0, shownMessages.length - RECENT);
  useEffect(() => {
    if (thread.data && range.chat !== chatId)
      setRange({ chat: chatId, from: Math.max(0, thread.data.messages.length - RECENT) });
  }, [chatId, thread.data, range.chat]);
  const showEarlier = useStable(() =>
    setRange({ chat: chatId, from: Math.max(0, firstShown - RECENT) }),
  );
  const earlier = useRef<HTMLDivElement>(null);
  // Reaching the top of what is shown loads the previous messages. Watching again after each load catches a chat
  // whose recent messages are too short to fill the window.
  useEffect(() => {
    const node = earlier.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showEarlier();
      },
      { rootMargin: "600px 0px 0px 0px" },
    );
    watch.observe(node);
    return () => watch.disconnect();
  }, [firstShown, chatId, showEarlier]);

  // The outline of the conversation: one mark per question from the third on, the part in view marked, and a jump that
  // first renders the question when it is among the older messages that are not shown yet.
  const marks = useMemo(() => outlineMarks(messages, answerPreview), [messages]);
  const [inView, setInView] = useState(-1);
  // A jump marks the question it went to until the student scrolls away, whatever else the window shows.
  const pinned = useRef<{ chat: string; index: number; top: number } | null>(null);
  useEffect(() => {
    if (marks.length === 0) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const root = document.scrollingElement ?? document.documentElement;
      const held = pinnedMark(pinned.current, chatId ?? "", root.scrollTop);
      if (held !== null) return setInView(held);
      pinned.current = null;
      const tops = marks.map(
        (mark) => document.querySelector(`[data-message="${CSS.escape(mark.id)}"]`)?.getBoundingClientRect().top ?? null,
      );
      const atEnd = root.scrollHeight - root.scrollTop - root.clientHeight < 8;
      setInView(currentMark(tops, window.innerHeight * 0.4, atEnd));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const watch = typeof ResizeObserver === "undefined" || !page.current ? undefined : new ResizeObserver(schedule);
    if (page.current) watch?.observe(page.current);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      watch?.disconnect();
    };
  }, [marks, firstShown, chatId]);
  const [jump, setJump] = useState<string | null>(null);
  const jumpTo = useStable((mark: OutlineMark) => {
    following.current = false;
    setRange({ chat: chatId, from: jumpRange(firstShown, mark.row) });
    setJump(mark.id);
  });
  useLayoutEffect(() => {
    if (!jump) return;
    const question = document.querySelector(`[data-message="${CSS.escape(jump)}"]`);
    // Not rendered yet: the range just set renders it, and this runs again.
    if (!question) return;
    setJump(null);
    question.scrollIntoView({ block: "start" });
    const index = marks.findIndex((mark) => mark.id === jump);
    pinned.current = { chat: chatId ?? "", index, top: (document.scrollingElement ?? document.documentElement).scrollTop };
    setInView(index);
    question.classList.add("is-spot");
    setTimeout(() => question.classList.remove("is-spot"), 1400);
  }, [jump, firstShown, messages, marks]);

  const lastTutorId = lastTutor?.id;
  // Called with no arguments: a click event must not reach `regenerate` as its options.
  const regenerateNow = useStable(() => regenerate());
  const strongerNow = useStable(() => regenerate({ engine: "strong" }));
  const continueNow = useStable(() => regenerate({ resume: true }));
  const makeCards = useStable((row: ChatRow) =>
    openMakeCards({
      text: replyPlainText(row.body),
      origin: "reply",
      planId: thread.data?.planId ?? undefined,
      subject: thread.data?.subject ?? undefined,
      passageIds: row.citations.map((cite) => cite.passageId),
    }),
  );
  const suggest = useStable((text: string) => void send(text, { textOnly: true }));
  const answer = useStable(async (messageId: string, questionId: string, pick: number) => {
    const kept = (await invoke("chats.answerQuestion", { chatId: chatId ?? "", messageId, questionId, pick })).pick;
    // The chat as read carries the answer at once, so the reply shows it again after leaving the chat and coming back.
    client.setQueryData<typeof thread.data>(["chat", chatId], (data) =>
      data
        ? {
            ...data,
            messages: data.messages.map((message) =>
              message.id === messageId ? { ...message, answers: { ...message.answers, [questionId]: kept } } : message,
            ),
          }
        : data,
    );
    return kept;
  });
  // The practice questions with an option picked and not checked, by reply and question, and the proposals waiting for
  // the student: while there is one, Invia is quiet.
  const [picking, setPicking] = useState<ReadonlySet<string>>(() => new Set());
  const pickingChanged = useStable((pick: string, on: boolean) =>
    setPicking((current) => {
      if (current.has(pick) === on) return current;
      const next = new Set(current);
      if (on) next.add(pick);
      else next.delete(pick);
      return next;
    }),
  );
  const react = useStable((messageId: string, reaction: "up" | "down") => {
    void invoke("chats.rate", { messageId, reaction }).then(
      () => client.invalidateQueries({ queryKey: ["chat", chatId] }),
      fail,
    );
  });

  const chats = useChats();
  const title = chatId
    ? (chats.data?.find((chat) => chat.id === chatId)?.title ?? thread.data?.title)
    : undefined;
  // A back control elsewhere calls this chat by its title. A chat opened from another page (a lesson's selection, an
  // exam's topic) leads back there; one opened from the sidebar, and a new chat, have none.
  const back = usePlace({ name: title ? { text: title } : null, back: chatId ? "show" : "none" });

  // Pasted screenshots and dropped files join the picked files. A note says when some could not.
  const [attachNote, setAttachNote] = useState<string | null>(null);
  useEffect(() => setAttachNote(null), [chatId]);
  const [dropping, setDropping] = useState(false);
  /**
   * Attaches files to the draft on screen. Core reads each one at once and tells how it goes, so the chip shows the reading.
   * The draft's queue runs one batch at a time and applies each result to this draft, so a switch to another chat meanwhile
   * moves nothing, and a ninth file is marked as over the limit when it is picked.
   */
  function attachPaths(paths: string[], preview?: Preview): Promise<void> {
    return attachQueue.attach(chatId ?? "", paths, preview);
  }
  /** Takes a file off the composer: core stops its reading and deletes what it made. */
  function removeFile(file: PickedFile) {
    drafts.files.set(chatId ?? "", (current) => current.filter((item) => item.id !== file.id));
    drafts.previews.drop([file.id]);
    if (!isLocalFile(file)) void invoke("chats.detach", { id: file.id }).catch(() => undefined);
  }
  async function attachPasted(images: File[]) {
    setAttachNote(null);
    for (const image of images) {
      try {
        const src = await pastedPng(image);
        const staged = await invoke("tools.stagePng", { dataUrl: src });
        await attachPaths([staged.path], { src, alt: t("ask.pastedImage"), name: t("ask.pastedImage") });
      } catch {
        setAttachNote("ask.pasteFailed");
      }
    }
  }
  async function attachDropped(dropped: File[]) {
    setAttachNote(null);
    if (dropped.length > MAX_DROPPED_FILES) {
      setAttachNote("ask.dropTooMany");
      return;
    }
    try {
      const granted = await window.pyxis.grantDroppedFiles(dropped);
      const usable = attachable(granted.paths);
      if (usable.paths.length > 0) await attachPaths(usable.paths);
      if (granted.skipped + usable.skipped > 0) setAttachNote("ask.dropSkipped");
    } catch (err) {
      fail(err);
    }
  }
  // Invia waits while a picked file is still being read.
  const reading = filesReading(files.map((file) => views[file.id]));
  // Scans among the picked files that wait for the OCR language data.
  const waitingForData = files.filter((file) => views[file.id]?.state === "needs-data");
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

  return (
    <div className="ask-layout">
    <div
      className={home ? "ask-page ask-home" : "ask-page"}
      ref={page}
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDropping(false);
        const dropped = Array.from(event.dataTransfer.files);
        if (dropped.length > 0) void attachDropped(dropped);
      }}
    >
      <ChatHeader
        chatId={chatId}
        title={title}
        back={back}
        chip={
          // With no subject in the Library there is nothing to choose, until a chat has one of its own.
          chip && (subjectNames.length > 0 || chip.kind !== "auto") ? (
            <SubjectChip
              chat={chatId ?? ""}
              state={chip}
              subjects={subjectNames}
              allowAuto={!chatId}
              disabled={busy}
              onPick={(pick) => void pickSubject(pick)}
              // The student goes on typing after choosing.
              focusAfterChoice={() => field.current?.focus()}
            />
          ) : null
        }
      />
      {threadFailed ? (
        <div className="ask-thread">
          <h1 className="visually-hidden">{t("doors.ask")}</h1>
          <Notice
            tone="danger"
            details={errorDetail(thread.error) || undefined}
            action={{ label: t("ask.retry"), onClick: () => void thread.refetch() }}
          >
            {t("ask.loadFailed")}
          </Notice>
        </div>
      ) : threadLoading ? (
        <div className="ask-thread">
          <h1 className="visually-hidden">{t("doors.ask")}</h1>
          {/* The shape of a question and its reply. It shows only when reading the chat takes a moment, so a quick open does not flash. */}
          <div className="ask-loading" role="status">
            <span className="visually-hidden">{t("ask.loadingChat")}</span>
            <div className="ask-loading-question" aria-hidden />
            <div aria-hidden>
              <Skeleton active title={false} paragraph={{ rows: 3, width: ["92%", "86%", "48%"] }} />
            </div>
          </div>
        </div>
      ) : !conversation ? (
        <div className="ask-greeting">
          <h1 className="display">
            {name
              ? t(`ask.greetingNamed.${part}`, { name })
              : t(`ask.greeting.${part}`)}
          </h1>
        </div>
      ) : (
        <div className="ask-thread">
          <h1 className="visually-hidden">{t("doors.ask")}</h1>
          {firstShown > 0 ? (
            <div className="ask-earlier" ref={earlier}>
              <Button shape="round" size="small" onClick={showEarlier}>
                {t("ask.showEarlier", { count: firstShown })}
              </Button>
            </div>
          ) : null}
          {shownMessages.slice(firstShown).map((row) =>
            row.role === "user" ? (
              <Question key={row.id} id={row.id} body={row.body} files={row.files} />
            ) : (
              <Reply
                key={row.id}
                chatId={chatId ?? ""}
                row={row}
                last={row.id === lastTutorId}
                busy={row.id === lastTutorId && busy}
                onRegenerate={chatId ? regenerateNow : undefined}
                onAnswerStronger={chatId ? strongerNow : undefined}
                onSuggest={suggest}
                onReact={react}
                onAnswer={answer}
                onPicking={pickingChanged}
                onMakeCards={makeCards}
              />
            ),
          )}
          {unanswered && chatId && !(busy && streamHere) ? (
            <div className="ask-retry">
              <Button
                shape="round"
                size="small"
                icon={<RefreshCw size={14} aria-hidden />}
                onClick={() => regenerate()}
                disabled={busy}
              >
                {t("ask.retry")}
              </Button>
            </div>
          ) : null}
          {streamHere && !regenerating ? <PendingQuestion turn={turn} last={lastRow} /> : null}
          {streamHere ? (
            <StreamingReply
              turn={turn}
              usesSources={usesSources}
              onGrow={followStream}
            />
          ) : null}
        </div>
      )}
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
      {conversation && marks.length > 0 ? <ConversationOutline marks={marks} current={inView} onJump={jumpTo} /> : null}
      <div className="ask-dock">
        {isOcrRefusal(error) ? (
          // The message and attached photos stay in the composer. Sending again is the student's call, since it asks the tutor.
          <OcrDataCard
            refusal={t(error)}
            onLater={() => setError(null)}
            readyAction={
              <Button
                type="primary"
                shape="round"
                disabled={busy}
                onClick={() => void send(draft)}
              >
                {t("sources.ocrData.again.send")}
              </Button>
            }
          />
        ) : failure ? (
          <Notice
            tone="danger"
            details={errorText || undefined}
            action={failure.action}
            onClose={() => setError(null)}
          >
            {failure.text}
          </Notice>
        ) : null}
        {(["too-large", "unreadable"] as const).map((reason) => {
          const count = skipped.filter((item) => item === reason).length;
          return count > 0 ? (
            <Notice key={reason} tone="warning" onClose={() => setSkipped((now) => now.filter((item) => item !== reason))}>
              {t(
                reason === "too-large"
                  ? "ask.skippedTooLarge"
                  : "ask.skippedUnreadable",
                { count },
              )}
            </Notice>
          ) : null;
        })}
        {attachNote ? (
          <Notice tone="warning" onClose={() => setAttachNote(null)}>
            {t(attachNote, { max: MAX_DROPPED_FILES })}
          </Notice>
        ) : null}
        {dropping ? (
          <p className="small ask-drop-hint" aria-hidden>
            {t("ask.dropActive")}
          </p>
        ) : null}
        {skipped.includes("over-limit") ? (
          <Notice tone="warning" onClose={() => setSkipped((now) => now.filter((item) => item !== "over-limit"))}>
            {t("ask.skippedOverLimit")}
          </Notice>
        ) : null}
        {leftOut.map((file) => (
          <Notice key={file.key} tone="warning" onClose={() => setLeftOut((now) => now.filter((item) => item !== file))}>
            {t("ask.attach.leftOut", { name: file.name })}{" "}
            {t(attachmentLine({ id: "", name: file.name, kind: file.kind, size: 0, state: "failed", error: file.error })!.key, { max: MAX_ATTACHED_FILES })}
          </Notice>
        ))}
        {uncovered && !busy ? (
          <Notice
            tone="warning"
            action={{
              label: t("ask.answerGeneral"),
              onClick: () =>
                void send(uncovered, { allowGeneral: true, textOnly: true }),
            }}
            onClose={() => setUncovered(null)}
          >
            {t("ask.notCovered")}
          </Notice>
        ) : null}
        {held.length > 0 ? (
          <div className="ask-held">
            {held.map((source) => (
              <Button
                key={source.id}
                shape="round"
                size="small"
                onClick={() => {
                  void invoke("sources.promote", { sourceId: source.id }).then(
                    () => {
                      void client.invalidateQueries({
                        queryKey: ["chat", chatId],
                      });
                      void client.invalidateQueries({ queryKey: ["sources"] });
                    },
                    fail,
                  );
                }}
              >
                {t("ask.promote", { title: source.title })}
              </Button>
            ))}
          </div>
        ) : null}
        {/* The quote waits in the composer until the first question goes; the tutor keeps reading it after that. */}
        {thread.data?.context && !conversation ? (
          <ContextBlock
            excerpt={<InlineMarkdown>{thread.data.context.body}</InlineMarkdown>}
            removeLabel={t("ask.contextRemove")}
            onRemove={() => {
              if (!chatId) return;
              void invoke("chats.clearContext", { chatId }).then(() => {
                void client.invalidateQueries({ queryKey: ["chat", chatId] });
              }, fail);
            }}
          />
        ) : null}
        {waitingForData.length > 0 ? (
          // A scan that waits for its reading data: the card downloads it, and the button reads the scan once it is here.
          <OcrDataCard
            refusal={t("ask.attach.needsData")}
            readyAction={
              <Button
                type="primary"
                shape="round"
                onClick={() => {
                  for (const file of waitingForData)
                    void invoke("chats.attachScan", { id: file.id }).catch(() => undefined);
                }}
              >
                {t("ask.attach.readScan")}
              </Button>
            }
          />
        ) : null}
        {files.length > 0 ? (
          <ul className="ask-attachments" aria-live="polite" aria-label={t("ask.attach.sent")}>
            {files.map((file) => {
              const preview = previews[file.id];
              const label = preview?.name ?? file.name;
              const view = views[file.id];
              return (
                <li key={file.id}>
                  <AttachmentChip
                    name={label}
                    line={view ? chipLine(view, t, (bytes) => formatBytes(bytes, i18n.language)) : ""}
                    state={view?.state === "failed" ? "failed" : view?.state === "reading" ? "reading" : "ready"}
                    progress={view?.progress}
                    thumbnail={preview ? { src: preview.src, alt: preview.alt } : undefined}
                    photo={view?.kind === "photo"}
                    removeLabel={t("ask.removeAttachment", { name: label, defaultValue: "Remove {{name}}" })}
                    onRemove={() => removeFile(file)}
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
        <Composer
          fieldRef={field}
          value={draft}
          onValueChange={(next) => {
            setDraft(next);
            sessionStorage.setItem(draftKey(composerFor.current), next);
          }}
          streaming={busy}
          waiting={reading > 0 ? t("ask.attach.waiting", { count: reading }) : undefined}
          quiet={picking.size > 0 && !draft.trim()}
          onStop={() => turns.get()?.stop()}
          onContinue={chatId && canContinue(messages, busy) ? continueNow : undefined}
          onSend={() => void send(draft)}
          onPasteImages={(images) => void attachPasted(images)}
          dropping={dropping}
          onAttach={() => {
            void window.pyxis
              .showOpenDialog({
                properties: ["openFile", "multiSelections"],
                filters: [
                  {
                    name: t("ask.attachFilter"),
                    extensions: [...ATTACH_EXTENSIONS],
                  },
                ],
              })
              .then((chosen) => {
                if (chosen && chosen.length > 0) void attachPaths(chosen);
              }, fail);
          }}
        />
      </div>
    </div>
    </div>
  );
}
