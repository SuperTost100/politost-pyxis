import { SubjectPicker } from "./SubjectPicker";
import { openSourceViewer } from "../../components/SourceViewer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { ChatMessage } from "../../components/ChatMessage";
import { Composer } from "../../components/Composer";
import { MarkdownView } from "../../components/MarkdownView";
import { Notice } from "../../components/Notice";
import { OcrDataCard } from "../../components/OcrData";
import { isOcrRefusal } from "../../components/ocrErrors";
import { invoke } from "../../lib/ipc";
import { fileName, takeBoardAttachment } from "./attachments";

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
  const [planId, setPlanId] = useState<string | null>(null);
  const loadedFor = useRef<string | undefined>(undefined);
  const [uncovered, setUncovered] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState("");
  const [subject, setSubject] = useState("");
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

  const history = useQuery({
    queryKey: ["chats"],
    queryFn: () => invoke("chats.list", {}),
  });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState<Record<string, string>>({});
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
    setHistoryOpen(false);
  }, [chatId]);

  useEffect(() => {
    if (chatId) return;
    setPicked([]);
    setPlanId(null);
    setSubject("");
    setUncovered(null);
    setHistoryOpen(false);
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

  // A suggestion chip or "Answer generally" sends only its own text: the typed draft and pending photos stay in the composer, unsent.
  async function send(
    text: string,
    options: { allowGeneral?: boolean; textOnly?: boolean } = {},
  ) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    if (chatId && loadedFor.current !== chatId) return;
    setBusy(true);
    setLive("");
    setError(null);
    setSkipped([]);
    const attached = options.textOnly ? [] : files;
    const handle = window.pyxis.stream(
      "chats.ask",
      {
        chatId,
        text: trimmed,
        sourceIds: picked,
        planId,
        mode,
        subject,
        files: attached.length > 0 ? attached : undefined,
        allowGeneral:
          options.allowGeneral === true ||
          (!planId && picked.length === 0 && attached.length === 0),
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
      if (!result) return;
      if (!options.textOnly) {
        setDraft("");
        setFiles([]);
        setPreviews({});
        sessionStorage.removeItem("pyxis-draft");
      }
      setUncovered(result.covered ? null : trimmed);
      setSkipped(result.skippedImages ?? []);
      void client.invalidateQueries({ queryKey: ["chat", result.chatId] });
      void client.invalidateQueries({ queryKey: ["chats"] });
      if (result.chatId !== chatId) navigate(`/ask/${result.chatId}`);
    } catch (err) {
      const key =
        err && typeof err === "object" && "messageKey" in err
          ? String((err as { messageKey: unknown }).messageKey)
          : "errors.internal";
      if (key !== "errors.aborted") setError(key);
    } finally {
      stop.current = null;
      setLive("");
      setBusy(false);
    }
  }

  const messages = thread.data?.messages ?? [];
  const lastTutor = [...messages]
    .reverse()
    .find((row) => row.role === "assistant");
  const planTitle = (plans.data ?? []).find(
    (plan) => plan.id === planId,
  )?.title;
  const titles = [
    ...(planTitle ? [planTitle] : []),
    ...(sources.data ?? [])
      .filter((source) => picked.includes(source.id))
      .map((source) => source.title),
  ];

  const historyList =
    (history.data ?? []).length > 0 ? (
      <ul className="choice-list" aria-label={t("ask.history")}>
        {(history.data ?? []).map((chat) => (
          <li key={chat.id}>
            <Button
              type="text"
              onClick={() => {
                setHistoryOpen(false);
                navigate(`/ask/${chat.id}`);
              }}
            >
              {chat.title?.trim() || t("ask.untitled")}
            </Button>
            <Input
              aria-label={t("ask.rename")}
              value={titleDraft[chat.id] ?? chat.title ?? ""}
              onChange={(event) =>
                setTitleDraft((current) => ({
                  ...current,
                  [chat.id]: event.target.value,
                }))
              }
              onBlur={() => {
                const title = (titleDraft[chat.id] ?? chat.title ?? "").trim();
                if (!title || title === chat.title) return;
                void invoke("chats.rename", { chatId: chat.id, title }).then(
                  () => client.invalidateQueries({ queryKey: ["chats"] }),
                );
              }}
            />
            <Button
              type="text"
              danger={confirmDelete === chat.id}
              onClick={() => {
                if (confirmDelete !== chat.id) {
                  setConfirmDelete(chat.id);
                  return;
                }
                void invoke("chats.delete", { chatId: chat.id }).then(() => {
                  setConfirmDelete(null);
                  void client.invalidateQueries({ queryKey: ["chats"] });
                  if (chat.id === chatId) navigate("/ask");
                });
              }}
            >
              {confirmDelete === chat.id
                ? t("ask.deleteConfirm")
                : t("ask.delete")}
            </Button>
          </li>
        ))}
      </ul>
    ) : null;

  return (
    <div className="ask-home">
      {chatId ? (
        <div className="gallery-row">
          <Button type="text" onClick={() => navigate("/ask")}>
            {t("ask.new")}
          </Button>
          <Button
            type="text"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            {t("ask.history")}
          </Button>
        </div>
      ) : null}
      {chatId ? (historyOpen ? historyList : null) : historyList}
      {messages.length === 0 ? (
        <div className="ask-greeting">
          <h1 className="display">{t("ask.greeting")}</h1>
          <p className="body">
            {picked.length === 0 && !planId
              ? t("ask.scopeEmpty")
              : t("ask.scopeReady")}
          </p>
        </div>
      ) : (
        <div className="reading-column">
          <h1 className="visually-hidden">{t("doors.ask")}</h1>
          {messages.map((row) =>
            row.role === "user" ? (
              <ChatMessage key={row.id} role="user">
                {row.body}
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
                    ? () => {
                        setBusy(true);
                        setError(null);
                        setLive("");
                        const handle = window.pyxis.stream(
                          "chats.regenerate",
                          {
                            chatId,
                            sourceIds: picked,
                            planId,
                            mode,
                            subject,
                            allowGeneral: row.grounding === "general",
                          },
                          (event) => {
                            const data = event as { text?: string };
                            if (typeof data.text === "string")
                              setLive(data.text);
                          },
                        );
                        stop.current = handle.cancel;
                        void handle.result
                          .then((result) => {
                            const reply = result as Awaited<
                              ReturnType<typeof invoke<"chats.regenerate">>
                            >;
                            setSkipped(reply.skippedImages ?? []);
                            setUncovered(
                              reply.covered
                                ? null
                                : (thread.data?.messages
                                    .filter(
                                      (message) => message.role === "user",
                                    )
                                    .at(-1)?.body ?? ""),
                            );
                            void client.invalidateQueries({
                              queryKey: ["chat", chatId],
                            });
                          })
                          .catch((err: unknown) => {
                            const key =
                              err &&
                              typeof err === "object" &&
                              "messageKey" in err
                                ? String(
                                    (err as { messageKey: unknown }).messageKey,
                                  )
                                : "errors.internal";
                            if (key !== "errors.aborted") setError(key);
                          })
                          .finally(() => {
                            stop.current = null;
                            setLive("");
                            setBusy(false);
                          });
                      }
                    : undefined
                }
                suggestions={
                  row.id === lastTutor?.id ? row.followups : undefined
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
                    const params = new URLSearchParams({
                      source: cite.sourceId,
                      passage: cite.passageId,
                    });
                    if (cite.locator.chapter != null) {
                      params.set("chapter", String(cite.locator.chapter));
                    }
                    if (cite.locator.paragraph)
                      params.set("paragraph", cite.locator.paragraph);
                    if (cite.locator.page != null)
                      params.set("page", String(cite.locator.page));
                    if (cite.locator.slide != null)
                      params.set("slide", String(cite.locator.slide));
                    openSourceViewer({
                      passageId: params.get("passage") ?? undefined,
                      sourceId: params.get("source") ?? undefined,
                    });
                  }}
                >
                  {row.body}
                </MarkdownView>
              </ChatMessage>
            ),
          )}
          {busy && live ? (
            <ChatMessage role="tutor">
              <MarkdownView>{live}</MarkdownView>
            </ChatMessage>
          ) : null}
        </div>
      )}
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
      {uncovered ? (
        <Notice tone="warning">
          {t("ask.notCovered")}{" "}
          <button type="button" onClick={() =>
              send(uncovered, { allowGeneral: true, textOnly: true })
            }>
            {t("ask.answerGeneral")}
          </button>
        </Notice>
      ) : null}
      {(plans.data ?? []).length > 0 ? (
        <div className="choice-list" role="group" aria-label={t("ask.plan")}>
          {(plans.data ?? []).map((plan) => (
            <button
              key={plan.id}
              type="button"
              className={planId === plan.id ? "choice is-selected" : "choice"}
              aria-pressed={planId === plan.id}
              onClick={() => setPlanId(planId === plan.id ? null : plan.id)}
            >
              {plan.title}
            </button>
          ))}
        </div>
      ) : null}
      <div className="choice-list" role="group" aria-label={t("ask.sources")}>
        {(sources.data ?? []).map((source) => (
          <button
            key={source.id}
            type="button"
            className={
              picked.includes(source.id) ? "choice is-selected" : "choice"
            }
            aria-pressed={picked.includes(source.id)}
            onClick={() =>
              setPicked((current) =>
                current.includes(source.id)
                  ? current.filter((id) => id !== source.id)
                  : [...current, source.id],
              )
            }
          >
            {source.title}
          </button>
        ))}
      </div>
      <SubjectPicker value={subject} onChange={setSubject} disabled={busy} />
      {thread.data?.context ? (
        <div className="passage">
          <p className="small">{thread.data.context.title}</p>
          <p>{thread.data.context.body}</p>
          <Button
            type="text"
            shape="round"
            onClick={() => {
              if (!chatId) return;
              void invoke("chats.clearContext", { chatId }).then(() => {
                void client.invalidateQueries({ queryKey: ["chat", chatId] });
              });
            }}
          >
            {t("ask.contextRemove")}
          </Button>
        </div>
      ) : null}
      {(thread.data?.held ?? []).map((source) => (
        <Button
          key={source.id}
          shape="round"
          onClick={() => {
            void invoke("sources.promote", { sourceId: source.id }).then(() => {
              void client.invalidateQueries({ queryKey: ["chat", chatId] });
              void client.invalidateQueries({ queryKey: ["sources"] });
            });
          }}
        >
          {t("ask.promote", { title: source.title })}
        </Button>
      ))}
      {files.length > 0 ? (
        <ul className="ask-attachments">
          {files.map((file) => {
            const name = fileName(file);
            return (
              <li key={file}>
                {previews[file] ? (
                  <img
                    alt={t("tools.whiteboardTitle")}
                    src={previews[file]}
                    className="ask-attachment-preview"
                  />
                ) : null}
                <span className="small">{name}</span>
                <Button
                  type="text"
                  shape="round"
                  size="small"
                  disabled={busy}
                  aria-label={t("ask.removeAttachment", {
                    name,
                    defaultValue: "Remove {{name}}",
                  })}
                  onClick={() => {
                    setFiles((current) =>
                      current.filter((item) => item !== file),
                    );
                    setPreviews((current) =>
                      Object.fromEntries(
                        Object.entries(current).filter(([key]) => key !== file),
                      ),
                    );
                  }}
                >
                  {t("ask.contextRemove")}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Composer
        subject={subject || undefined}
        value={draft}
        onValueChange={(next) => {
          setDraft(next);
          sessionStorage.setItem("pyxis-draft", next);
        }}
        mode={mode}
        onModeChange={setMode}
        sources={titles}
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
            .then((picked) => {
              if (picked && picked.length > 0)
                setFiles((current) => [...current, ...picked]);
            });
        }}
      />
    </div>
  );
}
