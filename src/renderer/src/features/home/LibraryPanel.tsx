import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { MarkdownView } from "../../components/MarkdownView";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";

export function LibraryPanel() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const list = useQuery({
    queryKey: ["sources"],
    queryFn: () => invoke("sources.list", {}),
  });
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [chapter, setChapter] = useState<number | null>(null);
  const [paragraph, setParagraph] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<
    Awaited<ReturnType<typeof invoke<"sources.search">>>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [ocrFor, setOcrFor] = useState<string | null>(null);
  const [preferOpened, setPreferOpened] = useState(Boolean(params.get("passage")));

  const chapters = useQuery({
    queryKey: ["source-chapters", sourceId],
    enabled: sourceId != null,
    queryFn: () => invoke("sources.chapters", { sourceId: sourceId ?? "" }),
  });
  const passageId = params.get("passage");
  const opened = useQuery({
    queryKey: ["source-passage", passageId],
    enabled: Boolean(passageId),
    queryFn: () => invoke("sources.passage", { passageId: passageId ?? "" }),
  });
  const page = useQuery({
    queryKey: ["source-chapter", sourceId, chapter, paragraph],
    enabled: sourceId != null && chapter != null,
    queryFn: () =>
      invoke("sources.chapter", {
        sourceId: sourceId ?? "",
        chapter: chapter ?? 0,
        paragraph,
      }),
  });

  useEffect(() => {
    const source = params.get("source");
    const chapterParam = params.get("chapter");
    const paragraphParam = params.get("paragraph");
    if (source) setSourceId(source);
    if (chapterParam) setChapter(Number(chapterParam));
    if (paragraphParam) setParagraph(paragraphParam);
    if (params.get("passage")) setPreferOpened(true);
    const openedSource = opened.data?.[0]?.sourceId;
    if (openedSource) setSourceId(openedSource);
  }, [params, opened.data]);

  useEffect(() => {
    document.getElementById("passage-current")?.scrollIntoView({ block: "center" });
  }, [page.data]);

  const add = useMutation({
    mutationFn: async () => {
      const picked = await window.pyxis.showOpenDialog({
        properties: ["openFile"],
        filters: [
          {
            name: "Fonti",
            extensions: ["ptsb", "pdf", "docx", "pptx", "txt", "md"],
          },
        ],
      });
      const path = picked?.[0];
      if (!path) return null;
      return invoke("sources.import", { path });
    },
    onSuccess: (value) => {
      setError(null);
      if (!value) return;
      void client.invalidateQueries({ queryKey: ["sources"] });
      setSourceId(value.sourceId);
      setChapter(null);
    },
    onError: (err: unknown) => {
      const key =
        err && typeof err === "object" && "messageKey" in err
          ? String((err as { messageKey: unknown }).messageKey)
          : "sources.importFailed";
      setError(key);
    },
  });

  const sources = list.data ?? [];
  if (sources.length === 0 && !sourceId) {
    return (
      <div>
        <EmptyState
          title={t("exams.sourcesEmptyTitle")}
          body={t("exams.sourcesEmptyBody")}
          action={
            <Button
              type="primary"
              shape="round"
              size="large"
              onClick={() => add.mutate()}
            >
              {t("exams.addSources")}
            </Button>
          }
        />
        {error ? <Notice tone="danger">{t(error)}</Notice> : null}
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-row">
        <Button type="primary" shape="round" onClick={() => add.mutate()}>
          {t("exams.addSources")}
        </Button>
      </div>
      {error ? <Notice tone="danger">{t(error)}</Notice> : null}
      {sources
        .filter((source) => source.status === "needs-ocr")
        .map((source) => (
          <Notice key={source.id} tone="warning">
            {t("sources.scanned", { title: source.title })}{" "}
            {ocrFor === source.id ? (
              t("sources.ocrQueued")
            ) : (
              <button type="button" onClick={() => setOcrFor(source.id)}>
                {t("sources.offerOcr")}
              </button>
            )}
          </Notice>
        ))}
      <form
        className="engine-key"
        onSubmit={(event) => {
          event.preventDefault();
          void invoke("sources.search", { query }).then(setHits);
        }}
      >
        <input
          value={query}
          aria-label={t("sources.search")}
          placeholder={t("sources.search")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit">{t("sources.searchGo")}</button>
      </form>
      {hits.length > 0 ? (
        <ul className="choice-list">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                className="choice"
                onClick={() => {
                  setPreferOpened(false);
                  setSourceId(hit.sourceId);
                  setChapter(hit.locator.chapter ?? null);
                  setParagraph(hit.locator.paragraph);
                }}
              >
                <span className="body-strong">{hit.sectionPath}</span>
                <span className="small">{hit.text.slice(0, 140)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="choice-list">
        {sources.map((source) => (
          <li key={source.id}>
            <button
              type="button"
              className={source.id === sourceId ? "choice is-selected" : "choice"}
              onClick={() => {
                setPreferOpened(false);
                setSourceId(source.id);
                setChapter(null);
                setParagraph(undefined);
              }}
            >
              <span className="body-strong">{source.title}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="choice-list">
        {(chapters.data ?? []).map((item) => (
          <button
            key={item.number}
            type="button"
            className={item.number === chapter ? "choice is-selected" : "choice"}
            onClick={() => {
              setPreferOpened(false);
              setChapter(item.number);
              setParagraph(undefined);
            }}
          >
            {item.number}. {item.title}
          </button>
        ))}
      </div>
      <div className="reading-column">
        {((preferOpened ? opened.data : null) ?? page.data ?? []).map((row) => (
          <div
            key={row.id}
            id={row.current ? "passage-current" : undefined}
            className={row.current ? "passage is-current" : "passage"}
          >
            <MarkdownView>{row.text}</MarkdownView>
          </div>
        ))}
      </div>
    </div>
  );
}
