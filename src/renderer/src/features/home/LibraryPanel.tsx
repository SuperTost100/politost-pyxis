import { openSourceViewer } from "../../components/SourceViewer";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";

export function LibraryPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
  const [warning, setWarning] = useState<string | null>(null);
  const [ocrFor, setOcrFor] = useState<string | null>(null);
  const [pickedPassage, setPickedPassage] = useState<string | null>(null);
  const [searchPicked, setSearchPicked] = useState(false);
  const [preferOpened, setPreferOpened] = useState(Boolean(params.get("passage")));
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [folderFiles, setFolderFiles] = useState<
    Array<{ path: string; name: string; duplicate: boolean; selected: boolean }>
  >([]);

  const meta = useQuery({
    queryKey: ["source-meta", sourceId],
    enabled: sourceId != null,
    queryFn: () => invoke("sources.meta", { sourceId: sourceId ?? "" }),
  });
  const chapters = useQuery({
    queryKey: ["source-chapters", sourceId],
    enabled: sourceId != null,
    queryFn: () => invoke("sources.chapters", { sourceId: sourceId ?? "" }),
  });
  const passageId = searchPicked ? pickedPassage : params.get("passage");
  const opened = useQuery({
    queryKey: ["source-passage", passageId],
    enabled: Boolean(passageId),
    queryFn: () => invoke("sources.passage", { passageId: passageId ?? "" }),
  });
  const page = useQuery({
    queryKey: ["source-chapter", sourceId, chapter, paragraph],
    enabled: sourceId != null && (chapter != null || chapters.data?.length === 0),
    queryFn: () =>
      invoke("sources.chapter", {
        sourceId: sourceId ?? "",
        chapter: chapter ?? 0,
        paragraph,
      }),
  });

  useEffect(() => {
    setSearchPicked(false);
    const source = params.get("source");
    const chapterParam = params.get("chapter");
    const paragraphParam = params.get("paragraph");
    if (source) setSourceId(source);
    if (chapterParam) setChapter(Number(chapterParam));
    if (paragraphParam) setParagraph(paragraphParam);
    if (params.get("passage")) setPreferOpened(true);
  }, [params]);

  useEffect(() => {
    if (searchPicked) return;
    const openedSource = opened.data?.[0]?.sourceId;
    if (openedSource) setSourceId(openedSource);
  }, [opened.data, searchPicked]);

  useEffect(() => {
    if (passageId) openSourceViewer({ passageId, sourceId: sourceId ?? undefined });
  }, [page.data, opened.data]);

  const add = useMutation({
    mutationFn: async () => {
      const picked = await window.pyxis.showOpenDialog({
        properties: ["openFile"],
        filters: [
          {
            name: "Fonti",
            extensions: ["ptsb", "pdf", "docx", "pptx", "txt", "md", "png", "jpg", "jpeg", "webp"],
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

  function fail(err: unknown): void {
    const key =
      err && typeof err === "object" && "messageKey" in err
        ? String((err as { messageKey: unknown }).messageKey)
        : "sources.importFailed";
    setError(key);
  }

  async function importPath(path: string): Promise<void> {
    const preview = await invoke("sources.preview", { path });
    const notes = [
      preview.duplicate ? t("sources.duplicate") : "",
      preview.blurry ? t("sources.blurry") : "",
    ].filter(Boolean);
    setWarning(notes.length > 0 ? notes.join(" ") : null);
    const value = await invoke("sources.import", { path });
    void client.invalidateQueries({ queryKey: ["sources"] });
    setSourceId(value.sourceId);
    setChapter(null);
  }

  async function readScan(source: {
    id: string;
    kind: string;
    blobSha: string | null;
  }): Promise<void> {
    if (source.kind === "pdf" && source.blobSha) {
      const { ocrPdfBlob } = await import("./ocrScan");
      await ocrPdfBlob(source.id, source.blobSha);
      return;
    }
    if (source.kind === "image" && source.blobSha) {
      const response = await fetch(`pyxis-blob://${source.blobSha}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      await invoke("sources.ocrImage", {
        sourceId: source.id,
        pngBase64: btoa(binary),
        page: 1,
        last: true,
      });
      return;
    }
    await invoke("sources.ocr", { sourceId: source.id });
  }

  const embedding = useQuery({ queryKey: ["embedding"], queryFn: () => invoke("sources.embedState", {}) });
  const sources = list.data ?? [];
  return (
    <div>
      {sources.length === 0 ? (
        <EmptyState title={t("exams.sourcesEmptyTitle")} body={t("exams.sourcesEmptyBody")} />
      ) : null}
      <div className="gallery-row">
        <Button type="primary" shape="round" onClick={() => add.mutate()}>
          {t("exams.addSources")}
        </Button>
        <Button
          shape="round"
          onClick={() => {
            void window.pyxis
              .showOpenDialog({ properties: ["openDirectory"] })
              .then(async (picked) => {
                const folder = picked?.[0];
                if (!folder) return;
                const files = await invoke("sources.scanFolder", { path: folder });
                setFolderFiles(
                  files.map((file) => ({ ...file, selected: !file.duplicate })),
                );
              })
              .catch(fail);
          }}
        >
          {t("sources.folder")}
        </Button>
      </div>
      {folderFiles.length > 0 ? (
        <div>
          <ul className="choice-list">
            {folderFiles.map((file) => (
              <li key={file.path}>
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={file.selected}
                    onChange={(event) => {
                      const selected = event.target.checked;
                      setFolderFiles((current) =>
                        current.map((item) =>
                          item.path === file.path ? { ...item, selected } : item,
                        ),
                      );
                    }}
                  />
                  <span className="body-strong">{file.name}</span>
                  {file.duplicate ? <span className="small">{t("sources.duplicate")}</span> : null}
                </label>
              </li>
            ))}
          </ul>
          <Button
            shape="round"
            onClick={() => {
              const chosen = folderFiles.filter((file) => file.selected);
              setFolderFiles([]);
              void (async () => {
                for (const file of chosen) await importPath(file.path);
              })().catch(fail);
            }}
          >
            {t("sources.importChosen")}
          </Button>
        </div>
      ) : null}
      <section className="section-hint">
        <p className="body-strong">{t("sources.qualityTitle")}</p>
        <p className="small">{t("sources.qualityBody")}</p>
      </section>
      {warning ? <Notice tone="warning">{warning}</Notice> : null}
      <form
        className="engine-key"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          void invoke("sources.paste", { title: pasteTitle, text: pasteText })
            .then((value) => {
              setPasteText("");
              void client.invalidateQueries({ queryKey: ["sources"] });
              setSourceId(value.sourceId);
            })
            .catch(fail);
        }}
      >
        <Input
          value={pasteTitle}
          aria-label={t("sources.pasteTitle")}
          placeholder={t("sources.pasteTitle")}
          onChange={(event) => setPasteTitle(event.target.value)}
        />
        <Input.TextArea
          value={pasteText}
          aria-label={t("sources.paste")}
          placeholder={t("sources.pasteHint")}
          rows={4}
          onChange={(event) => setPasteText(event.target.value)}
        />
        <Button htmlType="submit" shape="round">
          {t("sources.paste")}
        </Button>
      </form>
      <form
        className="engine-key"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          void invoke("sources.link", { url: linkUrl })
            .then((value) => {
              setLinkUrl("");
              void client.invalidateQueries({ queryKey: ["sources"] });
              setSourceId(value.sourceId);
            })
            .catch(fail);
        }}
      >
        <Input
          value={linkUrl}
          aria-label={t("sources.link")}
          placeholder={t("sources.linkHint")}
          onChange={(event) => setLinkUrl(event.target.value)}
        />
        <Button htmlType="submit" shape="round">
          {t("sources.link")}
        </Button>
      </form>
      <Button
        shape="round"
        disabled={embedding.data?.ready === true}
        onClick={() => {
          void invoke("sources.embed", { consent: true })
            .then(() => setWarning(t("sources.embedQueued")))
            .catch(fail);
        }}
      >
        {t(embedding.data?.ready ? "sources.embedReady" : "sources.embedAsk")}
      </Button>
      {error ? <Notice tone="danger">{t(error)}</Notice> : null}
      {sources
        .filter((source) => source.status === "needs-ocr")
        .map((source) => (
          <Notice key={source.id} tone="warning">
            {t("sources.scanned", { title: source.title })}{" "}
            {ocrFor === source.id ? (
              t("sources.ocrQueued")
            ) : (
              <button
                type="button"
                onClick={() => {
                  setOcrFor(source.id);
                  void readScan(source)
                    .then(() => client.invalidateQueries({ queryKey: ["sources"] }))
                    .catch(fail);
                }}
              >
                {t("sources.offerOcr")}
              </button>
            )}
          </Notice>
        ))}
      <form
        className="engine-key"
        onSubmit={(event) => {
          event.preventDefault();
          void invoke("sources.search", { query }).then(setHits).catch(fail);
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
                  openSourceViewer({ passageId: hit.id, sourceId: hit.sourceId });
                  setSearchPicked(true);
                  setSourceId(hit.sourceId);
                  if (hit.locator.chapter == null) {
                    setPreferOpened(true);
                    setPickedPassage(hit.id);
                    setChapter(null);
                    setParagraph(undefined);
                    return;
                  }
                  setPreferOpened(false);
                  setPickedPassage(null);
                  setChapter(hit.locator.chapter);
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
      {meta.data &&
      (meta.data.authors.length > 0 || meta.data.version || meta.data.specVersion) ? (
        <p className="small section-hint">
          {[
            meta.data.authors.join(", "),
            meta.data.version ? t("sources.version", { version: meta.data.version }) : "",
            meta.data.specVersion ? t("sources.spec", { spec: meta.data.specVersion }) : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      {meta.data && !meta.data.knownSpec ? (
        <Notice tone="warning">{t("sources.specUnknown")}</Notice>
      ) : null}
      <ul className="choice-list">
        {sources.map((source) => (
          <li key={source.id}>
            <button
              type="button"
              aria-label={source.title}
              className={source.id === sourceId ? "choice is-selected" : "choice"}
              onClick={() => {
                setPreferOpened(false);
                setSourceId(source.id);
                setRenameTo(source.title);
                setChapter(null);
                setParagraph(undefined);
              }}
            >
              <span className="body-strong">{source.title}</span>
              <span className="meta">{t(`sources.status.${source.status}`, { defaultValue: source.status })}</span>
            </button>
          </li>
        ))}
      </ul>
      {sourceId ? (
        <form
          className="engine-key"
          onSubmit={(event) => {
            event.preventDefault();
            void invoke("sources.rename", { sourceId, title: renameTo })
              .then(() => client.invalidateQueries({ queryKey: ["sources"] }))
              .catch(fail);
          }}
        >
          <Input
            value={renameTo}
            aria-label={t("sources.rename")}
            onChange={(event) => setRenameTo(event.target.value)}
          />
          <Button htmlType="submit" shape="round">
            {t("sources.rename")}
          </Button>
          <Button
            shape="round"
            onClick={() => {
              void window.pyxis
                .showOpenDialog({
                  properties: ["openFile"],
                  filters: [
                    {
                      name: "Fonti",
                      extensions: ["pdf", "docx", "pptx", "txt", "md"],
                    },
                  ],
                })
                .then(async (picked) => {
                  const path = picked?.[0];
                  if (!path) return;
                  await invoke("sources.replace", { sourceId, path });
                  void client.invalidateQueries({ queryKey: ["sources"] });
                })
                .catch(fail);
            }}
          >
            {t("sources.replace")}
          </Button>
          <Button
            shape="round"
            onClick={() => {
              void invoke("sources.remove", { sourceId, confirmed: false }).then((result) => {
                if (!result.removed && result.inUse) {
                  const again = window.confirm(t("sources.inUse"));
                  if (!again) return;
                  void invoke("sources.remove", { sourceId, confirmed: true }).then(() => {
                    setSourceId(null);
                    void client.invalidateQueries({ queryKey: ["sources"] });
                  });
                  return;
                }
                setSourceId(null);
                void client.invalidateQueries({ queryKey: ["sources"] });
              });
            }}
          >
            {t("sources.remove")}
          </Button>
        </form>
      ) : null}
      <div className="choice-list">
        {(chapters.data ?? []).map((item) => (
          <button
            key={item.number}
            type="button"
            className={item.number === chapter ? "choice is-selected" : "choice"}
            onClick={() => {
              setPreferOpened(false);
              openSourceViewer({ sourceId: sourceId ?? undefined, chapter: item.number });
              setChapter(item.number);
              setParagraph(undefined);
            }}
          >
            {item.number}. {item.title}
          </button>
        ))}
      </div>

    </div>
  );
}
