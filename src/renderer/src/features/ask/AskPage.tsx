import { openSourceViewer } from "../../components/SourceViewer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { PanelLeft, Plus, RefreshCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { ChatMessage, ThinkingMessage } from "../../components/ChatMessage";
import { Composer } from "../../components/Composer";
import { MathText } from "../../components/math/MathText";
import { ContextBlock } from "../../components/ContextBlock";
import { MarkdownView } from "../../components/MarkdownView";
import { Notice } from "../../components/Notice";
import { OcrDataCard } from "../../components/OcrData";
import { isOcrRefusal } from "../../components/ocrErrors";
import { invoke } from "../../lib/ipc";
import {
  draftKey,
  fileName,
  readPendingFiles,
  takeBoardAttachment,
  writePendingFiles,
  addPendingFiles,
} from "./attachments";
import { ChatPanel } from "./ChatPanel";
import { replyPlainText } from "./replyText";
import { addIds, allowsGeneral, applySubject, scopeItems, type ScopeItem } from "./scope";
import { SourcesMenu } from "./SourcesMenu";
import { SubjectMenu } from "./SubjectMenu";
import { latestEvery } from "./throttle";
import "./AskPage.css";

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

export function AskPage() {
  const { t } = useTranslation();
  const { chatId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  // The draft and picked files belong to the chat on screen; each chat keeps its own for the session (see draftKey).
  const composerFor = useRef(chatId);
  const [draft, setDraft] = useState(
    () => sessionStorage.getItem(draftKey(chatId)) ?? "",
  );
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => invoke("profile.get", {}),
  });
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
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState("");
  // Each delta carries the whole reply so far. Rendering it at most every 100 ms keeps long answers with math responsive.
  const liveUpdates = useRef(latestEvery<string>(100, setLive));
  // The finished reply, read out once by screen readers.
  const [announcement, setAnnouncement] = useState("");
  // A chat deleted while its reply streams: its turn ends quietly, without putting the message back.
  const dropped = useRef<string | null>(null);
  // The question just sent, shown at once: the stored message only arrives with the reply.
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  // Chats whose latest question was sent with "Answer generally". Try again and Regenerate keep that choice.
  const askedGeneral = useRef(new Set<string>());
  const [regenerating, setRegenerating] = useState(false);
  // The chat a reply is being written for ("" for a new one). Its text shows only there, and the page follows
  // the reply to its new chat only if the student is still on the chat it was sent from.
  const [streamIn, setStreamIn] = useState<string | null>(null);
  const streamHere = streamIn === (chatId ?? "");
  const streamNow = useRef(streamIn);
  streamNow.current = streamIn;
  const chatNow = useRef(chatId);
  chatNow.current = chatId;
  const arrived = useRef<string | null>(null);
  const [subject, setSubject] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [files, setFiles] = useState<string[]>(() =>
    readPendingFiles(sessionStorage, chatId),
  );
  // Whiteboard images staged by Attach, keyed by the file they belong to.
  const [previews, setPreviews] = useState<Record<string, string>>({});
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
    if (preview) setPreviews((current) => ({ ...current, [path]: preview }));
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
  const [skipped, setSkipped] = useState<
    Array<"too-large" | "unreadable" | "over-limit">
  >([]);
  const stop = useRef<(() => void) | null>(null);

  const sources = useQuery({
    queryKey: ["sources"],
    queryFn: () => invoke("sources.list", {}),
  });
  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: () => invoke("plans.list", {}),
  });

  const thread = useQuery({
    queryKey: ["chat", chatId],
    enabled: Boolean(chatId),
    queryFn: () => invoke("chats.read", { chatId: chatId ?? "" }),
  });

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
    const list = await client.ensureQueryData({
      queryKey: ["plans"],
      queryFn: () => invoke("plans.list", {}),
    });
    const found = await Promise.all(
      list
        .filter((plan) => plan.subject === name)
        .map((plan) =>
          client.fetchQuery({
            queryKey: ["plan", plan.id],
            queryFn: () => invoke("plans.read", { planId: plan.id }),
            staleTime: 15_000,
          }),
        ),
    );
    return found.flatMap((plan) => plan?.sources.map((source) => source.id) ?? []);
  }

  async function chooseSubject(next: string) {
    const previous = subject;
    if (next === previous) return;
    setSubject(next);
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
    const plan = await client.fetchQuery({
      queryKey: ["plan", id],
      queryFn: () => invoke("plans.read", { planId: id }),
      staleTime: 15_000,
    });
    setPicked((current) =>
      addIds(current, plan?.sources.map((source) => source.id) ?? []),
    );
  }

  function removeItem(item: ScopeItem) {
    if (item.kind === "plan") setPlanId(null);
    else setPicked((current) => current.filter((id) => id !== item.id));
  }

  const messages = thread.data?.messages ?? [];
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

  // The chat controls sit under the header, aligned with the logo's left edge, which is left of the centred column.
  useLayoutEffect(() => {
    const node = page.current;
    if (!node) return;
    const align = () => {
      const logo = document.querySelector("header img")?.getBoundingClientRect().left;
      const shift =
        logo === undefined ? 0 : Math.max(0, Math.round(node.getBoundingClientRect().left - logo));
      node.style.setProperty("--ask-bar-shift", `${shift}px`);
    };
    align();
    const frame = requestAnimationFrame(align);
    window.addEventListener("resize", align);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", align);
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
    // Only scrolling up stops following. Content that grows below, like the chips after a reply, can fire a scroll
    // event before Pyxis has caught up with it; that is not the student leaving the bottom.
    const onScroll = () => {
      const el = root();
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 96) following.current = true;
      else if (el.scrollTop < last) following.current = false;
      last = el.scrollTop;
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
  }, [messages.length, live, busy, pendingQuestion, thread.dataUpdatedAt]);
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
    if (!trimmed || busy) return;
    if (chatId && loadedFor.current !== chatId) return;
    setBusy(true);
    const startedIn = chatId ?? "";
    setStreamIn(startedIn);
    dropped.current = null;
    // Stop works from the first moment, also while the subject's sources are still loading.
    let stoppedEarly = false;
    stop.current = () => {
      stoppedEarly = true;
    };
    await scopeReady.current.catch(() => undefined);
    if (stoppedEarly) {
      stop.current = null;
      setStreamIn(null);
      setBusy(false);
      return;
    }
    const ids = visible(pickedNow.current);
    liveUpdates.current.cancel();
    setLive("");
    setError(null);
    setAnnouncement("");
    setSkipped([]);
    setPendingQuestion(trimmed);
    following.current = true;
    const attached = options.textOnly ? [] : files;
    // The message leaves the composer as it is sent; a failed or stopped turn puts it back.
    const held = { draft, files, previews };
    if (!options.textOnly) {
      setDraft("");
      setFiles([]);
      setPreviews({});
      sessionStorage.removeItem(draftKey(chatId));
    }
    // The message goes back to the chat it was sent from, even if the student has moved to another one since.
    const restore = () => {
      if (options.textOnly || dropped.current === startedIn) return;
      const from = startedIn || undefined;
      if ((composerFor.current ?? "") === startedIn) {
        setDraft((current) => current || held.draft);
        setFiles((current) => (current.length > 0 ? current : held.files));
        setPreviews((current) =>
          Object.keys(current).length > 0 ? current : held.previews,
        );
      } else if (readPendingFiles(sessionStorage, from).length === 0) {
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
    if (startedIn) {
      if (options.allowGeneral === true) askedGeneral.current.add(startedIn);
      else askedGeneral.current.delete(startedIn);
    }
    const handle = window.pyxis.stream(
      "chats.ask",
      {
        chatId,
        text: trimmed,
        sourceIds: ids,
        planId,
        mode,
        subject,
        files: attached.length > 0 ? attached : undefined,
        allowGeneral: general,
      },
      (event) => {
        const data = event as { text?: string };
        if (typeof data.text === "string") liveUpdates.current.push(data.text);
      },
    );
    stop.current = handle.cancel;
    try {
      const result = (await handle.result) as Awaited<
        ReturnType<typeof invoke<"chats.ask">>
      >;
      if (!result) {
        restore();
        return;
      }
      const stillHere = (chatNow.current ?? "") === startedIn;
      if (stillHere) {
        setUncovered(result.covered ? null : trimmed);
        setSkipped(result.skippedImages ?? []);
      }
      // Store the new messages in the cache before the placeholder goes, so the reply replaces it without a gap.
      await client
        .fetchQuery({
          queryKey: ["chat", result.chatId],
          queryFn: () => invoke("chats.read", { chatId: result.chatId }),
          staleTime: 0,
        })
        .catch(() => undefined);
      if (stillHere && result.message) announce();
      void client.invalidateQueries({ queryKey: ["chats"] });
      if (stillHere && result.chatId !== chatNow.current) {
        arrived.current = result.chatId;
        // Anything typed or picked while the first reply was written moves with the student to the new chat.
        if (!chatNow.current) {
          const typed = sessionStorage.getItem(draftKey());
          if (typed) sessionStorage.setItem(draftKey(result.chatId), typed);
          sessionStorage.removeItem(draftKey());
          writePendingFiles(sessionStorage, result.chatId, readPendingFiles(sessionStorage));
          writePendingFiles(sessionStorage, undefined, []);
          composerFor.current = result.chatId;
        }
        navigate(`/ask/${result.chatId}`);
      }
    } catch (err) {
      restore();
      // An existing chat keeps the question it stored, so the thread shows it with Try again.
      if (startedIn && dropped.current !== startedIn)
        void client.invalidateQueries({ queryKey: ["chat", startedIn] });
      if (errorKey(err) !== "errors.aborted" && dropped.current !== startedIn) fail(err);
    } finally {
      stop.current = null;
      liveUpdates.current.cancel();
      setLive("");
      setPendingQuestion(null);
      setStreamIn(null);
      setBusy(false);
    }
  }

  // A short notice, not the reply itself: the reply is already in the message list, and a second copy of its text would
  // be read twice and confuse anything that looks the reply up by its words.
  function announce() {
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(t("ask.replied")), 50);
  }

  function regenerate() {
    if (!chatId) return;
    setBusy(true);
    setStreamIn(chatId);
    setRegenerating(true);
    setError(null);
    setAnnouncement("");
    dropped.current = null;
    liveUpdates.current.cancel();
    setLive("");
    following.current = true;
    const handle = window.pyxis.stream(
      "chats.regenerate",
      {
        chatId,
        sourceIds: sendIds,
        planId,
        mode,
        subject,
        // Same rule as a first send: the reply's own grounding says nothing about whether sources are selected.
        allowGeneral: allowsGeneral({
          chosen: askedGeneral.current.has(chatId),
          planId,
          sourceCount: sendIds.length,
        }),
      },
      (event) => {
        const data = event as { text?: string };
        if (typeof data.text === "string") liveUpdates.current.push(data.text);
      },
    );
    stop.current = handle.cancel;
    void handle.result
      .then(async (result) => {
        const reply = result as Awaited<
          ReturnType<typeof invoke<"chats.regenerate">>
        >;
        if (chatNow.current === chatId) {
          setSkipped(reply.skippedImages ?? []);
          setUncovered(
            reply.covered
              ? null
              : (thread.data?.messages
                  .filter((message) => message.role === "user")
                  .at(-1)?.body ?? ""),
          );
        }
        await client.invalidateQueries({ queryKey: ["chat", chatId] });
        const last = client
          .getQueryData<Awaited<ReturnType<typeof invoke<"chats.read">>>>(["chat", chatId])
          ?.messages.at(-1);
        if (chatNow.current === chatId && reply.covered && last?.role === "assistant")
          announce();
      })
      .catch((err: unknown) => {
        if (errorKey(err) !== "errors.aborted" && dropped.current !== chatId) fail(err);
      })
      .finally(() => {
        stop.current = null;
        liveUpdates.current.cancel();
        setLive("");
        setRegenerating(false);
        setStreamIn(null);
        setBusy(false);
      });
  }

  const conversation =
    messages.length > 0 || (streamHere && pendingQuestion !== null);
  const shownMessages = regenerating && streamHere
    ? messages.filter((row) => row.id !== lastTutor?.id)
    : messages;
  const usesSources = hasScope || files.length > 0;
  const name = profile.data?.displayName.trim() ?? "";

  function openChat(id: string) {
    navigate(`/ask/${id}`);
  }

  /** A deleted chat's reply stops being written, and its saved draft and files go with it. */
  function chatDeleted(id: string) {
    sessionStorage.removeItem(draftKey(id));
    writePendingFiles(sessionStorage, id, []);
    if (streamNow.current === id) {
      dropped.current = id;
      stop.current?.();
    }
  }

  return (
    <div className="ask-page" ref={page}>
      <div className="ask-bar">
        <div className="ask-bar-tools">
          <Button
            type="text"
            aria-label={t("ask.chatsOpen")}
            aria-expanded={panelOpen}
            icon={<PanelLeft size={18} aria-hidden />}
            onClick={() => setPanelOpen(true)}
          />
          <Button
            type="text"
            icon={<Plus size={16} aria-hidden />}
            onClick={() => navigate("/ask")}
          >
            {t("ask.new")}
          </Button>
        </div>
      </div>
      <ChatPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        chatId={chatId}
        onOpenChat={openChat}
        onNew={() => navigate("/ask")}
        onDeleted={chatDeleted}
      />
      {!conversation ? (
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
        </div>
      ) : (
        <div className="ask-thread">
          <h1 className="visually-hidden">{t("doors.ask")}</h1>
          {shownMessages.map((row) =>
            row.role === "user" ? (
              <ChatMessage key={row.id} role="user">
                <MathText text={row.body} />
              </ChatMessage>
            ) : (
              <ChatMessage
                key={row.id}
                engine={
                  row.provider && row.modelId
                    ? `${row.provider} · ${row.modelId}`
                    : (row.modelId ?? row.provider ?? undefined)
                }
                general={row.grounding === "general"}
                stopped={row.stopped}
                text={replyPlainText(row.body)}
                reaction={row.reaction}
                regenerateDisabled={busy}
                onRegenerate={
                  row.id === lastTutor?.id && chatId
                    ? regenerate
                    : undefined
                }
                suggestions={
                  row.id === lastTutor?.id && !busy && row.followups.length > 0
                    ? row.followups
                    : undefined
                }
                onSuggest={(text) => send(text, { textOnly: true })}
                onReact={(reaction) => {
                  void invoke("chats.rate", {
                    messageId: row.id,
                    reaction,
                  }).then(
                    () => client.invalidateQueries({ queryKey: ["chat", chatId] }),
                    fail,
                  );
                }}
              >
                <MarkdownView
                  checks={row.checks}
                  figures={row.figures}
                  citationResolver={(index) =>
                    row.citations.find((cite) => cite.index === index)?.label
                  }
                  onCitationClick={(index) => {
                    const cite = row.citations.find(
                      (item) => item.index === index,
                    );
                    if (!cite) return;
                    openSourceViewer({
                      passageId: cite.passageId,
                      sourceId: cite.sourceId,
                    });
                  }}
                >
                  {row.body}
                </MarkdownView>
              </ChatMessage>
            ),
          )}
          {unanswered && chatId && !(busy && streamHere) ? (
            <div className="ask-retry">
              <Button
                shape="round"
                size="small"
                icon={<RefreshCw size={14} aria-hidden />}
                onClick={regenerate}
                disabled={busy}
              >
                {t("ask.retry")}
              </Button>
            </div>
          ) : null}
          {streamHere && pendingQuestion !== null && !regenerating ? (
            <ChatMessage role="user">
              <MathText text={pendingQuestion} />
            </ChatMessage>
          ) : null}
          {streamHere && busy && live ? (
            <ChatMessage role="tutor" streaming>
              <MarkdownView drawing>{live}</MarkdownView>
            </ChatMessage>
          ) : null}
          {streamHere && busy && !live ? <ThinkingMessage usesSources={usesSources} /> : null}
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
              const label = fileName(file);
              return (
                <li key={file}>
                  {previews[file] ? (
                    <img
                      alt={t("tools.whiteboardTitle")}
                      src={previews[file]}
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
          onStop={() => stop.current?.()}
          onSend={() => void send(draft)}
          onAttach={() => {
            void window.pyxis
              .showOpenDialog({
                properties: ["openFile", "multiSelections"],
                filters: [
                  {
                    name: t("ask.attachFilter"),
                    extensions: [
                      "png",
                      "jpg",
                      "jpeg",
                      "webp",
                      "heic",
                      "heif",
                      "pdf",
                      "docx",
                      "pptx",
                      "txt",
                      "md",
                    ],
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
