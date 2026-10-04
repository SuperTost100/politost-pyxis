import { openSourceViewer } from "../../components/SourceViewer";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Modal, Select, Dropdown, Drawer } from "antd";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import {
  BookMarked,
  FileText,
  MoreHorizontal,
  CheckCircle2,
  AlertCircle,
  LoaderCircle,
} from "lucide-react";
import { SegmentedTabs } from "../../components/SegmentedTabs";
import "./LibraryPanel.css";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";

export function LibraryPanel({
  importOnly = false,
  onClose,
}: { importOnly?: boolean; onClose?: () => void } = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const list = useQuery({
    queryKey: ["sources"],
    queryFn: () => invoke("sources.list", {}),
  });
  const [addOpen, setAddOpen] = useState(importOnly);
  const [addTab, setAddTab] = useState("file");
  const [filterText, setFilterText] = useState("");
  const [filterType, setFilterType] = useState("all");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(() => {
    try {
      return localStorage.getItem("pyxis-source-quality") !== "closed";
    } catch {
      return true;
    }
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
  const [preferOpened, setPreferOpened] = useState(
    Boolean(params.get("passage")),
  );
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
    enabled:
      sourceId != null && (chapter != null || chapters.data?.length === 0),
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
    if (passageId)
      openSourceViewer({ passageId, sourceId: sourceId ?? undefined });
  }, [page.data, opened.data]);

  const add = useMutation({
    mutationFn: async () => {
      const picked = await window.pyxis.showOpenDialog({
        properties: ["openFile"],
        filters: [
          {
            name: "Fonti",
            extensions: [
              "ptsb",
              "pdf",
              "docx",
              "pptx",
              "txt",
              "md",
              "png",
              "jpg",
              "jpeg",
              "webp",
            ],
          },
        ],
      });
      const path = picked?.[0];
      if (!path) return null;
      const preview = await invoke("sources.preview", { path });
      const notes = [
        preview.duplicate ? t("sources.duplicate") : "",
        preview.blurry ? t("sources.blurry") : "",
      ].filter(Boolean);
      setWarning(notes.length ? notes.join(" ") : null);
      return invoke("sources.import", { path });
    },
    onSuccess: (value) => {
      setError(null);
      if (!value) return;
      void client.invalidateQueries({ queryKey: ["sources"] });
      setSourceId(value.sourceId);
      setChapter(null);
      closeAdd();
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

  const linkPreview = useMutation({
    mutationFn: async () => {
      const url = linkUrl.trim();
      const preview = await invoke("sources.linkPreview", { url });
      return { ...preview, url };
    },
    onSuccess: () => setError(null),
    onError: fail,
  });
  const linkPreviewMatches = linkPreview.data?.url === linkUrl.trim();
  const linkSave = useMutation({
    mutationFn: (url: string) => invoke("sources.link", { url }),
    onSuccess: (value) => {
      setLinkUrl("");
      void client.invalidateQueries({ queryKey: ["sources"] });
      setSourceId(value.sourceId);
      linkPreview.reset();
      closeAdd();
    },
    onError: fail,
  });

  const embedding = useQuery({
    queryKey: ["embedding"],
    queryFn: () => invoke("sources.embedState", {}),
  });
  const sources = list.data ?? [];
  type SourceRow = (typeof sources)[number];
  function select(source: SourceRow) {
    setPreferOpened(false);
    setSourceId(source.id);
    setRenameTo(source.title);
    setChapter(null);
    setParagraph(undefined);
  }
  async function replace(source: SourceRow) {
    const picked = await window.pyxis.showOpenDialog({
      properties: ["openFile"],
      filters: [
        {
          name: t("exams.addSources"),
          extensions: [
            "ptsb",
            "pdf",
            "docx",
            "pptx",
            "txt",
            "md",
            "png",
            "jpg",
            "jpeg",
            "webp",
          ],
        },
      ],
    });
    if (!picked?.[0]) return;
    await invoke("sources.replace", { sourceId: source.id, path: picked[0] });
    void client.invalidateQueries({ queryKey: ["sources"] });
  }
  async function remove(source: SourceRow) {
    const result = await invoke("sources.remove", {
      sourceId: source.id,
      confirmed: false,
    });
    if (!result.removed && result.inUse) {
      if (!window.confirm(t("sources.inUse"))) return;
      await invoke("sources.remove", { sourceId: source.id, confirmed: true });
    }
    if (sourceId === source.id) setSourceId(null);
    void client.invalidateQueries({ queryKey: ["sources"] });
  }
  const columns: ProColumns<SourceRow>[] = [
    {
      title: t("sources.nameColumn"),
      dataIndex: "title",
      width: 230,
      fixed: "left",
      render: (_, source) => (
        <Button
          type="text"
          className="px-library-name"
          aria-label={source.title}
          onClick={() => {
            select(source);
            setDetailsOpen(true);
          }}
          icon={
            source.kind === "smartbook" ? (
              <BookMarked size={18} />
            ) : (
              <FileText size={18} />
            )
          }
        >
          {source.title}
        </Button>
      ),
    },
    {
      title: t("sources.typeColumn"),
      dataIndex: "kind",
      width: 70,
      render: (_, source) => (
        <span className="meta">
          {t(`sources.kind.${source.kind}`, { defaultValue: source.kind })}
        </span>
      ),
    },
    {
      title: t("sources.sizeColumn"),
      dataIndex: "bytes",
      width: 80,
      render: (_, source) => (
        <span className="meta">
          {source.bytes == null
            ? "—"
            : new Intl.NumberFormat(undefined, {
                maximumFractionDigits: 1,
              }).format(source.bytes / 1024) + " KB"}
        </span>
      ),
    },
    { title: t("sources.sectionsColumn"), dataIndex: "sections", width: 70 },
    {
      title: t("sources.statusColumn"),
      dataIndex: "status",
      width: 120,
      render: (_, source) => (
        <span className="px-library-status">
          {source.status === "ready" ? (
            <CheckCircle2 size={16} />
          ) : ["failed", "needs-ocr", "interrupted", "cancelled"].includes(
              source.status,
            ) ? (
            <AlertCircle size={16} />
          ) : (
            <LoaderCircle size={16} />
          )}
          <span className="small">
            {t(`sources.status.${source.status}`, {
              defaultValue: source.status,
            })}
          </span>
        </span>
      ),
    },
    { title: t("sources.plansColumn"), dataIndex: "planCount", width: 65 },
    {
      title: t("sources.actionsColumn"),
      valueType: "option",
      width: 65,
      render: (_, source) => (
        <Dropdown
          popupRender={(menu) => (
            <div role="region" aria-label={t("sources.actionsColumn")}>
              {menu}
            </div>
          )}
          trigger={["click"]}
          menu={{
            items: [
              { key: "details", label: t("sources.details") },
              { key: "rename", label: t("sources.rename") },
              { key: "replace", label: t("sources.replace") },
              { key: "remove", label: t("sources.remove"), danger: true },
            ],
            onClick: ({ key }) => {
              select(source);
              if (key === "replace") void replace(source).catch(fail);
              else if (key === "remove") void remove(source).catch(fail);
              else setDetailsOpen(true);
            },
          }}
        >
          <Button
            type="text"
            aria-label={t("sources.actionsFor", { title: source.title })}
            icon={<MoreHorizontal size={18} />}
          />
        </Dropdown>
      ),
    },
  ];
  function closeAdd() {
    setAddOpen(false);
    onClose?.();
  }
  const addModal = (
    <Modal
      open={addOpen}
      width={640}
      title={t("exams.addSources")}
      footer={null}
      onCancel={closeAdd}
      className="px-library-add"
    >
      <details
        className="px-library-quality"
        open={qualityOpen}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setQualityOpen(open);
          try {
            localStorage.setItem(
              "pyxis-source-quality",
              open ? "open" : "closed",
            );
          } catch {
            /* The in-memory choice still works. */
          }
        }}
      >
        <summary className="body-strong">{t("sources.qualityTitle")}</summary>
        <p className="small ink-muted">{t("sources.qualityBody")}</p>
      </details>
      <SegmentedTabs
        label={t("sources.addMethod")}
        value={addTab}
        onChange={setAddTab}
        items={[
          { value: "file", label: t("sources.fileTab") },
          { value: "folder", label: t("sources.folderTab") },
          { value: "link", label: t("sources.linkTab") },
          { value: "text", label: t("sources.textTab") },
        ]}
      />
      {warning ? <Notice tone="warning">{warning}</Notice> : null}
      {error ? <Notice tone="danger">{t(error)}</Notice> : null}
      {addTab === "file" ? (
        <div className="px-library-upload">
          <FileText size={28} />
          <p className="body">{t("sources.fileHint")}</p>
          <Button
            type="primary"
            shape="round"
            loading={add.isPending}
            onClick={() => add.mutate()}
          >
            {t("sources.chooseFiles")}
          </Button>
          <p className="small ink-muted">
            PDF, PTSB, DOCX, PPTX, TXT, Markdown, PNG, JPEG, WebP
          </p>
        </div>
      ) : null}
      {addTab === "folder" ? (
        <div className="px-library-import-pane">
          <Button
            shape="round"
            onClick={() => {
              void window.pyxis
                .showOpenDialog({ properties: ["openDirectory"] })
                .then(async (picked) => {
                  if (!picked?.[0]) return;
                  const files = await invoke("sources.scanFolder", {
                    path: picked[0],
                  });
                  setFolderFiles(
                    files.map((file) => ({
                      ...file,
                      selected: !file.duplicate,
                    })),
                  );
                })
                .catch(fail);
            }}
          >
            {t("sources.folder")}
          </Button>
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
                          item.path === file.path
                            ? { ...item, selected }
                            : item,
                        ),
                      );
                    }}
                  />
                  <span>{file.name}</span>
                  {file.duplicate ? (
                    <span className="small">{t("sources.duplicate")}</span>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
          {folderFiles.length ? (
            <Button
              type="primary"
              disabled={!folderFiles.some((file) => file.selected)}
              onClick={() => {
                const chosen = folderFiles.filter((file) => file.selected);
                void (async () => {
                  for (const file of chosen) await importPath(file.path);
                  setFolderFiles([]);
                })().catch(fail);
              }}
            >
              {t("sources.importChosen")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {addTab === "link" ? (
        <form
          className="px-library-import-pane"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            if (!linkPreviewMatches) {
              linkPreview.mutate();
              return;
            }
            if (!linkSave.isPending) linkSave.mutate(linkUrl.trim());
          }}
        >
          <label className="label" htmlFor="source-link">
            {t("sources.link")}
          </label>
          <Input
            id="source-link"
            type="url"
            value={linkUrl}
            disabled={linkSave.isPending}
            onChange={(event) => setLinkUrl(event.target.value)}
          />
          <p className="small ink-muted">{t("sources.linkHint")}</p>
          <div className="px-library-import-actions">
            <Button
              htmlType="button"
              loading={linkPreview.isPending}
              disabled={!linkUrl.trim() || linkSave.isPending}
              onClick={() => linkPreview.mutate()}
            >
              {t("sources.previewLink")}
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={linkSave.isPending}
              disabled={!linkPreviewMatches || linkPreview.isPending}
            >
              {t("sources.saveLink")}
            </Button>
          </div>
          {linkPreviewMatches && linkPreview.data ? (
            <section
              className="px-library-link-preview"
              aria-label={t("sources.linkPreview")}
            >
              <h3 className="body-strong">{linkPreview.data.title}</h3>
              <p className="small ink-muted">
                {linkPreview.data.kind === "pdf" ? "PDF" : t("sources.webPage")}
                {linkPreview.data.bytes == null
                  ? ""
                  : ` · ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(linkPreview.data.bytes / 1024)} KB`}
              </p>
              <p className="body">
                {linkPreview.data.excerpt || t("sources.pdfPreviewHint")}
              </p>
            </section>
          ) : null}
        </form>
      ) : null}
      {addTab === "text" ? (
        <form
          className="px-library-import-pane"
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
          <label className="label" htmlFor="source-paste-title">
            {t("sources.pasteTitle")}
          </label>
          <Input
            id="source-paste-title"
            value={pasteTitle}
            onChange={(event) => setPasteTitle(event.target.value)}
          />
          <label className="label" htmlFor="source-paste-text">
            {t("sources.paste")}
          </label>
          <Input.TextArea
            id="source-paste-text"
            rows={7}
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
          />
          <p className="small ink-muted" role="status">
            {t("sources.textCount", { count: pasteText.length })} ·{" "}
            {t("sources.pasteHint")}
          </p>
          <Button
            type="primary"
            htmlType="submit"
            disabled={pasteText.length < 1500 || !pasteTitle.trim()}
          >
            {t("sources.paste")}
          </Button>
        </form>
      ) : null}
    </Modal>
  );
  if (importOnly) return addModal;
  return (
    <div className="px-library">
      {addModal}
      {sources.length === 0 ? (
        <EmptyState
          title={t("exams.sourcesEmptyTitle")}
          body={t("exams.sourcesEmptyBody")}
        />
      ) : null}
      <div className="px-library-toolbar">
        <Input
          allowClear
          value={filterText}
          aria-label={t("sources.filterTitle")}
          placeholder={t("sources.filterTitle")}
          onChange={(event) => setFilterText(event.target.value)}
        />
        <Select
          value={filterType}
          aria-label={t("sources.typeColumn")}
          onChange={setFilterType}
          options={[
            { value: "all", label: t("sources.allTypes") },
            ...Array.from(new Set(sources.map((source) => source.kind))).map(
              (kind) => ({
                value: kind,
                label: t(`sources.kind.${kind}`, { defaultValue: kind }),
              }),
            ),
          ]}
        />
        <Button type="primary" shape="round" onClick={() => setAddOpen(true)}>
          {t("exams.addSources")}
        </Button>
      </div>
      <ProTable<SourceRow>
        rowKey="id"
        columns={columns}
        dataSource={sources.filter(
          (source) =>
            (filterType === "all" || source.kind === filterType) &&
            source.title
              .toLocaleLowerCase()
              .includes(filterText.trim().toLocaleLowerCase()),
        )}
        loading={list.isPending}
        search={false}
        options={false}
        pagination={false}
        scroll={{ x: 700 }}
        rowClassName={(source) =>
          source.id === sourceId ? "px-library-selected" : ""
        }
      />
      <h2 className="title-3 px-library-search-title">
        {t("sources.searchPassages")}
      </h2>
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
                    .then(() =>
                      client.invalidateQueries({ queryKey: ["sources"] }),
                    )
                    .catch(fail);
                }}
              >
                {t("sources.offerOcr")}
              </button>
            )}
          </Notice>
        ))}
      <form
        className="px-form-inline"
        onSubmit={(event) => {
          event.preventDefault();
          void invoke("sources.search", { query }).then(setHits).catch(fail);
        }}
      >
        <Input
          value={query}
          aria-label={t("sources.search")}
          placeholder={t("sources.search")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button htmlType="submit" shape="round">
          {t("sources.searchGo")}
        </Button>
      </form>
      {hits.length > 0 ? (
        <ul className="choice-list">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                className="choice"
                onClick={() => {
                  openSourceViewer({
                    passageId: hit.id,
                    sourceId: hit.sourceId,
                  });
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
      <Drawer
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title={
          sources.find((source) => source.id === sourceId)?.title ??
          t("sources.details")
        }
        width={520}
        className="px-library-details"
      >
        <Button
          shape="round"
          disabled={!sourceId}
          onClick={() => {
            setDetailsOpen(false);
            openSourceViewer({ sourceId: sourceId ?? undefined });
          }}
        >
          {t("components.citation.open")}
        </Button>
        {meta.data &&
        (meta.data.authors.length > 0 ||
          meta.data.version ||
          meta.data.specVersion) ? (
          <p className="small section-hint">
            {[
              meta.data.authors.join(", "),
              meta.data.version
                ? t("sources.version", { version: meta.data.version })
                : "",
              meta.data.specVersion
                ? t("sources.spec", { spec: meta.data.specVersion })
                : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
        {meta.data && !meta.data.knownSpec ? (
          <Notice tone="warning">{t("sources.specUnknown")}</Notice>
        ) : null}
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
              danger
              onClick={() => {
                void invoke("sources.remove", {
                  sourceId,
                  confirmed: false,
                }).then((result) => {
                  if (!result.removed && result.inUse) {
                    const again = window.confirm(t("sources.inUse"));
                    if (!again) return;
                    void invoke("sources.remove", {
                      sourceId,
                      confirmed: true,
                    }).then(() => {
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
              className={
                item.number === chapter ? "choice is-selected" : "choice"
              }
              onClick={() => {
                setPreferOpened(false);
                openSourceViewer({
                  sourceId: sourceId ?? undefined,
                  chapter: item.number,
                });
                setChapter(item.number);
                setParagraph(undefined);
              }}
            >
              {item.number}. {item.title}
            </button>
          ))}
        </div>
      </Drawer>
    </div>
  );
}
