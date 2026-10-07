import { openSourceViewer } from "../../components/SourceViewer";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Modal, Progress, Select, Dropdown, Drawer } from "antd";
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
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { Notice } from "../../components/Notice";
import { OcrDataCard } from "../../components/OcrData";
import { isOcrRefusal } from "../../components/ocrErrors";
import { invoke } from "../../lib/ipc";
import {
  MAX_FOLDER_DEPTH,
  REPLACE_EXTENSIONS,
  SOURCE_EXTENSIONS,
} from "@shared/source-types";

const messageKeyOf = (err: unknown): string =>
  err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "sources.importFailed";

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The folder a file sits in, so two files with one name can be told apart in a checklist. */
const parentName = (path: string) => path.split(/[\\/]/).slice(-2, -1)[0] ?? "";

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`
    : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;

/** What an import run did, kept on screen until the student closes it or starts another run. */
type ImportResult = {
  /** Files that became new sources. A file already in the library is not counted: its source is reused. */
  imported: number;
  notes: Array<{ name: string; text: string }>;
  failed: Array<{ name: string; key: string }>;
  skipped: number;
};

export function LibraryPanel({
  importOnly = false,
  onClose,
  onImported,
}: {
  importOnly?: boolean;
  onClose?: () => void;
  /** Called with the ids of the sources an import just created, so a caller can use them right away. */
  onImported?: (sourceIds: string[]) => void;
} = {}) {
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
  // The action local OCR data refused, kept so the student can run it again once the data is ready.
  const [again, setAgain] = useState<{ label: string; run: () => void } | null>(
    null,
  );
  const [warning, setWarning] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // The scan being read page by page, and whether the student has asked it to stop.
  const [ocrFor, setOcrFor] = useState<{
    id: string;
    stopping: boolean;
  } | null>(null);
  const scanRun = useRef<AbortController | null>(null);
  // Leaving the Library stops the scan between pages. The pages already read are kept.
  useEffect(() => () => scanRun.current?.abort(), []);
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
  // The folder a scan has read, so an empty answer can say so instead of showing nothing.
  const [folderScanned, setFolderScanned] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    name: string;
  } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  // A folder scan stops at a file count and a depth. The student is told when it did.
  const [folderCut, setFolderCut] = useState<{
    files: boolean;
    depth: boolean;
    limit: number;
  } | null>(null);

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
  const detailSource = (list.data ?? []).find(
    (source) => source.id === sourceId,
  );
  // SRC-08: which sections of this source sit off the syllabus of the plans that use it. Local vectors only.
  const syllabus = useQuery({
    queryKey: [
      "source-syllabus",
      sourceId,
      detailSource?.status,
      detailSource?.sections,
    ],
    enabled:
      detailsOpen &&
      detailSource != null &&
      detailSource.planCount > 0 &&
      detailSource.status === "ready",
    queryFn: () => invoke("sources.syllabus", { sourceId: sourceId ?? "" }),
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

  const [dragging, setDragging] = useState(false);
  // One path for the picker, a drop and a folder. A drop gets its grant from main before core sees a path.
  const add = useMutation({
    mutationFn: async (input: { dropped?: File[]; paths?: string[] }) => {
      setWarning(null);
      setError(null);
      setAgain(null);
      setResult(null);
      let paths: string[];
      let skipped = 0;
      if (input.dropped) {
        const granted = await window.pyxis.grantDroppedFiles(input.dropped);
        paths = granted.paths;
        skipped = granted.skipped;
      } else if (input.paths) {
        paths = input.paths;
      } else {
        paths =
          (await window.pyxis.showOpenDialog({
            properties: ["openFile", "multiSelections"],
            filters: [
              { name: t("exams.sources"), extensions: [...SOURCE_EXTENSIONS] },
            ],
          })) ?? [];
      }
      if (!paths.length && skipped) throw { messageKey: "sources.dropSkipped" };
      if (!paths.length) return null;
      const outcome: ImportResult & { ids: string[]; done: string[] } = {
        imported: 0,
        notes: [],
        failed: [],
        skipped,
        ids: [],
        done: [],
      };
      let firstError: unknown;
      try {
        for (const [index, path] of paths.entries()) {
          setProgress({ done: index, total: paths.length, name: fileName(path) });
          try {
            const preview = await invoke("sources.preview", { path });
            if (preview.blurry)
              outcome.notes.push({
                name: fileName(path),
                text: t("sources.blurry"),
              });
            if (preview.existingSourceId) {
              // The same bytes are already in the library. That source is used, no second copy is made.
              outcome.notes.push({
                name: fileName(path),
                text: t("sources.reused"),
              });
              outcome.ids.push(preview.existingSourceId);
            } else {
              const value = await invoke("sources.import", { path });
              outcome.ids.push(value.sourceId);
              outcome.imported += 1;
            }
            outcome.done.push(path);
          } catch (err) {
            // The files from the refused one on stay chosen, so nothing has to be picked or dropped again.
            if (isOcrRefusal(messageKeyOf(err))) {
              const rest = paths.slice(index);
              setAgain({
                label: t("sources.ocrData.again.import", { count: rest.length }),
                run: () => add.mutate({ paths: rest }),
              });
              throw err;
            }
            // One unreadable file does not stop the others. It is listed in the result.
            firstError ??= err;
            outcome.failed.push({
              name: fileName(path),
              key: messageKeyOf(err),
            });
          }
        }
      } finally {
        setProgress(null);
        // Files already in stay out of the checklist, whether the run finished or stopped on a refusal.
        const imported = new Set(outcome.done);
        if (imported.size)
          setFolderFiles((current) =>
            current.filter((file) => !imported.has(file.path)),
          );
        if (outcome.ids.length) {
          void client.invalidateQueries({ queryKey: ["sources"] });
          onImported?.([...new Set(outcome.ids)]);
        }
      }
      // Nothing came in and something failed: the error shows as a notice, with its own recovery.
      if (!outcome.ids.length && firstError) throw firstError;
      return outcome;
    },
    onSuccess: (value) => {
      if (!value) return;
      const last = value.ids[value.ids.length - 1];
      if (last) setSourceId(last);
      setChapter(null);
      // A single clean import has nothing more to say. Anything else stays on screen, closing would hide it.
      if (value.imported === 1 && !value.notes.length && !value.failed.length && !value.skipped)
        closeAdd();
      else setResult(value);
    },
    onError: (err: unknown) => setError(messageKeyOf(err)),
  });

  function fail(
    err: unknown,
    retry?: { label: string; run: () => void },
  ): void {
    setError(messageKeyOf(err));
    setAgain(retry ?? null);
  }

  /** Reads a picked folder and lists what it holds. An empty folder is said out loud, and a failure shows as a notice. */
  async function pickFolder(): Promise<void> {
    setError(null);
    setAgain(null);
    setResult(null);
    setScanning(true);
    try {
      const picked = await window.pyxis.showOpenDialog({
        properties: ["openDirectory"],
      });
      const folder = picked?.[0];
      if (!folder) return;
      const scan = await invoke("sources.scanFolder", { path: folder });
      setFolderCut(
        scan.cappedFiles || scan.cappedDepth
          ? {
              files: scan.cappedFiles,
              depth: scan.cappedDepth,
              limit: scan.limit,
            }
          : null,
      );
      setFolderScanned(fileName(folder));
      setFolderFiles(
        // A file already in the library is ticked too: adding it uses the source that is there.
        scan.files.map((file) => ({ ...file, selected: true })),
      );
    } catch (err) {
      fail(err);
    } finally {
      setScanning(false);
    }
  }

  async function readScan(
    source: { id: string; kind: string; blobSha: string | null },
    signal: AbortSignal,
  ): Promise<void> {
    if (source.kind === "pdf" && source.blobSha) {
      const { ocrPdfBlob } = await import("./ocrScan");
      await ocrPdfBlob(source.id, source.blobSha, signal);
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

  /** Reads a scan with local OCR. A refusal for missing data leaves the scan listed, with a way to run this again. */
  function scan(source: {
    id: string;
    kind: string;
    blobSha: string | null;
  }): void {
    // One scan at a time, and a new one only after the last has fully stopped, so a late stop cannot cut it short.
    if (scanRun.current) return;
    setError(null);
    setAgain(null);
    const run = new AbortController();
    scanRun.current = run;
    setOcrFor({ id: source.id, stopping: false });
    void (async () => {
      try {
        await readScan(source, run.signal);
      } catch (err) {
        // A stop the student asked for is not an error.
        if (!run.signal.aborted)
          fail(err, { label: t("sources.offerOcr"), run: () => scan(source) });
      } finally {
        // The list is read again before the marker goes, so the row never shows a stale state in between.
        await client
          .invalidateQueries({ queryKey: ["sources"] })
          .catch(() => undefined);
        scanRun.current = null;
        setOcrFor(null);
      }
    })();
  }

  function cancelScan(): void {
    scanRun.current?.abort();
    setOcrFor((current) => (current ? { ...current, stopping: true } : null));
  }

  const linkPreview = useMutation({
    mutationFn: async () => {
      const url = linkUrl.trim();
      const preview = await invoke("sources.linkPreview", { url });
      return { ...preview, url };
    },
    onSuccess: () => setError(null),
    onError: (err: unknown) => fail(err),
  });
  const linkPreviewMatches = linkPreview.data?.url === linkUrl.trim();
  const linkSave = useMutation({
    mutationFn: (url: string) => invoke("sources.link", { url }),
    onSuccess: (value) => {
      setLinkUrl("");
      void client.invalidateQueries({ queryKey: ["sources"] });
      setSourceId(value.sourceId);
      onImported?.([value.sourceId]);
      linkPreview.reset();
      closeAdd();
    },
    onError: (err: unknown) => fail(err),
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
  async function replace(sourceId: string, chosen?: string) {
    setError(null);
    setAgain(null);
    let path = chosen;
    if (!path) {
      const used = sources.find((item) => item.id === sourceId)?.planCount ?? 0;
      // Items made from the old file keep their citations but go out of date, so a source that plans use asks first.
      if (
        used > 0 &&
        !window.confirm(t("sources.replaceInUse", { count: used }))
      )
        return;
      const picked = await window.pyxis.showOpenDialog({
        properties: ["openFile"],
        filters: [
          { name: t("exams.sources"), extensions: [...REPLACE_EXTENSIONS] },
        ],
      });
      path = picked?.[0];
      if (!path) return;
    }
    const file = path;
    try {
      await invoke("sources.replace", { sourceId, path: file });
    } catch (err) {
      if (!isOcrRefusal(messageKeyOf(err))) throw err;
      // The chosen file is kept, so the student is not asked to pick it again.
      return fail(err, {
        label: t("sources.ocrData.again.replace"),
        run: () => void replace(sourceId, file).catch(fail),
      });
    }
    void client.invalidateQueries({ queryKey: ["sources"] });
  }
  /** SRC-12: read the stored file again as a new version. A source that plans use asks first, as removal does. */
  async function reextract(source: SourceRow, confirmed = false) {
    setInfo(null);
    setError(null);
    setAgain(null);
    let result;
    try {
      result = await invoke("sources.reextract", {
        sourceId: source.id,
        confirmed,
      });
    } catch (err) {
      if (!isOcrRefusal(messageKeyOf(err))) throw err;
      return fail(err, {
        label: t("sources.ocrData.again.reextract"),
        run: () => void reextract(source, confirmed).catch(fail),
      });
    }
    if (!result.started && result.inUse > 0) {
      if (!window.confirm(t("sources.reextractInUse", { count: result.inUse })))
        return;
      return reextract(source, true);
    }
    if (result.started)
      setInfo(t("sources.reextractStarted", { title: source.title }));
    void client.invalidateQueries({ queryKey: ["sources"] });
  }
  async function remove(source: SourceRow) {
    if (!window.confirm(`${t("sources.remove")} "${source.title}"?`)) return;
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
        <>
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
          {source.syllabusOff ? (
            <p className="small px-library-flag">
              {t("sources.offSyllabusListed", { count: source.syllabusOff })}
            </p>
          ) : null}
        </>
      ),
    },
    {
      title: t("sources.typeColumn"),
      dataIndex: "kind",
      width: 95,
      render: (_, source) => (
        <span className="meta px-library-kind">
          {t(`sources.kind.${source.kind}`, { defaultValue: source.kind })}
        </span>
      ),
    },
    {
      title: t("sources.sizeColumn"),
      dataIndex: "bytes",
      width: 105,
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
              {
                key: "reextract",
                label: t("sources.reextract"),
                // A smartbook is read from its package and has no stored file to read again.
                disabled: source.kind === "smartbook" || !source.blobSha,
              },
              { key: "remove", label: t("sources.remove"), danger: true },
            ],
            onClick: ({ key }) => {
              select(source);
              if (key === "replace") void replace(source.id).catch(fail);
              else if (key === "reextract") void reextract(source).catch(fail);
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
    setResult(null);
    setFolderFiles([]);
    setFolderScanned(null);
    setFolderCut(null);
    onClose?.();
  }
  // A refusal for lack of OCR data gets the download card. Anything else is a plain notice.
  const errorView = isOcrRefusal(error) ? (
    <OcrDataCard
      refusal={t(error)}
      onLater={() => {
        setError(null);
        setAgain(null);
      }}
      readyAction={
        again ? (
          <Button
            type="primary"
            shape="round"
            onClick={() => {
              setError(null);
              again.run();
            }}
          >
            {again.label}
          </Button>
        ) : null
      }
    />
  ) : error ? (
    <Notice tone="danger">{t(error)}</Notice>
  ) : null;
  const addModal = (
    <Modal
      open={addOpen}
      width={640}
      title={t("exams.addSources")}
      footer={null}
      // A button that was loading when the dialog closed would keep its hidden "loading" icon, and with it a
      // wrong accessible name, until the dialog was read again. A fresh dialog each time avoids that.
      destroyOnHidden
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
        onChange={(next) => {
          setAddTab(next);
          setResult(null);
          setError(null);
          setAgain(null);
        }}
        items={[
          { value: "file", label: t("sources.fileTab") },
          { value: "folder", label: t("sources.folderTab") },
          { value: "link", label: t("sources.linkTab") },
          { value: "text", label: t("sources.textTab") },
        ]}
      />
      {warning ? <Notice tone="warning">{warning}</Notice> : null}
      {errorView}
      {progress ? (
        <div className="px-library-progress" role="status">
          <p className="small">
            <LoaderCircle size={16} aria-hidden />
            {t("sources.importing", {
              current: Math.min(progress.done + 1, progress.total),
              total: progress.total,
              name: progress.name,
            })}
          </p>
          <Progress
            percent={Math.round((progress.done / progress.total) * 100)}
            showInfo={false}
            size="small"
            aria-hidden
          />
        </div>
      ) : null}
      {result ? (
        <section
          className="px-library-result"
          role="status"
          aria-label={t("sources.importResult")}
        >
          <p className="body-strong">
            <CheckCircle2 size={18} aria-hidden />
            {result.imported
              ? t("sources.imported", { count: result.imported })
              : t("sources.importedNone")}
          </p>
          {result.notes.length || result.failed.length || result.skipped ? (
            <ul className="small px-library-result-notes">
              {result.notes.map((note, index) => (
                <li key={`note-${index}`}>
                  <strong>{note.name}</strong>
                  {" · "}
                  {note.text}
                </li>
              ))}
              {result.failed.map((item, index) => (
                <li key={`failed-${index}`} className="is-failed">
                  <strong>{item.name}</strong>
                  {" · "}
                  {t(item.key)}
                </li>
              ))}
              {result.skipped ? <li>{t("sources.dropSkipped")}</li> : null}
            </ul>
          ) : null}
          <Button type="primary" shape="round" onClick={closeAdd}>
            {t("sources.importDone")}
          </Button>
        </section>
      ) : null}
      {addTab === "file" ? (
        <div
          className={
            dragging ? "px-library-upload is-dragging" : "px-library-upload"
          }
          onDragEnter={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const files = Array.from(event.dataTransfer.files);
            if (files.length && !add.isPending) add.mutate({ dropped: files });
          }}
        >
          <FileText size={28} />
          <p className="body">
            {dragging ? t("sources.dropActive") : t("sources.fileHint")}
          </p>
          <Button
            type="primary"
            shape="round"
            loading={add.isPending}
            onClick={() => add.mutate({})}
          >
            {t("sources.chooseFiles")}
          </Button>
          <p className="small ink-muted">
            PDF, PTSB, DOCX, PPTX, TXT, Markdown, PNG, JPEG, WebP, HEIC, HEIF
          </p>
        </div>
      ) : null}
      {addTab === "folder" ? (
        <div className="px-library-import-pane">
          <p className="small ink-muted">{t("sources.folderHint")}</p>
          <Button
            shape="round"
            loading={scanning}
            disabled={add.isPending}
            onClick={() => void pickFolder()}
          >
            {scanning ? t("sources.folderReading") : t("sources.folder")}
          </Button>
          {folderCut?.files ? (
            <Notice tone="warning">
              {t("sources.folderCappedFiles", { count: folderCut.limit })}
            </Notice>
          ) : null}
          {folderCut?.depth ? (
            <Notice tone="warning">
              {t("sources.folderCappedDepth", { depth: MAX_FOLDER_DEPTH })}
            </Notice>
          ) : null}
          {folderScanned != null && !scanning && !folderFiles.length && !result ? (
            <Notice tone="info">
              {t("sources.folderEmpty", { name: folderScanned })}
            </Notice>
          ) : null}
          {folderFiles.length ? (
            <>
              <p className="small ink-muted" role="status">
                {t("sources.folderFound", { count: folderFiles.length })}
                {folderFiles.some((file) => file.duplicate)
                  ? ` ${t("sources.folderDuplicatesUsed")}`
                  : ""}
              </p>
              <ul className="px-library-file-list">
                {folderFiles.map((file) => (
                  <li key={file.path}>
                    <label className="px-library-file-row">
                      <input
                        type="checkbox"
                        checked={file.selected}
                        disabled={add.isPending}
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
                      <span className="px-library-file-name">
                        <span className="body">{file.name}</span>
                        <span className="small ink-muted">
                          {parentName(file.path)}
                        </span>
                      </span>
                      {file.duplicate ? (
                        <span className="small ink-muted px-library-file-flag">
                          {t("sources.duplicateShort")}
                        </span>
                      ) : null}
                    </label>
                  </li>
                ))}
              </ul>
              <Button
                type="primary"
                shape="round"
                loading={add.isPending}
                disabled={!folderFiles.some((file) => file.selected)}
                onClick={() =>
                  add.mutate({
                    paths: folderFiles
                      .filter((file) => file.selected)
                      .map((file) => file.path),
                  })
                }
              >
                {t("sources.addFolderFiles", {
                  count: folderFiles.filter((file) => file.selected).length,
                })}
              </Button>
            </>
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
                onImported?.([value.sourceId]);
                closeAdd();
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
      {/* An empty table is a scroll area with nothing to focus, and the empty state above already says so. */}
      {sources.length > 0 || list.isPending ? (
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
      ) : null}
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
      {errorView}
      {info ? <Notice tone="info">{info}</Notice> : null}
      {sources
        .filter(
          (source) =>
            source.status === "needs-ocr" ||
            (source.status === "ocr-queued" && ocrFor?.id === source.id),
        )
        .map((source) => (
          <Notice key={source.id} tone="warning">
            {!source.blobSha ? (
              <>
                {t("sources.scannedNoFile", { title: source.title })}{" "}
                <button
                  type="button"
                  onClick={() => void replace(source.id).catch(fail)}
                >
                  {t("sources.replace")}
                </button>
              </>
            ) : (
              <>
                {t("sources.scanned", { title: source.title })}{" "}
                {ocrFor?.id === source.id ? (
                  <>
                    {t(
                      ocrFor.stopping
                        ? "sources.ocrCancelling"
                        : "sources.ocrQueued",
                    )}{" "}
                    <button
                      type="button"
                      disabled={ocrFor.stopping}
                      onClick={cancelScan}
                    >
                      {t("sources.ocrCancel")}
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => scan(source)}>
                    {t("sources.offerOcr")}
                  </button>
                )}
              </>
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
        {meta.data?.extractor ? (
          <p className="small section-hint">
            {meta.data.extractor.path === "vision"
              ? t("sources.readByVision", {
                  model: meta.data.extractor.model,
                })
              : meta.data.extractor.after
                ? t("sources.readByOcrAfter")
                : t("sources.readByOcr")}
          </p>
        ) : null}
        {meta.data?.extractor?.path === "vision" && meta.data.extractor.sent ? (
          <p className="small section-hint">
            {(() => {
              const sent = meta.data.extractor.sent;
              const size = sizeText(sent.bytes);
              if (sent.resizedFrom && sent.width && sent.height)
                return [
                  t("sources.sentResized", {
                    fromWidth: sent.resizedFrom.width,
                    fromHeight: sent.resizedFrom.height,
                    fromSize: sizeText(sent.resizedFrom.bytes),
                    width: sent.width,
                    height: sent.height,
                    size,
                  }),
                  sent.orientation ? t("sources.sentUpright") : "",
                ]
                  .filter(Boolean)
                  .join(" ");
              return sent.width && sent.height
                ? t("sources.sentAsIs", {
                    width: sent.width,
                    height: sent.height,
                    size,
                  })
                : t("sources.sentAsIsSize", { size });
            })()}
          </p>
        ) : null}
        {detailSource && detailSource.planCount > 0
          ? (syllabus.data ?? []).map((check) =>
              check.state === "checked" && check.off > 0 ? (
                <Notice key={check.planId} tone="warning">
                  {t("sources.offSyllabus", {
                    count: check.off,
                    total: check.sections,
                    plan: check.planTitle,
                    sections: check.worst
                      .map((entry) => entry.section)
                      .join(", "),
                  })}
                </Notice>
              ) : check.state === "checked" ? (
                <p key={check.planId} className="small section-hint">
                  {t("sources.syllabusFits", {
                    total: check.sections,
                    plan: check.planTitle,
                  })}
                </p>
              ) : check.state === "unindexed" ? (
                <p key={check.planId} className="small section-hint">
                  {t("sources.syllabusUnindexed", { plan: check.planTitle })}
                </p>
              ) : null,
            )
          : null}
        {detailSource &&
        detailSource.planCount > 0 &&
        (syllabus.data ?? []).some((check) => check.state === "unavailable") ? (
          <p className="small section-hint">
            {t("sources.syllabusUnavailable")}
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
              onClick={() => void replace(sourceId).catch(fail)}
            >
              {t("sources.replace")}
            </Button>
            <Button
              shape="round"
              disabled={
                detailSource?.kind === "smartbook" || !detailSource?.blobSha
              }
              onClick={() => {
                if (detailSource) void reextract(detailSource).catch(fail);
              }}
            >
              {t("sources.reextract")}
            </Button>
            <Button
              shape="round"
              danger
              onClick={() => {
                const source = sources.find((item) => item.id === sourceId);
                if (source) void remove(source).catch(fail);
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
