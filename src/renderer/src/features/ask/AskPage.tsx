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
import { invoke } from "../../lib/ipc";

export function AskPage() {
  const { t } = useTranslation();
  const { chatId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [draft, setDraft] = useState(
    () => sessionStorage.getItem("pyxis-draft") ?? "",
  );
  const [mode, setMode] = useState<"solver" | "socratic">("solver");
  const [picked, setPicked] = useState<string[]>([]);
  const loadedFor = useRef<string | undefined>(undefined);
  const [uncovered, setUncovered] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState("");
  const [subject, setSubject] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    const path = sessionStorage.getItem("pyxis-board-file");
    if (!path) return;
    sessionStorage.removeItem("pyxis-board-file");
    setFiles((current) =>
      current.includes(path) ? current : [...current, path],
    );
  }, []);
  const [error, setError] = useState<string | null>(null);
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
    setSubject("");
    setUncovered(null);
    setHistoryOpen(false);
    loadedFor.current = undefined;
  }, [chatId]);

  useEffect(() => {
    if (!chatId || !thread.data) return;
    if (loadedFor.current === chatId) return;
    loadedFor.current = chatId;
    setPicked(thread.data.sourceIds);
    setSubject(thread.data.subject ?? "");
  }, [chatId, thread.data]);

  async function send(text: string, allowGeneral?: boolean) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    if (chatId && loadedFor.current !== chatId) return;
    setBusy(true);
    setLive("");
    setError(null);
    const handle = window.pyxis.stream(
      "chats.ask",
      {
        chatId,
        text: trimmed,
        sourceIds: picked,
        mode,
        subject,
        files: files.length > 0 ? files : undefined,
        allowGeneral:
          allowGeneral === true || (picked.length === 0 && files.length === 0),
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
      setDraft("");
      setFiles([]);
      sessionStorage.removeItem("pyxis-draft");
      setUncovered(result.covered ? null : trimmed);
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
  const titles = (sources.data ?? [])
    .filter((source) => picked.includes(source.id))
    .map((source) => source.title);

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
            {picked.length === 0 ? t("ask.scopeEmpty") : t("ask.scopeReady")}
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
                              err && typeof err === "object" && "key" in err
                                ? String(err.key)
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
                onSuggest={(text) => send(text)}
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
      {error ? <Notice tone="danger">{t(error)}</Notice> : null}
      {uncovered ? (
        <Notice tone="warning">
          {t("ask.notCovered")}{" "}
          <button type="button" onClick={() => send(uncovered, true)}>
            {t("ask.answerGeneral")}
          </button>
        </Notice>
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
      {sessionStorage.getItem("pyxis-board-png") ? (
        <img
          alt={t("tools.whiteboardTitle")}
          src={sessionStorage.getItem("pyxis-board-png") ?? ""}
          style={{ maxWidth: 280 }}
        />
      ) : null}
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
        <p className="small">
          {files.map((file) => file.split("/").pop()).join(", ")}
        </p>
      ) : null}
      <Composer
        subject={subject || undefined}
        value={draft}
        onValueChange={(next) => {
          setDraft(next);
          sessionStorage.setItem("pyxis-draft", next);
        }}
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
