import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"solver" | "socratic">("solver");
  const [picked, setPicked] = useState<string[]>([]);
  const loadedFor = useRef<string | undefined>(undefined);
  const [uncovered, setUncovered] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);

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
    if (!chatId || !thread.data) return;
    if (loadedFor.current === chatId) return;
    loadedFor.current = chatId;
    setPicked(thread.data.sourceIds);
  }, [chatId, thread.data]);

  async function send(text: string, allowGeneral?: boolean) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    if (chatId && loadedFor.current !== chatId) return;
    setBusy(true);
    setError(null);
    const handle = window.pyxis.stream(
      "chats.ask",
      {
        chatId,
        text: trimmed,
        sourceIds: picked,
        mode,
        allowGeneral: allowGeneral === true || picked.length === 0,
      },
      () => undefined,
    );
    stop.current = handle.cancel;
    try {
      const result = (await handle.result) as Awaited<
        ReturnType<typeof invoke<"chats.ask">>
      >;
      if (!result) return;
      setDraft("");
      setUncovered(result.covered ? null : trimmed);
      void client.invalidateQueries({ queryKey: ["chat", result.chatId] });
      if (result.chatId !== chatId) navigate(`/ask/${result.chatId}`);
    } catch (err) {
      const key =
        err && typeof err === "object" && "messageKey" in err
          ? String((err as { messageKey: unknown }).messageKey)
          : "errors.internal";
      if (key !== "errors.aborted") setError(key);
    } finally {
      stop.current = null;
      setBusy(false);
    }
  }

  const messages = thread.data?.messages ?? [];
  const lastTutor = [...messages].reverse().find((row) => row.role === "assistant");
  const titles = (sources.data ?? [])
    .filter((source) => picked.includes(source.id))
    .map((source) => source.title);

  return (
    <div className="ask-home">
      {messages.length === 0 ? (
        <div className="ask-greeting">
          <h1 className="display">{t("ask.greeting")}</h1>
          <p className="body">
            {picked.length === 0 ? t("ask.scopeEmpty") : t("ask.scopeReady")}
          </p>
        </div>
      ) : (
        <div className="reading-column">
          {messages.map((row) =>
            row.role === "user" ? (
              <ChatMessage key={row.id} role="user">
                {row.body}
              </ChatMessage>
            ) : (
              <ChatMessage
                key={row.id}
                engine={row.modelId ?? undefined}
                general={row.grounding === "general"}
                suggestions={row.id === lastTutor?.id ? row.followups : undefined}
                onSuggest={(text) => send(text)}
              >
                <MarkdownView
                  citationResolver={(index) =>
                    row.citations.find((cite) => cite.index === index)?.label
                  }
                  onCitationClick={(index) => {
                    const cite = row.citations.find((item) => item.index === index);
                    if (!cite) return;
                    const params = new URLSearchParams({
                      source: cite.sourceId,
                      passage: cite.passageId,
                    });
                    if (cite.locator.chapter != null) {
                      params.set("chapter", String(cite.locator.chapter));
                    }
                    if (cite.locator.paragraph) params.set("paragraph", cite.locator.paragraph);
                    if (cite.locator.page != null) params.set("page", String(cite.locator.page));
                    if (cite.locator.slide != null) params.set("slide", String(cite.locator.slide));
                    navigate(`/exams/library?${params.toString()}`);
                  }}
                >
                  {row.body}
                </MarkdownView>
              </ChatMessage>
            ),
          )}
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
      <div className="choice-list" aria-label={t("ask.sources")}>
        {(sources.data ?? []).map((source) => (
          <button
            key={source.id}
            type="button"
            className={picked.includes(source.id) ? "choice is-selected" : "choice"}
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
      <Composer
        value={draft}
        onValueChange={setDraft}
        onModeChange={setMode}
        sources={titles}
        streaming={busy}
        onStop={() => stop.current?.()}
        onSend={() => void send(draft)}
      />
    </div>
  );
}
