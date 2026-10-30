import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Drawer, Dropdown, Input, Skeleton, type InputRef } from "antd";
import {
  AlertCircle,
  BookMarked,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock,
  FileText,
  GraduationCap,
  Image as ImageIcon,
  LoaderCircle,
  Plus,
  Quote,
  ScanText,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import { invoke } from "../lib/ipc";
import { pageRanges } from "../lib/pageRanges";
import { usePlans, useSources } from "../lib/queries";
import { refreshPlan } from "../lib/refreshPlan";
import { i18n } from "../locales/i18n";
import { IconButton } from "./IconButton";
import { LoadError } from "./LoadError";
import { Notice } from "./Notice";
import { ScanNotice, scanPending } from "./ScanNotice";
import { openSourceViewer } from "./SourceViewer";
import { sizeText } from "./SourceRow";
import "./SourceDetails.css";

type Details = NonNullable<RequestOutput<"sources.details">>;
type Section = Details["bySection"][number];
type Syllabus = RequestOutput<"sources.syllabus">[number];

/** What a caller already knows about the source, for one that is not in the Library list (a plan file's source). */
export type SourceSummary = { id: string; title: string; kind: string; status: string; sections?: number };

const PROBLEM = new Set(["failed", "needs-ocr", "interrupted", "cancelled"]);
/** Sections shown before "Show all". */
const TOP_SECTIONS = 4;
/** Topic names listed before "and N more". */
const TOP_TOPICS = 4;

const messageKeyOf = (err: unknown): string =>
  err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "errors.internal";

function dayText(time: number): string {
  const sameYear = new Date(time).getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(i18n.language, {
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(time);
}

function KindIcon({ kind, scan }: { kind: string; scan: boolean }) {
  const props = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;
  if (kind === "smartbook") return <BookMarked {...props} />;
  if (kind === "image") return <ImageIcon {...props} />;
  if (scan) return <ScanText {...props} />;
  return <FileText {...props} />;
}

/** The source's state as an icon and a word, the same words the row uses. */
function SourceStatus({ status }: { status: string }) {
  const { t } = useTranslation();
  const tone = status === "ready" ? "is-ok" : PROBLEM.has(status) ? "is-warn" : "is-info";
  return (
    <span className={`px-source-state ${tone}`}>
      {status === "ready" ? (
        <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden />
      ) : PROBLEM.has(status) ? (
        <AlertCircle size={16} strokeWidth={1.75} aria-hidden />
      ) : (
        <LoaderCircle className="px-spin" size={16} strokeWidth={1.75} aria-hidden />
      )}
      {t(`sources.status.${status}`, { defaultValue: status })}
    </span>
  );
}

/** One mark per page, coloured by how its text was read. The list under it says the same in words. */
function PageStrip({ pages }: { pages: NonNullable<Details["pages"]> }) {
  const ocr = new Set(pages.ocr);
  const blank = new Set(pages.blank);
  const marks = Array.from({ length: pages.count }, (_, index) => {
    const page = index + 1;
    return ocr.has(page) ? "is-ocr" : blank.has(page) ? "is-blank" : "";
  });
  // Many pages leave no room for gaps; the marks then join into runs.
  const gap = pages.count > 150 ? 0 : pages.count > 60 ? 1 : 2;
  return (
    <div
      className="px-source-strip"
      aria-hidden
      style={{ gridTemplateColumns: `repeat(${pages.count}, minmax(0, 1fr))`, gap }}
    >
      {marks.map((mark, index) => (
        <i key={index} className={mark} />
      ))}
    </div>
  );
}

function ReadLine({ icon, tone, title, children }: { icon: ReactNode; tone?: string; title: string; children?: ReactNode }) {
  return (
    <li>
      <span className={tone ? `px-source-read-icon ${tone}` : "px-source-read-icon"} aria-hidden>
        {icon}
      </span>
      <span className="body-strong">{title}</span>
      {children ? <span className="small ink-muted">{children}</span> : null}
    </li>
  );
}

function SyllabusLine({ check }: { check: Syllabus | undefined }) {
  const { t } = useTranslation();
  if (!check) return null;
  if (check.state === "checked" && check.off === 0)
    return (
      <span className="px-source-state is-ok">
        <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden />
        {t("sources.panel.syllabusOk")}
      </span>
    );
  if (check.state === "checked")
    return (
      <>
        <span className="px-source-state is-warn">
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden />
          {t("sources.panel.syllabusOff", { count: check.off, total: check.sections })}
        </span>
        <span className="small ink-muted">
          {t("sources.panel.syllabusWhy", {
            count: check.worst.length,
            sections: new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(
              check.worst.map((entry) => entry.section),
            ),
          })}
        </span>
      </>
    );
  if (check.state === "unindexed")
    return (
      <span className="px-source-state">
        <Clock size={16} strokeWidth={1.75} aria-hidden />
        {t("sources.panel.syllabusPending")}
      </span>
    );
  if (check.state === "unavailable")
    return (
      <span className="px-source-state">
        <CircleDashed size={16} strokeWidth={1.75} aria-hidden />
        {t("sources.panel.syllabusOffline")}
      </span>
    );
  return null;
}

/** A section's name as the student reads it: "Page 12" for a page, the chapter title without its number for a book. */
function sectionName(section: Section, t: (key: string, options?: Record<string, unknown>) => string): string {
  const page = /^p\. (\d+)$/.exec(section.section);
  if (page) return t("sources.panel.page", { n: Number(page[1]) });
  const slide = /^slide (\d+)$/.exec(section.section);
  if (slide) return t("sources.panel.slide", { n: Number(slide[1]) });
  if (section.section === "text") return t("sources.panel.wholeText");
  if (section.chapter != null && section.section.startsWith(`${section.chapter}. `))
    return section.section.slice(`${section.chapter}. `.length);
  return section.section;
}

function sectionWhere(section: Section, t: (key: string, options?: Record<string, unknown>) => string): string {
  const parts: string[] = [];
  if (section.chapter != null) parts.push(t("sources.panel.chapter", { n: section.chapter }));
  // A page's own section needs no page range under it.
  if (section.firstPage != null && !/^p\. \d+$/.test(section.section))
    parts.push(
      section.lastPage != null && section.lastPage !== section.firstPage
        ? t("sources.panel.pageSpan", { from: section.firstPage, to: section.lastPage })
        : t("sources.panel.pageOne", { n: section.firstPage }),
    );
  return parts.join(" · ");
}

/**
 * The details of one source, in a 520 px side panel over the Library or an exam's Sources tab. Rename, open and adding
 * the source to another exam live here; replace, read again and remove stay in the row's menu. Every number comes
 * from `sources.details` or another stored read, and a fact that cannot be read for this source is left out.
 */
export function SourceDetails({
  sourceId,
  known,
  startRename = false,
  onClose,
  onOpen,
}: {
  /** The source shown; null keeps the panel closed. */
  sourceId: string | null;
  /** What the caller's list says about it, used when the Library list does not hold it. */
  known?: SourceSummary;
  /** Opens with the title field ready, as the row menu's Rename asks. */
  startRename?: boolean;
  onClose: () => void;
  /** Shows this panel again for a source: the way back from the viewer a chapter or citation opened. */
  onOpen?: (sourceId: string) => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const titleId = useId();
  const open = sourceId != null;
  // The last source shown stays rendered while the panel slides away.
  const [shownId, setShownId] = useState(sourceId);
  useEffect(() => {
    if (sourceId) setShownId(sourceId);
  }, [sourceId]);
  const id = sourceId ?? shownId;
  const list = useSources(id != null);
  const listed = (list.data ?? []).find((item) => item.id === id);
  const source = listed ?? (known && known.id === id ? known : undefined);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Run once the panel has closed and focus is back on the row: opening the viewer, so its own close returns there.
  const afterClose = useRef<(() => void) | null>(null);
  const renameField = useRef<InputRef>(null);

  // A newly opened source starts the panel afresh; a list refresh while it is open does not.
  const opening = sourceId ? `${sourceId}:${startRename}` : null;
  const [openedAs, setOpenedAs] = useState<string | null>(null);
  if (opening !== openedAs) {
    setOpenedAs(opening);
    if (opening) {
      setRenaming(startRename);
      setTitle(source?.title ?? "");
      setRenameError(null);
      setShowAll(false);
      setAdded(null);
      setAddError(null);
    }
  }

  const details = useQuery({
    queryKey: ["source-details", id],
    enabled: open && id != null,
    queryFn: () => invoke("sources.details", { sourceId: id ?? "" }),
  });
  const meta = useQuery({
    queryKey: ["source-meta", id],
    enabled: open && id != null,
    queryFn: () => invoke("sources.meta", { sourceId: id ?? "" }),
  });
  const chapters = useQuery({
    queryKey: ["source-chapters", id],
    enabled: open && id != null && source?.kind === "smartbook",
    queryFn: () => invoke("sources.chapters", { sourceId: id ?? "" }),
  });
  const usedBy = details.data?.exams.filter((exam) => exam.role === "material").length ?? 0;
  // SRC-08: which sections sit off the syllabus of the exams that use it. Local vectors only.
  const syllabus = useQuery({
    queryKey: ["source-syllabus", id, source?.status, source?.sections],
    enabled: open && id != null && usedBy > 0 && source?.status === "ready",
    queryFn: () => invoke("sources.syllabus", { sourceId: id ?? "" }),
  });
  const plans = usePlans(open);

  function close(): void {
    onClose();
  }

  function openSource(location: { passageId?: string; chapter?: number }): void {
    if (!id) return;
    afterClose.current = () =>
      openSourceViewer({ sourceId: id, ...location }, onOpen ? () => onOpen(id) : undefined);
    close();
  }

  async function rename(): Promise<void> {
    if (!id) return;
    const next = title.trim();
    if (!next || next === source?.title) {
      setRenaming(false);
      return;
    }
    try {
      await invoke("sources.rename", { sourceId: id, title: next });
      setRenaming(false);
      setRenameError(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["sources"] }),
        ...(details.data?.exams ?? []).map((exam) => refreshPlan(client, exam.planId)),
      ]);
    } catch (err) {
      setRenameError(messageKeyOf(err));
    }
  }

  async function addTo(planId: string): Promise<void> {
    if (!id) return;
    setAdding(true);
    setAdded(null);
    setAddError(null);
    try {
      await invoke("plans.attachSources", { planId, sourceIds: [id] });
      setAdded(plans.data?.find((plan) => plan.id === planId)?.title ?? null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["sources"] }),
        client.invalidateQueries({ queryKey: ["source-details", id] }),
        refreshPlan(client, planId),
      ]);
    } catch (err) {
      setAddError(messageKeyOf(err));
    } finally {
      setAdding(false);
    }
  }

  const data = details.data ?? undefined;
  // Core answers null for a source removed since the list was read: the panel says so, and the Library and every
  // exam's Sources tab drop the row (removal also unlinks it from its exams).
  const gone = details.isSuccess && details.data === null;
  useEffect(() => {
    if (!gone) return;
    void client.invalidateQueries({ queryKey: ["sources"] });
    void client.invalidateQueries({ queryKey: ["plan"] });
    void client.invalidateQueries({ queryKey: ["plans"] });
  }, [gone, client]);
  const pending = source ? scanPending({ ...source, sections: source.sections ?? 0, blobSha: listed?.blobSha ?? null }) : false;
  const pages = data?.pages && !pending ? data.pages : undefined;
  // A scan still being read, or a PDF whose pages OCR read, gets the scan icon.
  const scan = source?.kind === "pdf" && (pending || (!!pages && pages.ocr.length > 0));
  const textPages = pages ? pages.count - pages.ocr.length - pages.blank.length : 0;
  const sections = data?.bySection ?? [];
  const cited = sections.filter((section) => section.count > 0);
  const shownSections = showAll ? sections : cited.slice(0, TOP_SECTIONS);
  const most = Math.max(1, ...sections.map((section) => section.count));
  const uncited = sections.length - cited.length;
  const attachedIds = new Set(data?.exams.map((exam) => exam.planId) ?? []);
  const candidates = (plans.data ?? []).filter((plan) => !plan.archived && !attachedIds.has(plan.id));

  const facts: Array<{ label: string; value: ReactNode; sub?: string }> = [];
  if (pages)
    facts.push({
      label: t("sources.panel.pages"),
      value: pages.count,
      sub:
        pages.ocr.length === 0
          ? t("sources.panel.pagesFromText")
          : pages.ocr.length + pages.blank.length === pages.count
            ? t("sources.panel.pagesAllOcr")
            : t("sources.panel.pagesOcr", { count: pages.ocr.length }),
    });
  else if (pending && data?.pages)
    facts.push({
      label: t("sources.panel.readSoFar"),
      value: data.pages.count - data.pages.blank.length,
      sub: t("sources.panel.readSoFarSub", { count: data.pages.count - data.pages.blank.length }),
    });
  if (data && !data.pages && data.sections > 0)
    facts.push({
      // One unit for the count, as the Library list and the lines below say it: sections, for a book too.
      label: t("sources.panel.sections"),
      value: data.sections,
      sub:
        data.citations === 0
          ? undefined
          : uncited === 0
            ? t("sources.panel.allCited")
            : t("sources.panel.neverCited", { count: uncited }),
    });
  if (pages && data && data.citations > 0)
    facts.push({
      label: t("sources.panel.citedPages"),
      value: cited.length,
      sub: t("sources.panel.citedPagesSub", { count: pages.count }),
    });
  if (listed?.bytes != null)
    facts.push({ label: t("sources.panel.file"), value: sizeText(listed.bytes), sub: t("sources.panel.fileSub") });

  const extractor = meta.data?.extractor;
  const sent = extractor?.path === "vision" ? extractor.sent : undefined;
  const host = (() => {
    if (!listed?.originUrl) return null;
    try {
      return new URL(listed.originUrl).hostname;
    } catch {
      return listed.originUrl;
    }
  })();
  const readLines: ReactNode[] = [];
  if (pages && textPages > 0)
    readLines.push(
      <ReadLine
        key="text"
        tone="is-ok"
        icon={<CheckCircle2 size={20} strokeWidth={1.75} />}
        title={t("sources.panel.readText", { count: textPages })}
      >
        {t("sources.panel.readTextSub")}
      </ReadLine>,
    );
  if (pages && pages.ocr.length > 0)
    readLines.push(
      <ReadLine
        key="ocr"
        tone="is-run"
        icon={<ScanText size={20} strokeWidth={1.75} />}
        title={t("sources.panel.readOcr", { count: pages.ocr.length })}
      >
        {pages.ocrAt
          ? t("sources.panel.readOcrSub", {
              count: pages.ocr.length,
              pages: pageRanges(pages.ocr),
              date: dayText(pages.ocrAt),
            })
          : null}
      </ReadLine>,
    );
  if (pages && pages.blank.length > 0)
    readLines.push(
      <ReadLine
        key="blank"
        icon={<CircleDashed size={20} strokeWidth={1.75} />}
        title={t("sources.panel.readBlank", { count: pages.blank.length })}
      >
        {t("sources.panel.readBlankSub", { count: pages.blank.length, pages: pageRanges(pages.blank) })}
      </ReadLine>,
    );
  if (extractor)
    readLines.push(
      <ReadLine
        key="extractor"
        tone="is-ok"
        icon={<CheckCircle2 size={20} strokeWidth={1.75} />}
        title={
          extractor.path === "vision"
            ? t("sources.readByVision", { model: extractor.model })
            : extractor.after
              ? t("sources.readByOcrAfter")
              : t("sources.readByOcr")
        }
      >
        {sent
          ? sent.resizedFrom && sent.width && sent.height
            ? [
                t("sources.sentResized", {
                  fromWidth: sent.resizedFrom.width,
                  fromHeight: sent.resizedFrom.height,
                  fromSize: sizeText(sent.resizedFrom.bytes),
                  width: sent.width,
                  height: sent.height,
                  size: sizeText(sent.bytes),
                }),
                sent.orientation ? t("sources.sentUpright") : "",
              ]
                .filter(Boolean)
                .join(" ")
            : sent.width && sent.height
              ? t("sources.sentAsIs", { width: sent.width, height: sent.height, size: sizeText(sent.bytes) })
              : t("sources.sentAsIsSize", { size: sizeText(sent.bytes) })
          : null}
      </ReadLine>,
    );
  if (host)
    readLines.push(
      <ReadLine
        key="link"
        icon={<FileText size={20} strokeWidth={1.75} />}
        title={t("sources.savedFrom", {
          host,
          date: listed?.fetchedAt ? dayText(listed.fetchedAt) : "—",
        })}
      />,
    );

  const bookLine = meta.data
    ? [
        meta.data.authors.join(", "),
        meta.data.version ? t("sources.version", { version: meta.data.version }) : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  function topicsLine(exam: Details["exams"][number]): string {
    if (exam.role === "past_paper") return t("sources.panel.pastPaper");
    if (!exam.topics.length) return t("sources.panel.noTopics");
    const names = exam.topics.length > TOP_TOPICS + 1 ? exam.topics.slice(0, TOP_TOPICS) : exam.topics;
    const rest = exam.topics.length - names.length;
    const list = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(
      rest ? [...names, t("sources.panel.moreTopics", { count: rest })] : names,
    );
    return t("sources.panel.topics", { count: exam.topics.length, list });
  }

  return (
    <Drawer
      open={open}
      onClose={close}
      placement="right"
      size={520}
      title={null}
      closable={false}
      aria-labelledby={titleId}
      className="px-source-panel"
      styles={{ body: { padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" } }}
      focusable={{ focusTriggerAfterClose: false }}
      afterOpenChange={(visible) => {
        // The drawer focuses itself as it opens; the row menu's Rename wants the title field instead.
        if (visible) {
          if (renaming) renameField.current?.focus();
          return;
        }
        if (!id) return;
        // Back to the row the panel belongs to, even when the row menu opened it and its item is gone.
        const row = document.querySelector<HTMLElement>(
          `[data-source-id="${CSS.escape(id)}"] .px-source-row-title`,
        );
        // A source removed meanwhile has no row left; the page's visible heading keeps focus from staying on the closed
        // panel. The page can hold an empty, hidden h1 before it, which cannot take focus.
        const target =
          row ??
          Array.from(document.querySelectorAll<HTMLElement>("h1")).find(
            (heading) => heading.textContent?.trim() && heading.getClientRects().length > 0,
          );
        if (target && target !== row && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target?.focus();
        const next = afterClose.current;
        afterClose.current = null;
        next?.();
      }}
    >
      <div className="px-source-panel-head">
        <p className="label ink-muted px-source-kind">
          <KindIcon kind={source?.kind ?? ""} scan={scan} />
          <span>
            {[
              source ? t(`sources.kind.${source.kind}`, { defaultValue: source.kind }) : "",
              data ? t("sources.panel.added", { date: dayText(data.addedAt) }) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </p>
        <span className="px-source-panel-close">
          <IconButton icon="x" variant="ghost" label={t("sources.panel.close")} onClick={close} />
        </span>
        {renaming ? (
          <form
            className="px-source-rename"
            onSubmit={(event) => {
              event.preventDefault();
              void rename();
            }}
          >
            <h2 id={titleId} className="visually-hidden">
              {source?.title ?? t("sources.details")}
            </h2>
            <Input
              autoFocus
              ref={renameField}
              value={title}
              maxLength={300}
              aria-label={t("sources.panel.renameField")}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                // Escape leaves the field and keeps the panel open.
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setRenaming(false);
                  setTitle(source?.title ?? "");
                  setRenameError(null);
                }
              }}
            />
            <Button htmlType="submit" shape="round">
              {t("sources.panel.save")}
            </Button>
            <Button
              shape="round"
              onClick={() => {
                setRenaming(false);
                setTitle(source?.title ?? "");
                setRenameError(null);
              }}
            >
              {t("sources.panel.cancel")}
            </Button>
          </form>
        ) : (
          <div className="px-source-title">
            {/* The heading names the dialog, so the pencil sits beside it rather than in it. */}
            <h2 id={titleId} className="title-2">
              {source?.title ?? t("sources.details")}
            </h2>
            {source ? (
              <IconButton
                icon="pencil-line"
                variant="ghost"
                size="sm"
                label={t("sources.rename")}
                onClick={() => {
                  setTitle(source.title);
                  setRenaming(true);
                }}
              />
            ) : null}
          </div>
        )}
        {renameError ? (
          <div className="px-source-panel-wide">
            <Notice tone="danger">{t(renameError)}</Notice>
          </div>
        ) : null}
        {bookLine ? <p className="small ink-muted px-source-panel-wide">{bookLine}</p> : null}
        <div className="px-source-panel-row">
          <Button
            type="primary"
            shape="round"
            icon={<BookOpen size={18} strokeWidth={1.75} aria-hidden />}
            disabled={!id || gone || (source?.kind === "smartbook" && !chapters.data?.length)}
            onClick={() =>
              openSource(source?.kind === "smartbook" ? { chapter: chapters.data?.[0]?.number } : {})
            }
          >
            {t("components.citation.open")}
          </Button>
          <span className="px-grow" />
          {source ? <SourceStatus status={source.status} /> : null}
        </div>
      </div>
      <div className="px-source-panel-body">
        {details.isError ? (
          <LoadError onRetry={() => void details.refetch()}>{t("sources.panel.loadFailed")}</LoadError>
        ) : !data ? (
          details.isPending && open ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : gone ? (
            <Notice tone="warning">{t("sources.panel.gone")}</Notice>
          ) : null
        ) : (
          <>
            {meta.data && !meta.data.knownSpec ? <Notice tone="warning">{t("sources.specUnknown")}</Notice> : null}
            {facts.length ? (
              <dl className="px-source-facts" style={{ gridTemplateColumns: `repeat(${facts.length}, minmax(0, 1fr))` }}>
                {facts.map((fact) => (
                  <div key={fact.label}>
                    <dt className="label ink-muted">{fact.label}</dt>
                    <dd className="px-source-fact">{fact.value}</dd>
                    {fact.sub ? <dd className="small ink-muted">{fact.sub}</dd> : null}
                  </div>
                ))}
              </dl>
            ) : null}

            {pending && source && listed ? (
              <section className="px-source-sec" aria-labelledby={`${titleId}-read`}>
                <h3 id={`${titleId}-read`} className="body-strong">
                  {t(source.status === "ocr-queued" ? "sources.panel.howReading" : "sources.panel.howRead")}
                </h3>
                <ScanNotice source={listed} quiet />
              </section>
            ) : readLines.length ? (
              <section className="px-source-sec" aria-labelledby={`${titleId}-read`}>
                <h3 id={`${titleId}-read`} className="body-strong">
                  {t("sources.panel.howRead")}
                </h3>
                {pages ? (
                  <>
                    <PageStrip pages={pages} />
                    <p className="small ink-muted px-source-legend" aria-hidden>
                      {textPages > 0 ? (
                        <span>
                          <i />
                          {t("sources.panel.legendText")}
                        </span>
                      ) : null}
                      {pages.ocr.length ? (
                        <span>
                          <i className="is-ocr" />
                          {t("sources.panel.legendOcr")}
                        </span>
                      ) : null}
                      {pages.blank.length ? (
                        <span>
                          <i className="is-blank" />
                          {t("sources.panel.legendBlank")}
                        </span>
                      ) : null}
                    </p>
                  </>
                ) : null}
                <ul className="px-source-reads">{readLines}</ul>
              </section>
            ) : null}

            <section className="px-source-sec" aria-labelledby={`${titleId}-exams`}>
              <div className="px-source-sec-head">
                <h3 id={`${titleId}-exams`} className="body-strong">
                  {t("sources.panel.exams")}
                </h3>
                {data.exams.length ? <span className="meta ink-muted">{data.exams.length}</span> : null}
              </div>
              {data.exams.length ? (
                <ul className="px-source-uses">
                  {data.exams.map((exam) => (
                    <li key={exam.planId}>
                      <GraduationCap size={20} strokeWidth={1.75} aria-hidden />
                      <span className="body-strong">
                        {exam.title}
                        {exam.archived ? <span className="small ink-muted"> · {t("sources.panel.archived")}</span> : null}
                      </span>
                      <span className="small ink-muted">{topicsLine(exam)}</span>
                      {exam.role === "material" ? (
                        <SyllabusLine check={syllabus.data?.find((check) => check.planId === exam.planId)} />
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small ink-muted px-source-empty">
                  <GraduationCap size={20} strokeWidth={1.75} aria-hidden />
                  <span>{t("sources.panel.noExams")}</span>
                </p>
              )}
              {syllabus.data?.some((check) => check.state === "unavailable") ? (
                <p className="small ink-muted px-source-note">{t("sources.syllabusUnavailable")}</p>
              ) : null}
              {source?.status === "ready" && candidates.length ? (
                <Dropdown
                  trigger={["click"]}
                  disabled={adding}
                  menu={{
                    items: candidates.map((plan) => ({ key: plan.id, label: plan.title })),
                    onClick: ({ key }) => void addTo(key),
                  }}
                >
                  <Button
                    shape="round"
                    className="px-source-add"
                    loading={adding}
                    icon={<Plus size={16} strokeWidth={1.75} aria-hidden />}
                  >
                    {t(data.exams.length ? "sources.panel.addToExam" : "sources.panel.addToFirstExam")}
                  </Button>
                </Dropdown>
              ) : null}
              {added ? (
                <p className="small px-source-note" role="status">
                  {t("sources.panel.addedTo", { plan: added })}
                </p>
              ) : null}
              {addError ? <Notice tone="danger">{t(addError)}</Notice> : null}
            </section>

            <section className="px-source-sec" aria-labelledby={`${titleId}-cites`}>
              <div className="px-source-sec-head">
                <h3 id={`${titleId}-cites`} className="body-strong">
                  {t("sources.panel.cites")}
                </h3>
                {data.citations ? (
                  <span className="meta ink-muted">{t("sources.panel.citesTotal", { count: data.citations })}</span>
                ) : null}
              </div>
              {data.citations === 0 && !showAll ? (
                <p className="small ink-muted px-source-empty is-filled">
                  <Quote size={20} strokeWidth={1.75} aria-hidden />
                  <span>{t(pending ? "sources.panel.citesNoneScan" : "sources.panel.citesNone")}</span>
                </p>
              ) : null}
              {shownSections.length ? (
                <ul className="px-source-cites">
                  {shownSections.map((section) => {
                    const name = sectionName(section, t);
                    const where = sectionWhere(section, t);
                    return (
                      <li key={section.section}>
                        <button
                          type="button"
                          onClick={() => openSource({ passageId: section.passageId })}
                        >
                          <span className="px-source-cite-name">
                            <span className="body-strong">{name}</span>
                            {where ? <span className="small ink-muted">{where}</span> : null}
                          </span>
                          <span className="px-source-cite-bar" aria-hidden>
                            <span style={{ width: `${(section.count / most) * 100}%` }} />
                          </span>
                          <span className="meta" aria-hidden>
                            {section.count}
                          </span>
                          <span className="visually-hidden">
                            {t("sources.panel.citesTotal", { count: section.count })}
                          </span>
                          <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {sections.length > shownSections.length || showAll ? (
                <div className="px-source-cites-foot">
                  <span className="small ink-muted">
                    {!showAll && data.citations > 0 && uncited > 0 ? t(pages ? "sources.panel.uncitedPages" : "sources.panel.uncited", { count: uncited }) : ""}
                  </span>
                  <Button type="link" size="small" onClick={() => setShowAll((value) => !value)}>
                    {t(
                      showAll
                        ? "sources.panel.showFewer"
                        : data.citations === 0
                          ? "sources.panel.showSections"
                          : "sources.panel.showAll",
                    )}
                  </Button>
                </div>
              ) : null}
            </section>
          </>
        )}
      </div>
    </Drawer>
  );
}
