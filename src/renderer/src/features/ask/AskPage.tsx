import { openSourceViewer } from "../../components/SourceViewer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { PanelLeft, Plus, X } from "lucide-react";
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
import { fileName, takeBoardAttachment } from "./attachments";
import { ChatPanel } from "./ChatPanel";
import { addIds, applySubject, scopeItems, type ScopeItem } from "./scope";
import { SourcesMenu } from "./SourcesMenu";
import { SubjectMenu } from "./SubjectMenu";
import "./AskPage.css";

function errorKey(err: unknown): string {
  return err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "errors.internal";
}

export function AskPage() {
  const { t } = useTranslation();
  const { chatId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [draft, setDraft] = useState(
    () => sessionStorage.getItem("pyxis-draft") ?? "",
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
  // The question just sent, shown at once: the stored message only arrives with the reply.
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [subject, setSubject] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  // Whiteboard images staged by Attach, keyed by the file they belong to.
  const [previews, setPreviews] = useState<Record<string, string>>({});
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

  useEffect(() => {
    if (chatId) return;
    setPicked([]);
    setPlanId(null);
    setSubject("");
    setUncovered(null);
    loadedFor.current = undefined;
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
  const lastTutor = [...messages]
    .reverse()
    .find((row) => row.role === "assistant");
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
    const onScroll = () => {
      const el = root();
      following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
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
    await scopeReady.current.catch(() => undefined);
    const ids = visible(pickedNow.current);
    setLive("");
    setError(null);
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
      sessionStorage.removeItem("pyxis-draft");
    }
    const restore = () => {
      if (options.textOnly) return;
      setDraft((current) => current || held.draft);
      setFiles((current) => (current.length > 0 ? current : held.files));
      setPreviews((current) =>
        Object.keys(current).length > 0 ? current : held.previews,
      );
      if (held.draft) sessionStorage.setItem("pyxis-draft", held.draft);
    };
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
        allowGeneral:
          options.allowGeneral === true ||
          (!planId && ids.length === 0 && attached.length === 0),
      },
      (event) => {
        const data = event as { text?: string };
        if (typeof data.text === "string") setLive(data.text);
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
      setUncovered(result.covered ? null : trimmed);
      setSkipped(result.skippedImages ?? []);
      // Store the new messages in the cache before the placeholder goes, so the reply replaces it without a gap.
      await client
        .fetchQuery({
          queryKey: ["chat", result.chatId],
          queryFn: () => invoke("chats.read", { chatId: result.chatId }),
          staleTime: 0,
        })
        .catch(() => undefined);
      void client.invalidateQueries({ queryKey: ["chats"] });
      if (result.chatId !== chatId) navigate(`/ask/${result.chatId}`);
    } catch (err) {
      restore();
      const key = errorKey(err);
      if (key !== "errors.aborted") setError(key);
    } finally {
      stop.current = null;
      setLive("");
      setPendingQuestion(null);
      setBusy(false);
    }
  }

  function regenerate() {
    if (!chatId) return;
    setBusy(true);
    setRegenerating(true);
    setError(null);
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
        allowGeneral: !planId && sendIds.length === 0,
      },
      (event) => {
        const data = event as { text?: string };
        if (typeof data.text === "string") setLive(data.text);
      },
    );
    stop.current = handle.cancel;
    void handle.result
      .then(async (result) => {
        const reply = result as Awaited<
          ReturnType<typeof invoke<"chats.regenerate">>
        >;
        setSkipped(reply.skippedImages ?? []);
        setUncovered(
          reply.covered
            ? null
            : (thread.data?.messages
                .filter((message) => message.role === "user")
                .at(-1)?.body ?? ""),
        );
        await client.invalidateQueries({ queryKey: ["chat", chatId] });
      })
      .catch((err: unknown) => {
        const key = errorKey(err);
        if (key !== "errors.aborted") setError(key);
      })
      .finally(() => {
        stop.current = null;
        setLive("");
        setRegenerating(false);
        setBusy(false);
      });
  }

  const conversation = messages.length > 0 || pendingQuestion !== null;
  const shownMessages = regenerating
    ? messages.filter((row) => row.id !== lastTutor?.id)
    : messages;
  const usesSources = hasScope || files.length > 0;
  const name = profile.data?.displayName.trim() ?? "";

  function openChat(id: string) {
    navigate(`/ask/${id}`);
  }

  return (
    <div className="ask-page" ref={page}>
      <div className="ask-bar">
        <Button
          type="text"
          shape="circle"
          aria-label={t("ask.chatsOpen")}
          aria-expanded={panelOpen}
          icon={<PanelLeft size={18} aria-hidden />}
          onClick={() => setPanelOpen(true)}
        />
        <Button
          type="text"
          shape="round"
          icon={<Plus size={16} aria-hidden />}
          onClick={() => navigate("/ask")}
        >
          {t("ask.new")}
        </Button>
      </div>
      <ChatPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        chatId={chatId}
        onOpenChat={openChat}
        onNew={() => navigate("/ask")}
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
                text={row.body}
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
                  }).then(() =>
                    client.invalidateQueries({ queryKey: ["chat", chatId] }),
                  );
                }}
              >
                <MarkdownView
                  checks={row.checks}
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
          {pendingQuestion !== null && !regenerating ? (
            <ChatMessage role="user">
              <MathText text={pendingQuestion} />
            </ChatMessage>
          ) : null}
          {busy && live ? (
            <ChatMessage role="tutor">
              <MarkdownView>{live}</MarkdownView>
            </ChatMessage>
          ) : null}
          {busy && !live ? <ThinkingMessage usesSources={usesSources} /> : null}
        </div>
      )}
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
          <Notice tone="danger">{t(error)}</Notice>
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
              });
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
            sessionStorage.setItem("pyxis-draft", next);
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
                    name: "Files",
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
                  setFiles((current) => [...current, ...chosen]);
              });
          }}
        />
      </div>
    </div>
  );
}
