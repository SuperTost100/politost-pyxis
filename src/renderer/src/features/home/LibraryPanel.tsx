import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";

export function LibraryPanel() {
  const { t } = useTranslation();
  const client = useQueryClient();
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

  const chapters = useQuery({
    queryKey: ["source-chapters", sourceId],
    enabled: sourceId != null,
    queryFn: () => invoke("sources.chapters", { sourceId: sourceId ?? "" }),
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
    document.getElementById("passage-current")?.scrollIntoView({ block: "center" });
  }, [page.data]);

  const add = useMutation({
    mutationFn: async () => {
      const picked = await window.pyxis.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "Smartbook", extensions: ["ptsb"] }],
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
              setChapter(item.number);
              setParagraph(undefined);
            }}
          >
            {item.number}. {item.title}
          </button>
        ))}
      </div>
      <div className="reading-column">
        {(page.data ?? []).map((row) => (
          <p
            key={row.id}
            id={row.current ? "passage-current" : undefined}
            className={row.current ? "passage is-current" : "passage"}
          >
            {row.text}
          </p>
        ))}
      </div>
    </div>
  );
}
