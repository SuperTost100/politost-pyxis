import { closeSourceViewer, openSourceViewer } from "../../components/SourceViewer";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Button, Input, Modal, Progress, Select, type GetRef, type MenuProps } from "antd";
import { FileText, CheckCircle2 } from "lucide-react";
import { SegmentedTabs } from "../../components/SegmentedTabs";
import {
  ListToolbar,
  ToolbarSearch,
} from "../../components/ListToolbar";
import { MenuButton, MenuItemArea } from "../../components/ItemMenu";
import { sizeText } from "../../components/SourceRow";
import { SourceDetails } from "../../components/SourceDetails";
import "./LibraryPanel.css";
import { FILE_KINDS } from "@shared/file-kind";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { EmptyState } from "../../components/EmptyState";
import { LoadError } from "../../components/LoadError";
import { Notice } from "../../components/Notice";
import { OcrDataCard } from "../../components/OcrData";
import { ScanNotice, scanPending } from "../../components/ScanNotice";
import { isOcrRefusal } from "../../components/ocrErrors";
import { invoke } from "../../lib/ipc";
import { reportError } from "../../lib/errorReports";
import { searchMatcher } from "../../lib/search";
import {
  FreeBooks,
  useBookUpdate,
  useFreeBooks,
} from "../../components/FreeBooks";
import { PdfPasswordDialog } from "../../components/PdfPassword";
import {
  MAX_DROPPED_FILES,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_ENTRIES,
  REPLACE_EXTENSIONS,
  SOURCE_EXTENSIONS,
} from "@shared/source-types";
import { useSources, useSubjects } from "../../lib/queries";
import { LibraryShelf, type LibrarySource, type ShelfHandlers } from "./LibraryShelf";
import { Button as PxButton } from "../../components/Button";
import { SkeletonRows } from "../../components/Skeleton";
import { Logo } from "../../components/Logo";
import { LinkedFolders } from "./LinkedFolders";

const messageKeyOf = (err: unknown): string =>
  err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "sources.importFailed";

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The folder a file sits in, so two files with one name can be told apart in a checklist. */
const parentName = (path: string) => path.split(/[\\/]/).slice(-2, -1)[0] ?? "";

/** What an import run did, kept on screen until the student closes it or starts another run. */
type ImportResult = {
  /** Files that became new sources. A file already in the library is not counted: its source is reused. */
  imported: number;
  notes: Array<{ name: string; text: string }>;
  failed: Array<{ name: string; key: string }>;
  skipped: number;
  /** What the heading says when nothing came in, for material that is not a file. */
  none?: string;
};

/** What a pasted text or a link that was already a source shows: nothing added, and the source that holds it. */
const alreadyThere = (title: string, t: (key: string) => string): ImportResult => ({
  imported: 0,
  notes: [{ name: title, text: t("sources.reused") }],
  failed: [],
  skipped: 0,
  none: t("sources.importedNothing"),
});

export function LibraryPanel({
  importOnly = false,
  droppedFiles,
  onClose,
  onImported,
  tab = "file",
  sortsSubjects = false,
}: {
  importOnly?: boolean;
  /** The Library page itself: what it adds gets a subject chosen by Pyxis. Exam pages add for their exam. */
  sortsSubjects?: boolean;
  /** Files dropped on a zone outside the panel: it imports them as soon as it opens. */
  droppedFiles?: File[];
  /** The way of adding the dialog opens on, such as "folder" when the student chose a folder. */
  tab?: "file" | "folder";
  onClose?: () => void;
  /** Called with the ids of the sources an import just created, so a caller can use them right away. */
  onImported?: (sourceIds: string[]) => void;
} = {}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const list = useSources();
  const [addOpen, setAddOpen] = useState(importOnly);
  const [booksOpen, setBooksOpen] = useState(false);
  const [addTab, setAddTab] = useState<string>(tab);
  // One field searches titles or, with the Content scope, the passages inside the sources.
  const [searchText, setSearchText] = useState("");
  const [scope, setScope] = useState<"titles" | "content">("titles");
  const [searched, setSearched] = useState("");
  const [filterType, setFilterType] = useState("all");
  const [detailsOpen, setDetailsOpen] = useState(false);
  // The row menu's Rename opens the details with the title field ready.
  const [renameOnOpen, setRenameOnOpen] = useState(false);
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
  const [error, setError] = useState<string | null>(null);
  // The action local OCR data refused, kept so the student can run it again once the data is ready.
  const [again, setAgain] = useState<{ label: string; run: () => void } | null>(
    null,
  );
  const [warning, setWarning] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // The locked PDF whose password is being asked for, and the link source being checked for a new version.
  const [unlocking, setUnlocking] = useState<{
    jobId: string;
    title: string;
  } | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  // What a file's cover, row and menu do, read when one is used, so the covers can skip renders the shelf does not need.
  const rowHandlers = useRef<ShelfHandlers | null>(null);
  const addButton = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [pickedPassage, setPickedPassage] = useState<string | null>(null);
  const [searchPicked, setSearchPicked] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
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
  const subjects = useSubjects();
  /**
   * Starts choosing the subjects of what an add brought in, on the Library page only. The files are in before this
   * runs, so a refused request is reported and nothing more: they stay `waiting` and "Da sistemare" tells the student
   * what to do, and the add that called this still ends as the success it was.
   */
  const sortAdded = async (ids: string[]) => {
    if (!sortsSubjects || !ids.length) return;
    try {
      await invoke("sources.sortSubjects", { sourceIds: ids });
    } catch (err) {
      reportError(err);
    }
  };
  // A folder scan stops at a file count, a depth and an entry count. The student is told when it did.
  const [folderCut, setFolderCut] = useState<{
    files: boolean;
    depth: boolean;
    entries: boolean;
    unreadable: boolean;
    limit: number;
  } | null>(null);

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
  }, [params]);

  useEffect(() => {
    if (searchPicked) return;
    const openedSource = opened.data?.[0]?.sourceId;
    if (openedSource) setSourceId(openedSource);
  }, [opened.data, searchPicked]);

  // The address when the passage to show was chosen, by the address itself or by a search hit. Back can keep the
  // library mounted while the next page loads, and a reply that lands then must not open the viewer over that page.
  const chosenAt = useRef(window.location.hash);
  useEffect(() => {
    chosenAt.current = window.location.hash;
  }, [passageId]);
  useEffect(() => {
    if (passageId && window.location.hash === chosenAt.current)
      openSourceViewer({ passageId, sourceId: sourceId ?? undefined });
  }, [page.data, opened.data]);

  const [dragging, setDragging] = useState(false);
  // One path for the picker, a drop and a folder. A drop gets its grant from main before core sees a path.
  const add = useMutation({
    mutationFn: async (input: { dropped?: File[]; paths?: string[]; folder?: string }) => {
      setWarning(null);
      setError(null);
      setAgain(null);
      setResult(null);
      let paths: string[];
      let skipped = 0;
      if (input.dropped) {
        // Main refuses a larger drop as a whole. Saying how many fit is more use than a general failure.
        if (input.dropped.length > MAX_DROPPED_FILES)
          throw { messageKey: "sources.dropTooMany" };
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
      const outcome: ImportResult & { ids: string[]; done: string[]; added: string[] } = {
        imported: 0,
        notes: [],
        failed: [],
        skipped,
        ids: [],
        done: [],
        added: [],
      };
      let firstError: unknown;
      // Files added together are one request, which Attività shows as one row.
      const batch =
        paths.length > 1 ? { id: crypto.randomUUID(), ...(input.folder ? { folder: input.folder } : {}) } : undefined;
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
              // The same bytes are already a source. That source is used, no second copy is made. A copy a chat or a
              // plan file left out of the library joins it, so it shows here and deleting that chat keeps it.
              await invoke("sources.promote", { sourceId: preview.existingSourceId });
              outcome.notes.push({
                name: fileName(path),
                text: t("sources.reused"),
              });
              outcome.ids.push(preview.existingSourceId);
            } else {
              const value = await invoke("sources.import", {
                path,
                ...(batch ? { batch } : {}),
                ...(sortsSubjects ? { sort: true } : {}),
              });
              outcome.ids.push(value.sourceId);
              // Core found the same bytes already there after the preview, or in a linked folder: no second copy.
              if (value.existing) outcome.notes.push({ name: fileName(path), text: t("sources.reused") });
              else {
                outcome.imported += 1;
                outcome.added.push(value.sourceId);
              }
            }
            outcome.done.push(path);
          } catch (err) {
            // The files from the refused one on stay chosen, so nothing has to be picked or dropped again.
            if (isOcrRefusal(messageKeyOf(err))) {
              const rest = paths.slice(index);
              setAgain({
                label: t("sources.ocrData.again.import", { count: rest.length }),
                run: () => add.mutate({ paths: rest, ...(input.folder ? { folder: input.folder } : {}) }),
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
        // One sort for the files the run added, also when a refusal stopped it: those files are in.
        await sortAdded(outcome.added);
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
  // Files dropped outside the panel are read once, as it opens.
  const droppedRead = useRef(false);
  useEffect(() => {
    if (!droppedFiles?.length || droppedRead.current) return;
    droppedRead.current = true;
    add.mutate({ dropped: droppedFiles });
  }, [droppedFiles, add]);

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
        scan.cappedFiles || scan.cappedDepth || scan.cappedEntries || scan.unreadable
          ? {
              files: scan.cappedFiles,
              depth: scan.cappedDepth,
              entries: scan.cappedEntries,
              unreadable: scan.unreadable,
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
    mutationFn: async (url: string) => {
      const value = await invoke("sources.link", { url, ...(sortsSubjects ? { sort: true } : {}) });
      if (!value.existing) await sortAdded([value.sourceId]);
      return value;
    },
    onSuccess: (value) => {
      setLinkUrl("");
      void client.invalidateQueries({ queryKey: ["sources"] });
      setSourceId(value.sourceId);
      onImported?.([value.sourceId]);
      linkPreview.reset();
      if (value.existing) setResult(alreadyThere(value.title, t));
      else closeAdd();
    },
    onError: (err: unknown) => fail(err),
  });

  const embedding = useQuery({
    queryKey: ["embedding"],
    queryFn: () => invoke("sources.embedState", {}),
  });
  const sources = list.data ?? [];
  // New versions of free books are checked only while the Library is open, and only when it holds a smartbook.
  const freeBooks = useFreeBooks(
    !importOnly && sources.some((source) => source.kind === "smartbook"),
  );
  const newVersions = new Map(
    (freeBooks.data ?? []).flatMap((book) =>
      book.sourceId && book.update === "available"
        ? [[book.sourceId, book.version] as const]
        : [],
    ),
  );
  const bookUpdate = useBookUpdate();
  async function updateBook(source: LibrarySource) {
    setInfo(null);
    setError(null);
    setAgain(null);
    try {
      const version = await bookUpdate.update(source.id);
      if (version)
        setInfo(t("books.updateStarted", { title: source.title, version }));
    } catch (err) {
      fail(err);
    }
  }
  function select(source: LibrarySource) {
    setSourceId(source.id);
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
  async function reextract(source: LibrarySource, confirmed = false) {
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
  /** Fetches a link source again. A changed page is read as a new version; a source that plans use asks first. */
  async function refresh(source: LibrarySource, confirmed = false) {
    setInfo(null);
    setError(null);
    setAgain(null);
    setRefreshing(source.id);
    let result;
    try {
      result = await invoke("sources.refresh", {
        sourceId: source.id,
        confirmed,
      });
    } finally {
      setRefreshing(null);
    }
    if (!result.started && result.inUse > 0 && !result.unchanged) {
      if (!window.confirm(t("sources.refreshInUse", { count: result.inUse })))
        return;
      return refresh(source, true);
    }
    setInfo(
      t(result.unchanged ? "sources.refreshUnchanged" : "sources.refreshStarted", {
        title: source.title,
      }),
    );
    void client.invalidateQueries({ queryKey: ["sources"] });
  }
  async function remove(source: LibrarySource) {
    if (!window.confirm(t("sources.removeTitle", { title: source.title }))) return;
    const result = await invoke("sources.remove", {
      sourceId: source.id,
      confirmed: false,
    });
    if (!result.removed && result.inUse) {
      if (!window.confirm(t("sources.inUse"))) return;
      await invoke("sources.remove", { sourceId: source.id, confirmed: true });
    }
    if (sourceId === source.id) setSourceId(null);
    // A subject whose last file this was is no longer in use, so its card can offer the delete.
    void client.invalidateQueries({ queryKey: ["sources"] });
    void client.invalidateQueries({ queryKey: ["subjects"] });
  }
  // The Content scope asks once typing pauses; Enter asks at once.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearched(searchText), 300);
    return () => window.clearTimeout(timer);
  }, [searchText]);
  const contentQuery = scope === "content" ? searched.trim() : "";
  const passages = useQuery({
    queryKey: ["source-search", contentQuery],
    enabled: contentQuery.length > 0,
    queryFn: () => invoke("sources.search", { query: contentQuery }),
    placeholderData: keepPreviousData,
  });
  // The type filter is by kind: a book, slides, an exam paper...
  const kindOf = new Map(sources.map((source) => [source.id, source.fileKind as string]));
  const titleMatches = searchMatcher(scope === "titles" ? searchText : "");
  const matching = sources.filter(
    (source) =>
      (filterType === "all" || source.fileKind === filterType) &&
      titleMatches(source.title),
  );
  // A hit whose source was removed since the search would open nothing.
  const hits = (passages.data ?? []).filter(
    (hit) =>
      kindOf.has(hit.sourceId) &&
      (filterType === "all" || kindOf.get(hit.sourceId) === filterType),
  );
  const filtering = filterType !== "all" || (scope === "titles" && searchText.trim().length > 0);
  // What takes the shelves' place when the list goes empty: a message when the type filter or the title search leaves no
  // file, and the empty state when the last file is removed.
  const nothingMatches = list.isSuccess && sources.length > 0 && matching.length === 0 && filtering && contentQuery === "";
  const libraryEmpty = list.isSuccess && sources.length === 0;
  const typeFilter = useRef<GetRef<typeof Select>>(null);
  // A change that takes the last file out of the list (its kind, its title, its removal) removes the cover that held
  // the focus along with the shelves. The focus goes to the control that filters, because changing it is what brings
  // the file back: the type when it is set, else the search field. With no file at all it goes to the empty page's button. A
  // focus that stayed on something else, such as the details panel, is left where it is.
  const hadFiles = useRef(false);
  useEffect(() => {
    // An empty Library that was empty when the page opened has lost nothing.
    const emptied = libraryEmpty && hadFiles.current;
    hadFiles.current = sources.length > 0;
    if (!nothingMatches && !emptied) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (emptied) addButton.current?.querySelector("button")?.focus();
    else (filterType !== "all" ? typeFilter.current : document.getElementById("source-search"))?.focus();
  }, [nothingMatches, libraryEmpty, filterType, sources.length]);
  function openHit(hit: (typeof hits)[number]) {
    openSourceViewer({ passageId: hit.id, sourceId: hit.sourceId });
    setSearchPicked(true);
    setSourceId(hit.sourceId);
    if (hit.locator.chapter == null) {
      setPickedPassage(hit.id);
      setChapter(null);
      setParagraph(undefined);
      return;
    }
    setPickedPassage(null);
    setChapter(hit.locator.chapter);
    setParagraph(hit.locator.paragraph);
  }
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
    <Notice tone="danger">{t(error, { max: MAX_DROPPED_FILES })}</Notice>
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
            <Logo working decorative size={16} />
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
              : (result.none ?? t("sources.importedNone"))}
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
          {folderCut?.entries ? (
            <Notice tone="warning">
              {t("sources.folderCappedEntries", { count: MAX_FOLDER_ENTRIES })}
            </Notice>
          ) : null}
          {folderCut?.depth ? (
            <Notice tone="warning">
              {t("sources.folderCappedDepth", { depth: MAX_FOLDER_DEPTH })}
            </Notice>
          ) : null}
          {folderCut?.unreadable ? (
            <Notice tone="warning">{t("sources.folderUnreadable")}</Notice>
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
                    ...(folderScanned ? { folder: folderScanned } : {}),
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
                  : ` · ${sizeText(linkPreview.data.bytes)}`}
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
            void invoke("sources.paste", {
              title: pasteTitle,
              text: pasteText,
              ...(sortsSubjects ? { sort: true } : {}),
            })
              .then(async (value) => {
                if (!value.existing) await sortAdded([value.sourceId]);
                setPasteText("");
                void client.invalidateQueries({ queryKey: ["sources"] });
                setSourceId(value.sourceId);
                onImported?.([value.sourceId]);
                if (value.existing) setResult(alreadyThere(value.title, t));
                else closeAdd();
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
  const loadFailed = list.isError && !list.data;
  const empty = list.isSuccess && sources.length === 0;
  // The subjects that exist are on the page even before the first file, and a failed read of them is said, not hidden.
  const subjectList = subjects.data ?? [];
  // A read that failed stays failed while the student tries again: with nothing read yet the query reports "pending" for
  // that retry, which would swap the page for its placeholder and start the read again from the page it replaced. With an
  // older list kept, a failed read still counts: a file that got a subject made since is on no shelf of that list.
  const subjectsFailed = subjects.isError || (!subjects.data && subjects.errorUpdatedAt > 0);
  const showHits = contentQuery.length > 0;
  rowHandlers.current = {
    // A click on a cover or a row opens the file at its first page; its details are one item of the panel's menu.
    open(source, menu) {
      select(source);
      openSourceViewer({ sourceId: source.id }, { menu });
    },
    act(source, key) {
      select(source);
      if (key === "replace") void replace(source.id).catch(fail);
      else if (key === "reextract") void reextract(source).catch(fail);
      else if (key === "refresh") void refresh(source).catch(fail);
      else if (key === "remove") void remove(source).catch(fail);
      else if (key === "update-book") void updateBook(source);
      else if (key === "unlock" && source.errorJobId) setUnlocking({ jobId: source.errorJobId, title: source.title });
      else {
        // The details take the panel's place, on the same side.
        closeSourceViewer();
        setRenameOnOpen(key === "rename");
        setDetailsOpen(true);
      }
    },
  };
  // The Library's menu, for the dots in the head and a right-click on it.
  const pageMenu: MenuProps = {
    items: [{ key: "books", label: t("books.open") }],
    onClick: () => setBooksOpen(true),
  };
  return (
    <div className="px-library">
      {addModal}
      <FreeBooks open={booksOpen} onClose={() => setBooksOpen(false)} />
      <PdfPasswordDialog
        target={unlocking}
        onClose={() => {
          setUnlocking(null);
          void client.invalidateQueries({ queryKey: ["sources"] });
        }}
      />
      <MenuItemArea as="div" className="px-library-head" menu={pageMenu} region={t("sources.shelf.more")}>
        <div className="px-library-head-text">
          <h1 className="title-1">{t("nav.library")}</h1>
        </div>
        <div className="px-library-head-acts">
          {/* While the Library is empty its own page links the first folder, so the head does not. */}
          {sortsSubjects ? (
            <LinkedFolders
              sources={list.data}
              onLink={() => navigate("/onboarding?again=1&step=material&from=library")}
              elsewhere={empty ? () => addButton.current : undefined}
            />
          ) : null}
          <MenuButton rightClick menu={pageMenu} label={t("sources.shelf.more")} />
          {empty ? null : (
            <div ref={addButton} className="px-library-add-button">
              <PxButton icon="file-plus" onClick={() => setAddOpen(true)}>
                {t("sources.shelf.addFiles")}
              </PxButton>
            </div>
          )}
        </div>
      </MenuItemArea>
      {loadFailed ? (
        <LoadError onRetry={() => void list.refetch()}>
          {t("sources.loadFailed")}
        </LoadError>
      ) : empty ? (
        <EmptyState
          body={t("sources.shelf.emptyBody")}
          action={
            <div ref={addButton}>
              <PxButton
                icon="folder-plus"
                onClick={() => {
                  setAddTab("folder");
                  setAddOpen(true);
                }}
              >
                {t("sources.shelf.linkFolder")}
              </PxButton>
            </div>
          }
        />
      ) : list.isPending ? null : (
        <ListToolbar
          search={
            <ToolbarSearch
              id="source-search"
              label={t(
                scope === "titles" ? "sources.filterTitle" : "sources.search",
              )}
              placeholder={t(
                scope === "titles" ? "sources.filterTitle" : "sources.search",
              )}
              value={searchText}
              onChange={setSearchText}
              onPressEnter={() => setSearched(searchText)}
              scope={
                <Select
                  aria-label={t("sources.scope")}
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: "titles", label: t("sources.scopeTitles") },
                    { value: "content", label: t("sources.scopeContent") },
                  ]}
                />
              }
            />
          }
          filters={
            <Select
              ref={typeFilter}
              value={filterType}
              aria-label={t("sources.typeColumn")}
              onChange={setFilterType}
              options={[
                { value: "all", label: t("sources.allTypes") },
                // The kinds the Library holds, in the order the "Tipo" menu lists them.
                ...FILE_KINDS.filter((kind) => sources.some((source) => source.fileKind === kind)).map(
                  (kind) => ({
                    value: kind,
                    label: t(`sources.fileKind.${kind}`),
                  }),
                ),
              ]}
            />
          }
        />
      )}
      {warning ? <Notice tone="warning">{warning}</Notice> : null}
      {errorView}
      {info ? <Notice tone="info">{info}</Notice> : null}
      {subjectsFailed ? (
        <LoadError onRetry={() => void subjects.refetch()}>{t("sources.shelf.subjectsFailed")}</LoadError>
      ) : null}
      {showHits ? (
        <section aria-label={t("sources.searchPassages")}>
          <p className="small ink-muted px-library-count" role="status">
            {passages.isError
              ? t("sources.searchFailed")
              : passages.data
                ? hits.length
                  ? t("sources.hits", { count: hits.length })
                  : t("sources.searchNone", { query: contentQuery })
                : "\u00a0"}
          </p>
          {hits.length > 0 ? (
            <ul className="px-list-surface px-library-hits">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    className="px-library-hit"
                    onClick={() => openHit(hit)}
                  >
                    <span className="body-strong">{hit.sectionPath}</span>
                    <span className="small">{hit.text.slice(0, 140)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : loadFailed || (empty && subjectList.length === 0) ? null : list.isPending || (subjects.isPending && !subjectsFailed) ? (
        <SkeletonRows label={t("components.loading")} />
      ) : matching.length === 0 && filtering && !empty ? (
        <p className="body" role="status">{t("sources.noMatch")}</p>
      ) : (
        <LibraryShelf
          sources={matching}
          all={sources}
          subjects={subjectList}
          subjectsFailed={subjectsFailed}
          filtering={filtering && !empty}
          selectedId={sourceId}
          newVersions={newVersions}
          refreshBusy={refreshing !== null}
          bookBusy={bookUpdate.busy}
          handlers={rowHandlers}
          addButton={addButton}
          onError={(key) => setError(key)}
        />
      )}
      {/* Only the Content scope uses the model, so the offer waits there, under the results. */}
      {scope === "content" && !empty && !embedding.data?.ready ? (
        <div className="px-library-embed">
          <p className="small">{t("sources.embedAsk")}</p>
          <Button
            shape="round"
            onClick={() => {
              void invoke("sources.embed", { consent: true })
                .then(() => setWarning(t("sources.embedQueued")))
                .catch(fail);
            }}
          >
            {t("sources.embedDownload")}
          </Button>
        </div>
      ) : null}
      {sources.filter(scanPending).map((source) => (
        <ScanNotice
          key={source.id}
          source={source}
          // A linked file is replaced in its folder, where Pyxis reads it again, never with a copy.
          onReplace={source.linked ? undefined : () => void replace(source.id).catch(fail)}
        />
      ))}
      <SourceDetails
        sourceId={detailsOpen ? sourceId : null}
        startRename={renameOnOpen}
        onClose={() => {
          setDetailsOpen(false);
          setRenameOnOpen(false);
        }}
        onOpen={(id) => {
          setSourceId(id);
          setDetailsOpen(true);
        }}
      />
    </div>
  );
}
