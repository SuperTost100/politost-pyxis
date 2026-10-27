import { openSourceViewer } from "../../components/SourceViewer";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Skeleton } from "antd";
import { RefreshCw, X } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { ChatMessage, ThinkingMessage } from "../../components/ChatMessage";
import { Composer } from "../../components/Composer";
import { openMakeCards } from "../../components/MakeCardsDialog";
import { MathText } from "../../components/math/MathText";
import { ContextBlock } from "../../components/ContextBlock";
import { MarkdownView } from "../../components/MarkdownView";
import { Notice } from "../../components/Notice";
import { OcrDataCard } from "../../components/OcrData";
import { isOcrRefusal } from "../../components/ocrErrors";
import { invoke, onBroadcast } from "../../lib/ipc";
import { MAX_DROPPED_FILES } from "@shared/source-types";
import {
  ATTACH_EXTENSIONS,
  attachable,
  draftKey,
  fileName,
  readPendingFiles,
  takeBoardAttachment,
  writePendingFiles,
  addPendingFiles,
} from "./attachments";
import { ChatHeader } from "./ChatHeader";
import { pastedPng } from "./paste";
import { ChatPanel } from "./ChatPanel";
import { replyPlainText } from "./replyText";
import {
  addIds,
  allowsGeneral,
  applySubject,
  choseGeneral,
  startOnOnlySubject,
  scopeItems,
  type ScopeItem,
} from "./scope";
import { SourcesMenu } from "./SourcesMenu";
import { SubjectMenu } from "./SubjectMenu";
import { activePlans, starterPrompts, type Starter } from "./starters";
import { formatTokens } from "../../lib/tokens";
import { questionStored, runsIn, turns, type Turn } from "./turns";
import "./AskPage.css";
import { planQuery, plansQuery, useChats, usePlans, useProfile, useSources, subjectsQuery } from "../../lib/queries";

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
/** An image staged for the next message, shown in its attachment chip. A pasted one is named for what it is. */
type Preview = { src: string; alt: string; name?: string };
/** A message taken out of the composer as it was sent, put back if its turn fails or is stopped. */
type Held = { draft: string; files: string[]; previews: Record<string, Preview> };
type Skipped = Array<"too-large" | "unreadable" | "over-limit">;

/** Whether each chat's latest question was asked with "Answer generally", for the session (see choseGeneral). */
const askedGeneral = new Map<string, boolean>();

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
  replied: (to: string, uncovered: string | null, skipped: Skipped, announce: boolean) => void;
  fail: (err: unknown) => void;
};
let screen: { current: Screen } | null = null;
/** The page on screen, if it shows the turn's chat. */
const showing = (turn: Turn) =>
  screen && runsIn(turn, screen.current.chat()) ? screen.current : null;
/** Stands in for a turn's chat while none runs. */
const noChat = { subscribe: () => () => undefined, get: () => "" };

/** A chat opens with this many recent messages; older ones join as the student scrolls up to them. */
const RECENT = 8;

/** One function identity across renders that always calls the latest `fn`, so a memoized message keeps its props. */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: A) => latest.current(...args), []);
}

const Question = memo(function Question({ body }: { body: string }) {
  return (
    <ChatMessage role="user">
      <MathText text={body} />
    </ChatMessage>
  );
});

/**
 * A finished reply. The chat query hands back the same row object until the row changes, so with stable handlers a
 * new message or a streamed piece leaves this one alone instead of parsing its Markdown and math again.
 */
const Reply = memo(function Reply({
  row,
  last,
  busy,
  onRegenerate,
  onAnswerStronger,
  onContinue,
  onSuggest,
  onReact,
  onMakeCards,
}: {
  row: ChatRow;
  /** The reply that ends the chat: it carries Regenerate and the suggestions. */
  last: boolean;
  busy: boolean;
  onRegenerate?: () => void;
  onAnswerStronger?: () => void;
  /** Continue a reply the engine cut short. */
  onContinue?: () => void;
  onSuggest: (text: string) => void;
  onReact: (messageId: string, reaction: "up" | "down") => void;
  onMakeCards: (row: ChatRow) => void;
}) {
  const { t } = useTranslation();
  const citationResolver = useCallback(
    (index: number) => row.citations.find((cite) => cite.index === index)?.label,
    [row.citations],
  );
  const onCitationClick = useCallback(
    (index: number) => {
      const cite = row.citations.find((item) => item.index === index);
      if (!cite) return;
      openSourceViewer({
        passageId: cite.passageId,
        sourceId: cite.sourceId,
      });
    },
    [row.citations],
  );
  const makeCards = useCallback(() => onMakeCards(row), [onMakeCards, row]);
  return (
    <ChatMessage
      engine={
        row.provider && row.modelId
          ? `${row.provider} · ${row.modelId}`
          : (row.modelId ?? row.provider ?? undefined)
      }
      general={row.grounding === "general"}
      stopped={row.stopped}
      failure={row.error ? t(row.error) : undefined}
      onContinue={last && row.error ? onContinue : undefined}
      checking={row.checking}
      text={replyPlainText(row.body)}
      onMakeCards={makeCards}
      reaction={row.reaction}
      regenerateDisabled={busy}
      onRegenerate={last ? onRegenerate : undefined}
      onAnswerStronger={last ? onAnswerStronger : undefined}
      suggestions={last && !busy && row.followups.length > 0 ? row.followups : undefined}
      onSuggest={onSuggest}
      onReact={(reaction) => onReact(row.id, reaction)}
    >
      <MarkdownView
        checks={row.checks}
        figures={row.figures}
        citationResolver={citationResolver}
        onCitationClick={onCitationClick}
      >
        {row.body}
      </MarkdownView>
    </ChatMessage>
  );
});

/** The question just sent, until the chat as read holds it. Core names a reused question only once the reply has begun. */
function PendingQuestion({ turn, last }: { turn: Turn; last: ChatRow | undefined }) {
  useSyncExternalStore(turn.questionId.subscribe, turn.questionId.get);
  return turn.question === null || questionStored(turn, last) ? null : <Question body={turn.question} />;
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
  // Only the passages retrieved for this turn link, with the labels the saved reply will show.
  const citationResolver = useCallback(
    (index: number) => passages.find((passage) => passage.index === index)?.label,
    [passages],
  );
  useEffect(() => onGrow(), [text, onGrow]);
  return text ? (
    <ChatMessage role="tutor" streaming>
      <MarkdownView drawing citationResolver={citationResolver}>
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
  const defaultMode = profile.data?.tutorMode ?? "solver";
  const [mode, setMode] = useState<"solver" | "socratic">(defaultMode);
  const [picked, setPicked] = useState<string[]>([]);
  // A subject's sources arrive after its plans are read; a message sent before then waits for them, so it is not sent
  // without the sources the student just picked.
  const pickedNow = useRef(picked);
  pickedNow.current = picked;
  const scopeReady = useRef<Promise<void>>(Promise.resolve());
  const [planId, setPlanId] = useState<string | null>(null);
  const loadedFor = useRef<string | undefined>(undefined);
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
  const [subject, setSubject] = useState("");
  // The subject a question goes out with: set at once when one is chosen, so a question waiting on scopeReady has it.
  const subjectNow = useRef(subject);
  subjectNow.current = subject;
  const [panelOpen, setPanelOpen] = useState(false);
  const [files, setFiles] = useState<string[]>(() =>
    readPendingFiles(sessionStorage, chatId),
  );
  // Images staged by the whiteboard's Attach or by a paste, keyed by the file they belong to.
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  // Picked files are kept by path, so opening the whiteboard or the graph and coming back does not lose them.
  useEffect(() => {
    writePendingFiles(sessionStorage, composerFor.current, files);
  }, [files]);
  // Moving to another chat shows that chat's own draft and files.
  useLayoutEffect(() => {
    if (composerFor.current === chatId) return;
    composerFor.current = chatId;
    setDraft(sessionStorage.getItem(draftKey(chatId)) ?? "");
    setFiles(readPendingFiles(sessionStorage, chatId));
    setPreviews({});
  }, [chatId]);
  useEffect(() => {
    const board = takeBoardAttachment(sessionStorage);
    if (!board) return;
    setFiles((current) =>
      current.includes(board.path) ? current : [...current, board.path],
    );
    const { path, preview } = board;
    if (preview)
      setPreviews((current) => ({
        ...current,
        [path]: { src: preview, alt: t("tools.whiteboardTitle") },
      }));
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [errorValues, setErrorValues] = useState<Record<string, unknown>>({});
  const [errorText, setErrorText] = useState("");
  function fail(err: unknown) {
    setError(errorKey(err));
    setErrorValues(errorParams(err));
    setErrorText(errorDetail(err));
  }
  // Saved photos the last answer did not see, so a shorter context is never silent.
  const [skipped, setSkipped] = useState<Skipped>([]);

  const sources = useSources();
  const plans = usePlans();

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
    setError(null);
  }, [chatId]);

  useEffect(() => {
    if (chatId) return;
    setPicked([]);
    setPlanId(null);
    setSubject("");
    setUncovered(null);
    loadedFor.current = undefined;
  }, [chatId]);

  // A new chat starts on the student's only subject, so a question typed at once reads its plans. It is set once per
  // new chat: choosing "No subject" afterwards stays. It waits for the reset above to clear the previous chat's subject.
  // A question sent while the subjects load waits for it through scopeReady; if they cannot be read, it goes without.
  const subjectDefaulted = useRef(false);
  useEffect(() => {
    if (chatId) {
      subjectDefaulted.current = false;
      return;
    }
    if (subjectDefaulted.current || subject !== "") return;
    subjectDefaulted.current = true;
    scopeReady.current = startOnOnlySubject(
      () => client.ensureQueryData(subjectsQuery),
      () => subjectNow.current,
      chooseSubject,
    ).catch(() => undefined);
  }, [chatId, subject]);

  // A reply's math check runs after the reply is saved. When it ends, the chat is read again for its badges.
  useEffect(
    () =>
      onBroadcast("chats.checks", (event) => {
        void client.invalidateQueries({ queryKey: ["chat", event.chatId] });
      }),
    [client],
  );

  // Core keeps the engine's conversation, and a live CLI process, for the chat on screen. Leaving it lets that stop.
  useEffect(() => {
    if (!chatId) return;
    return () => {
      void invoke("chats.leave", { chatId }).catch(() => undefined);
    };
  }, [chatId]);

  // ASK-02: a new conversation starts in the mode chosen in Settings.
  useEffect(() => {
    if (!chatId) setMode(defaultMode);
  }, [chatId, defaultMode]);

  useEffect(() => {
    if (!chatId || !thread.data) return;
    if (loadedFor.current === chatId) return;
    loadedFor.current = chatId;
    setPicked(thread.data.sourceIds);
    setPlanId(thread.data.planId);
    setSubject(thread.data.subject ?? "");
  }, [chatId, thread.data]);

  /** Sources of every plan filed under a subject: choosing the subject uses them. */
  async function subjectSourceIds(name: string): Promise<string[]> {
    if (!name) return [];
    const list = await client.ensureQueryData(plansQuery);
    const found = await Promise.all(
      list
        .filter((plan) => plan.subject === name)
        .map((plan) =>
          client.fetchQuery({ ...planQuery(plan.id), staleTime: 15_000 }),
        ),
    );
    return found.flatMap((plan) => plan?.sources.map((source) => source.id) ?? []);
  }

  async function chooseSubject(next: string) {
    const previous = subject;
    if (next === previous) return;
    setSubject(next);
    subjectNow.current = next;
    const plan = (plans.data ?? []).find((item) => item.id === planId);
    if (plan?.subject && plan.subject !== next) setPlanId(null);
    const ready = Promise.all([
      subjectSourceIds(previous),
      subjectSourceIds(next),
    ]).then(([before, after]) => {
      pickedNow.current = applySubject(pickedNow.current, before, after);
      setPicked(pickedNow.current);
    });
    scopeReady.current = ready;
    await ready;
  }

  async function addPlan(id: string) {
    const plan = await client.fetchQuery({ ...planQuery(id), staleTime: 15_000 });
    // Set here too, so a message sent right after (a starter prompt) carries the plan's sources.
    pickedNow.current = addIds(
      pickedNow.current,
      plan?.sources.map((source) => source.id) ?? [],
    );
    setPicked(pickedNow.current);
  }

  function removeItem(item: ScopeItem) {
    if (item.kind === "plan") setPlanId(null);
    else setPicked((current) => current.filter((id) => id !== item.id));
  }

  const messages = thread.data?.messages ?? [];
  const usage = chatId ? thread.data?.usage : null;
  const usageDetail = usage
    ? t("ask.usageDetail", {
        input: formatTokens(usage.inputTokens, i18n.language),
        output: formatTokens(usage.outputTokens, i18n.language),
        cached: formatTokens(usage.cacheReadTokens, i18n.language),
      })
    : "";
  const held = thread.data?.held ?? [];
  // Regenerate and the suggestions belong to the answer that ends the chat. A question left without one gets Try again.
  const lastRow = messages.at(-1);
  const lastTutor = lastRow?.role === "assistant" ? lastRow : undefined;
  const unanswered = lastRow?.role === "user";
  const items = scopeItems({
    planId,
    planTitle: (plans.data ?? []).find((plan) => plan.id === planId)?.title,
    picked,
    library: sources.data ?? [],
    held,
  });
  // The ids sent are the ones the student can see; a source deleted since the chat was saved is left out.
  const visible = (ids: string[]) =>
    sources.data
      ? ids.filter(
          (id) =>
            sources.data.some((source) => source.id === id) ||
            held.some((source) => source.id === id),
        )
      : ids;
  const sendIds = visible(picked);
  const hasScope = items.length > 0;

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
    options: { allowGeneral?: boolean; textOnly?: boolean; subject?: string } = {},
  ) {
    const trimmed = text.trim();
    if (!trimmed || turns.get()) return;
    if (chatId && loadedFor.current !== chatId) return;
    const startedIn = chatId ?? "";
    const turn = turns.start(startedIn, trimmed, false, messages.at(-1)?.id ?? null);
    if (!turn) return;
    // Stop works from the first moment, also while the subject's sources are still loading.
    let stoppedEarly = false;
    turn.stop = () => {
      stoppedEarly = true;
    };
    await scopeReady.current.catch(() => undefined);
    if (stoppedEarly) {
      turns.end(turn);
      return;
    }
    const ids = visible(pickedNow.current);
    setError(null);
    setAnnouncement("");
    setSkipped([]);
    following.current = true;
    const attached = options.textOnly ? [] : files;
    // The message leaves the composer as it is sent; a failed or stopped turn puts it back.
    const held: Held = { draft, files, previews };
    if (!options.textOnly) {
      setDraft("");
      setFiles([]);
      setPreviews({});
      sessionStorage.removeItem(draftKey(chatId));
    }
    // The message goes back to the chat it was sent from, even if the student has moved to another one or left Ask.
    const restore = () => {
      if (options.textOnly || turn.dropped) return;
      const from = startedIn || undefined;
      const page = screen?.current;
      if (page && page.composer() === startedIn) page.restore(held);
      else if (readPendingFiles(sessionStorage, from).length === 0) {
        writePendingFiles(sessionStorage, from, held.files);
      }
      if (held.draft && !sessionStorage.getItem(draftKey(from)))
        sessionStorage.setItem(draftKey(from), held.draft);
    };
    const general = allowsGeneral({
      chosen: options.allowGeneral === true,
      planId,
      sourceCount: ids.length,
      fileCount: attached.length,
    });
    if (startedIn) askedGeneral.set(startedIn, options.allowGeneral === true);
    const handle = window.pyxis.stream(
      "chats.ask",
      {
        chatId,
        text: trimmed,
        sourceIds: ids,
        planId,
        mode,
        subject: options.subject ?? subjectNow.current,
        files: attached.length > 0 ? attached : undefined,
        allowGeneral: general,
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
      setFiles((current) => (current.length > 0 ? current : held.files));
      setPreviews((current) =>
        Object.keys(current).length > 0 ? current : held.previews,
      );
    },
    replied(to, notCovered, skippedImages, reply) {
      setUncovered(notCovered);
      setSkipped(skippedImages);
      if (reply) announce();
      if (to === (chatNow.current ?? "")) return;
      arrived.current = to;
      // Anything typed or picked while the first reply was written moves with the student to the new chat.
      if (!chatNow.current) {
        const typed = sessionStorage.getItem(draftKey());
        if (typed) sessionStorage.setItem(draftKey(to), typed);
        sessionStorage.removeItem(draftKey());
        writePendingFiles(sessionStorage, to, readPendingFiles(sessionStorage));
        writePendingFiles(sessionStorage, undefined, []);
        composerFor.current = to;
      }
      navigate(`/ask/${to}`);
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

  /** Answers the last question again. `strong` uses the strongest model; `resume` continues a reply that was cut short. */
  function regenerate(options: { engine?: "strong"; resume?: boolean } = {}) {
    if (!chatId) return;
    const turn = turns.start(chatId, null, true);
    if (!turn) return;
    setError(null);
    setAnnouncement("");
    // Continue keeps the saved part on screen, with its citation chips: the cut-off reply is hidden while it runs, core
    // adds to this text, and it answers from the same passages in the same numbering.
    if (options.resume && lastTutor) {
      turn.live.set(lastTutor.body);
      turn.passages.set(lastTutor.citations.map(({ index, label }) => ({ index, label })));
    }
    following.current = true;
    const question = messages.filter((message) => message.role === "user").at(-1)?.body ?? "";
    const handle = window.pyxis.stream(
      "chats.regenerate",
      {
        chatId,
        ...options,
        sourceIds: sendIds,
        planId,
        mode,
        subject,
        // Same rule as a first send: the reply's own grounding says nothing about whether sources are selected.
        allowGeneral: allowsGeneral({
          chosen: choseGeneral(askedGeneral.get(chatId), messages),
          planId,
          sourceCount: sendIds.length,
        }),
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
      .finally(() => turns.end(turn));
  }

  const conversation =
    messages.length > 0 || (streamHere && pendingQuestion !== null);
  const shownMessages = regenerating && streamHere
    ? messages.filter((row) => row.id !== lastTutor?.id)
    : messages;
  const usesSources = hasScope || files.length > 0;
  const name = profile.data?.displayName.trim() ?? "";

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

  const lastTutorId = lastTutor?.id;
  // Called with no arguments: a click event must not reach `regenerate` as its options.
  const regenerateNow = useStable(() => regenerate());
  const strongerNow = useStable(() => regenerate({ engine: "strong" }));
  const continueNow = useStable(() => regenerate({ resume: true }));
  const makeCards = useStable((row: ChatRow) =>
    openMakeCards({
      text: replyPlainText(row.body),
      origin: "reply",
      planId: planId ?? undefined,
      subject: subject || undefined,
      passageIds: row.citations.map((cite) => cite.passageId),
    }),
  );
  const suggest = useStable((text: string) => void send(text, { textOnly: true }));
  const react = useStable((messageId: string, reaction: "up" | "down") => {
    void invoke("chats.rate", { messageId, reaction }).then(
      () => client.invalidateQueries({ queryKey: ["chat", chatId] }),
      fail,
    );
  });

  // Starter prompts on an empty chat, from the topics of the plans the student is preparing.
  const starterPlans = activePlans(plans.data ?? []);
  const starterReads = useQueries({
    queries: starterPlans.map((plan) => ({
      ...planQuery(plan.id),
      enabled: !conversation,
    })),
  });
  const starters = conversation
    ? []
    : starterPrompts(
        starterReads.flatMap((read) =>
          read.data
            ? [
                {
                  id: read.data.id,
                  subject: read.data.subject,
                  topics: [...read.data.topics].sort((a, b) => a.position - b.position),
                  studied: read.data.steps.flatMap((step) => (step.topicId ? [step.topicId] : [])),
                },
              ]
            : [],
        ),
      );
  /** A starter prompt asks at once, with its plan's material: the plan's subject when it has one, else its sources. */
  function start(starter: Starter) {
    if (busy) return;
    if (starter.subject) void chooseSubject(starter.subject);
    else scopeReady.current = addPlan(starter.planId);
    void send(t(`ask.starter.${starter.kind}`, { topic: starter.topic }), {
      textOnly: true,
      subject: starter.subject ?? subject,
    });
  }

  const chats = useChats();
  const title = chatId
    ? chats.data?.find((chat) => chat.id === chatId)?.title
    : undefined;

  // Pasted screenshots and dropped files join the picked files. A note says when some could not.
  const [attachNote, setAttachNote] = useState<string | null>(null);
  useEffect(() => setAttachNote(null), [chatId]);
  const [dropping, setDropping] = useState(false);
  async function attachPasted(images: File[]) {
    setAttachNote(null);
    for (const image of images) {
      try {
        const src = await pastedPng(image);
        const staged = await invoke("tools.stagePng", { dataUrl: src });
        setFiles((current) => addPendingFiles(current, [staged.path]));
        setPreviews((current) => ({
          ...current,
          [staged.path]: { src, alt: t("ask.pastedImage"), name: t("ask.pastedImage") },
        }));
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
      if (usable.paths.length > 0)
        setFiles((current) => addPendingFiles(current, usable.paths));
      if (granted.skipped + usable.skipped > 0) setAttachNote("ask.dropSkipped");
    } catch (err) {
      fail(err);
    }
  }
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

  function openChat(id: string) {
    navigate(`/ask/${id}`);
  }

  /** A deleted chat's reply stops being written, and its saved draft and files go with it. */
  function chatDeleted(id: string) {
    sessionStorage.removeItem(draftKey(id));
    writePendingFiles(sessionStorage, id, []);
    const running = turns.get();
    if (running && runsIn(running, id)) {
      running.dropped = true;
      running.stop();
    }
  }

  return (
    <div
      className="ask-page"
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
        panelOpen={panelOpen}
        onOpenPanel={() => setPanelOpen(true)}
        onNew={() => navigate("/ask")}
        usage={
          usage
            ? {
                short: t("ask.usage", {
                  count: usage.inputTokens + usage.outputTokens,
                  tokens: formatTokens(usage.inputTokens + usage.outputTokens, i18n.language, true),
                }),
                detail: usageDetail,
              }
            : undefined
        }
      />
      <ChatPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        chatId={chatId}
        onOpenChat={openChat}
        onNew={() => navigate("/ask")}
        onDeleted={chatDeleted}
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
            {name ? t("ask.greetingNamed", { name }) : t("ask.greeting")}
          </h1>
          <p className="body">
            {!hasScope
              ? t("ask.scopeEmpty")
              : subject
                ? t("ask.scopeSubject", { subject })
                : t("ask.scopeReady")}
          </p>
          {starters.length > 0 ? (
            <ul className="ask-starters" aria-label={t("ask.startersLabel")}>
              {starters.map((starter) => (
                <li key={`${starter.kind}-${starter.planId}-${starter.topic}`}>
                  <Button shape="round" disabled={busy} onClick={() => start(starter)}>
                    {t(`ask.starter.${starter.kind}`, { topic: starter.topic })}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="small ask-attach-hint">{t("ask.attachHint")}</p>
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
              <Question key={row.id} body={row.body} />
            ) : (
              <Reply
                key={row.id}
                row={row}
                last={row.id === lastTutorId}
                busy={row.id === lastTutorId && busy}
                onRegenerate={chatId ? regenerateNow : undefined}
                onAnswerStronger={chatId ? strongerNow : undefined}
                onContinue={chatId ? continueNow : undefined}
                onSuggest={suggest}
                onReact={react}
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
            <StreamingReply turn={turn} usesSources={usesSources} onGrow={followStream} />
          ) : null}
        </div>
      )}
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
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
        ) : error ? (
          <Notice tone="danger" details={errorText || undefined}>
            {t(error, errorValues)}
          </Notice>
        ) : null}
        {(["too-large", "unreadable"] as const).map((reason) => {
          const count = skipped.filter((item) => item === reason).length;
          return count > 0 ? (
            <Notice key={reason} tone="warning">
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
          <Notice tone="warning">{t(attachNote, { max: MAX_DROPPED_FILES })}</Notice>
        ) : null}
        {dropping ? (
          <p className="small ask-drop-hint" aria-hidden>
            {t("ask.dropActive")}
          </p>
        ) : null}
        {skipped.includes("over-limit") ? (
          <Notice tone="warning">{t("ask.skippedOverLimit")}</Notice>
        ) : null}
        {uncovered && !busy ? (
          <Notice
            tone="warning"
            action={{
              label: t("ask.answerGeneral"),
              onClick: () =>
                void send(uncovered, { allowGeneral: true, textOnly: true }),
            }}
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
        {thread.data?.context ? (
          <ContextBlock
            excerpt={
              <>
                <strong>{thread.data.context.title}</strong>{" "}
                {thread.data.context.body}
              </>
            }
            removeLabel={t("ask.contextRemove")}
            onRemove={() => {
              if (!chatId) return;
              void invoke("chats.clearContext", { chatId }).then(() => {
                void client.invalidateQueries({ queryKey: ["chat", chatId] });
              }, fail);
            }}
          />
        ) : null}
        {files.length > 0 ? (
          <ul className="ask-attachments">
            {files.map((file) => {
              const preview = previews[file];
              const label = preview?.name ?? fileName(file);
              return (
                <li key={file}>
                  {preview ? (
                    <img
                      alt={preview.alt}
                      src={preview.src}
                      className="ask-attachment-preview"
                    />
                  ) : null}
                  <span className="small">{label}</span>
                  <Button
                    type="text"
                    shape="circle"
                    size="small"
                    disabled={busy}
                    icon={<X size={14} aria-hidden />}
                    aria-label={t("ask.removeAttachment", {
                      name: label,
                      defaultValue: "Remove {{name}}",
                    })}
                    onClick={() => {
                      setFiles((current) =>
                        current.filter((item) => item !== file),
                      );
                      setPreviews((current) =>
                        Object.fromEntries(
                          Object.entries(current).filter(
                            ([key]) => key !== file,
                          ),
                        ),
                      );
                    }}
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
        <Composer
          subjectControl={
            <SubjectMenu
              value={subject}
              onChange={(next) => void chooseSubject(next)}
              disabled={busy}
            />
          }
          sourcesControl={
            <SourcesMenu
              items={items}
              library={(sources.data ?? []).map((source) => ({
                id: source.id,
                title: source.title,
              }))}
              plans={(plans.data ?? []).map((plan) => ({
                id: plan.id,
                title: plan.title,
              }))}
              onRemove={removeItem}
              onAddSource={(id) =>
                setPicked((current) => addIds(current, [id]))
              }
              onAddPlan={(id) => void addPlan(id)}
              disabled={busy}
            />
          }
          value={draft}
          onValueChange={(next) => {
            setDraft(next);
            sessionStorage.setItem(draftKey(composerFor.current), next);
          }}
          mode={mode}
          onModeChange={setMode}
          streaming={busy}
          onStop={() => turns.get()?.stop()}
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
                if (chosen && chosen.length > 0)
                  setFiles((current) => addPendingFiles(current, chosen));
              }, fail);
          }}
        />
      </div>
    </div>
  );
}
