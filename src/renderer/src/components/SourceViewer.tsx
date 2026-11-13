import { useQuery } from "@tanstack/react-query";
import type { MenuProps } from "antd";
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { topicTitle } from "@shared/book-text";
import { spokenText } from "@shared/spoken-math";
import { invoke } from "../lib/ipc";
import { useSources } from "../lib/queries";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { MenuButton, useItemMenu } from "./ItemMenu";
import { LoadError } from "./LoadError";
import { Logo } from "./Logo";
import { PdfPasswordDialog } from "./PdfPassword";
import { SelectionMenu } from "./SelectionMenu";
import { clampPage, pageKey, planPanel, type PanelPlan, type PanelSource } from "./sourcePanel";
import type { PdfOutcome } from "./PdfSourcePage";
import "./SourceViewer.css";

const PdfSourcePage = lazy(() => import("./PdfSourcePage"));
// Markdown and math load only when the panel first shows text.
let markdown: typeof import("./MarkdownView") | undefined;
const loadMarkdown = async () => (markdown ??= await import("./MarkdownView"));

/** Where a source opens: at a cited passage, or at a source's start (its chapter or paragraph for a free book). */
export type SourceLocation = { passageId?: string; sourceId?: string; chapter?: number; paragraph?: string };
/** The actions on the file, the same menu its cover in the Library has, read each time the panel draws its head. */
export type SourceMenu = () => { items: NonNullable<MenuProps["items"]>; onSelect: (key: string) => void } | null;
type Opening = SourceLocation & { back?: () => void; menu?: SourceMenu };

const eventName = "pyxis:source-viewer";
const closeName = "pyxis:source-viewer-close";

/**
 * Opens the source panel at a passage or a source. A second call moves the open panel to the new place; it never opens
 * another. `back`, when the panel was opened from another panel (the source details), adds a way back to it, and `menu`
 * gives the panel the file's own menu.
 */
export function openSourceViewer(location: SourceLocation, options?: (() => void) | { back?: () => void; menu?: SourceMenu }): void {
  const extra = typeof options === "function" ? { back: options } : (options ?? {});
  window.dispatchEvent(new CustomEvent(eventName, { detail: { ...location, ...extra } }));
}

/** Closes the panel, as when the file's details take its place. */
export function closeSourceViewer(): void {
  window.dispatchEvent(new CustomEvent(closeName));
}

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The panel's head (the file's name and what it is, its menu, the close button, the way back) and its body (the paging
 * row with "Apri il file", the page, and the cited passage when the page can't mark it). The window's panel shows them
 * beside the page, and the map page in its own side panel. `location` null shows nothing and reads nothing.
 */
export function useSourceView(
  location: SourceLocation | null,
  props: { titleId: string; onClose: () => void; onBack?: () => void; menu?: SourceMenu; openKey?: number },
): { head: ReactNode; body: ReactNode } {
  const { t } = useTranslation();
  const source = useQuery({
    queryKey: ["source-panel", location],
    enabled: location != null,
    queryFn: () => invoke("sources.panel", { sourceId: location?.sourceId, passageId: location?.passageId }),
  });
  const sources = useSources(location != null);
  // A file renamed, removed or read again while the panel shows it: the panel reads it again, on the same page.
  const listedAt = sources.dataUpdatedAt;
  const refetch = source.refetch;
  useEffect(() => {
    if (listedAt) void refetch();
  }, [listedAt, refetch]);
  const view = source.data ?? null;
  const listed = view ? sources.data?.find((row) => row.id === view.sourceId) : undefined;
  const menu = props.menu?.() ?? null;
  const what = [listed ? t(`sources.fileKind.${listed.fileKind}`) : null, view?.passage?.sectionPath].filter(Boolean).join(" · ");
  const title = view?.title ?? (source.isPending ? "" : t("sources.details"));
  const menuProps: MenuProps = { items: menu?.items ?? [], onClick: ({ key }) => menu?.onSelect(key) };
  const itemMenu = useItemMenu({ menu: menuProps, disabled: !menu });
  const head = (
    <div className="source-viewer-head" {...itemMenu.bind}>
      <div className="source-viewer-row">
        <h2 id={props.titleId} className="source-viewer-title" tabIndex={-1} title={title}>
          {title}
        </h2>
        {menu ? <MenuButton menu={menuProps} label={t("sources.viewer.actions", { title })} size="sm" /> : null}
        <span className="source-viewer-close">
          <IconButton icon="x" variant="ghost" size="sm" label={t("nav.close")} onClick={props.onClose} />
        </span>
      </div>
      {what ? <div className="source-viewer-what">{what}</div> : null}
      {props.onBack ? (
        <button type="button" className="source-viewer-back" onClick={props.onBack}>
          <Icon name="arrow-left" size={16} />
          {t("sources.viewer.backToDetails")}
        </button>
      ) : null}
      {itemMenu.popup}
    </div>
  );
  const body = !location ? null : source.isError ? (
    <div className="source-view-page">
      <LoadError onRetry={() => void source.refetch()}>{t("sources.viewerFailed")}</LoadError>
    </div>
  ) : !view ? (
    source.isPending ? (
      <div className="source-view-page">
        <PagePlaceholder />
      </div>
    ) : (
      <div className="source-view-page">
        <Message reason="removed" />
      </div>
    )
  ) : (
    <SourceBody key={`${props.openKey ?? 0}:${view.sourceId}:${view.passage?.id ?? ""}`} location={location} source={view} onClose={props.onClose} />
  );
  return { head, body };
}

/** The page's shape while what goes in it loads: a sheet with the working mark, shown only after a short wait. */
function PagePlaceholder({ label }: { label?: string }) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="source-paper source-paper-waiting" aria-busy>
      {show ? (
        <div className="source-page-working">
          <Logo working decorative size={44} />
          <span>{label ?? t("sources.viewer.opening")}</span>
        </div>
      ) : null}
    </div>
  );
}

function SourceBody({ location, source, onClose }: { location: SourceLocation; source: PanelSource; onClose: () => void }) {
  const { t } = useTranslation();
  const plan = planPanel(source, { chapter: location.chapter });
  const [page, setPage] = useState(plan.start);
  const [count, setCount] = useState<number | null>(plan.count);
  const [pdfProblem, setPdfProblem] = useState<"locked" | "missing" | "failed" | null>(null);
  const [marked, setMarked] = useState<boolean | null>(null);
  const [scan, setScan] = useState(false);
  const [said, setSaid] = useState("");
  const [openFailed, setOpenFailed] = useState(false);
  const chapters = useQuery({
    queryKey: ["source-chapters", source.sourceId],
    enabled: plan.unit === "chapter",
    queryFn: () => invoke("sources.chapters", { sourceId: source.sourceId }),
  });
  const total = plan.unit === "chapter" ? (chapters.data?.length || null) : count;
  const where = { sourceId: location.passageId ? undefined : source.sourceId, passageId: location.passageId };
  const citedAt = plan.unit === "slide" ? source.passage?.slide : plan.unit === "chapter" ? source.passage?.chapter : source.passage?.page;
  // A citation to a page the file no longer has: the last page, and a line that says so.
  const gone = plan.unit === "page" && total !== null && plan.start > total;
  const go = useCallback(
    (next: number) => {
      setPage((current) => {
        const target = clampPage(next, total);
        if (target === current) return current;
        setSaid(unitName(t, plan.unit, target, total));
        return target;
      });
    },
    [total, plan.unit, t],
  );
  useEffect(() => {
    if (total !== null && page > total) setPage(total);
  }, [total, page]);
  const outcome = useCallback((result: PdfOutcome) => {
    if ("count" in result) setCount(result.count);
    else setPdfProblem(result.error);
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!plan.unit || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true'], .px-item-menu")) return;
    const step = pageKey(event.key);
    if (step === null) return;
    // Home and End scroll text; they turn pages only on the paging row.
    if ((step === "first" || step === "last") && !target.closest(".source-nav")) return;
    event.preventDefault();
    go(step === "first" ? 1 : step === "last" ? (total ?? page) : page + step);
  };
  async function openFile() {
    setOpenFailed(false);
    const ok = await window.pyxis.openSourceFile(source.sourceId).catch(() => false);
    if (!ok) setOpenFailed(true);
  }
  const problem = pdfProblem === "locked" ? "locked" : pdfProblem === "missing" ? "missing" : null;
  const body = problem ? ({ show: "message", reason: problem } as const) : plan.body;
  const showPassage =
    source.passage !== null &&
    (body.show === "message" ||
      pdfProblem === "failed" ||
      (body.show === "pdf" && page === citedAt && marked === false && !scan) ||
      gone);
  return (
    <div className="source-view" onKeyDown={onKeyDown}>
      {plan.unit || plan.openFile || plan.address ? (
        <div className="source-nav">
          {plan.unit && body.show !== "message" ? (
            <Paging unit={plan.unit} page={page} total={total} onGo={go} />
          ) : (
            <span className="source-nav-grow" />
          )}
          {plan.openFile && body.show !== "message" ? (
            <Button variant="ghost" size="sm" icon="external-link" onClick={() => void openFile()} title={t("sources.viewer.openFileHint")}>
              {t("sources.viewer.openFile")}
            </Button>
          ) : null}
          {plan.address ? (
            <Button variant="ghost" size="sm" icon="external-link" onClick={() => void window.pyxis.openExternal(plan.address!)} title={plan.address}>
              {t("sources.viewer.openPage")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="visually-hidden" aria-live="polite">
        {said}
      </div>
      <div className="source-view-page" tabIndex={0} aria-label={t("sources.viewer.pageArea")}>
        {openFailed ? <p className="source-view-note is-problem" role="alert">{t("sources.viewer.openFileFailed")}</p> : null}
        {plan.changed && body.show !== "message" ? <p className="source-view-note">{t("sources.viewer.changed")}</p> : null}
        {gone ? <p className="source-view-note">{t("sources.viewer.pageGone", { page: plan.start, count: total })}</p> : null}
        {plan.reading && body.show !== "message" ? (
          <p className="source-view-note">
            <Logo working decorative size={18} />
            {t("sources.viewer.stillReading")}
          </p>
        ) : null}
        {body.show === "pdf" ? (
          <>
            <Suspense fallback={<PagePlaceholder />}>
              <PdfSourcePage
                where={where}
                page={page}
                excerpt={source.passage?.text ?? null}
                citedPage={source.passage?.page ?? null}
                onOutcome={outcome}
                onScan={setScan}
                onMarked={setMarked}
              />
            </Suspense>
            {pdfProblem === "failed" ? <p className="source-view-note is-problem">{t("sources.pdfFailed")}</p> : null}
            {source.passage && page === source.passage.page && marked ? (
              <p className="visually-hidden">{t("sources.viewer.citedHere", { text: source.passage.text })}</p>
            ) : null}
            {scan ? <ReadText where={where} unit="page" n={page} cited={page === citedAt} /> : null}
          </>
        ) : body.show === "image" ? (
          <ImageView source={source} where={where} />
        ) : body.show === "text" ? (
          <TextView location={location} source={source} plan={plan} page={page} onClose={onClose} />
        ) : (
          <Message reason={body.reason} source={source} />
        )}
        {showPassage && source.passage ? <CitedPassage text={source.passage.text} section={source.passage.sectionPath} /> : null}
      </div>
      {plan.address ? (
        <div className="source-view-foot">
          {t("sources.viewer.savedFrom")} <span className="source-view-address">{plan.address}</span>
        </div>
      ) : null}
    </div>
  );
}

function unitName(t: (key: string, options?: Record<string, unknown>) => string, unit: PanelPlan["unit"], n: number, total: number | null) {
  const key = unit === "slide" ? "slide" : unit === "chapter" ? "chapter" : "page";
  return total ? t(`sources.viewer.${key}Of`, { page: n, count: total }) : t(`sources.viewer.${key}`, { page: n });
}

/** The arrows and the page number, which can be typed over to jump. */
function Paging({ unit, page, total, onGo }: { unit: NonNullable<PanelPlan["unit"]>; page: number; total: number | null; onGo: (n: number) => void }) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState<string | null>(null);
  const key = unit === "slide" ? "Slide" : unit === "chapter" ? "Chapter" : "Page";
  const commit = () => {
    if (typed !== null && typed.trim()) onGo(Number(typed));
    setTyped(null);
  };
  return (
    <>
      <IconButton icon="chevron-left" variant="ghost" size="sm" label={t(`sources.viewer.previous${key}`)} onClick={() => onGo(page - 1)} disabled={page <= 1} />
      <label className="source-nav-page">
        <span className="visually-hidden">{t(`sources.viewer.goTo${key}`)}</span>
        <span aria-hidden>{t(`sources.viewer.${unit}Word`)}</span>
        <input
          inputMode="numeric"
          className="source-nav-field"
          value={typed ?? String(page)}
          size={Math.max(1, String(typed ?? page).length)}
          onChange={(event) => setTyped(event.target.value.replace(/\D/g, ""))}
          onFocus={(event) => event.target.select()}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape" && typed !== null) {
              event.stopPropagation();
              setTyped(null);
            }
          }}
        />
        {total ? <span className="source-nav-total">{t("sources.viewer.ofCount", { count: total })}</span> : null}
      </label>
      <IconButton
        icon="chevron-right"
        variant="ghost"
        size="sm"
        label={t(`sources.viewer.next${key}`)}
        onClick={() => onGo(page + 1)}
        disabled={total !== null && page >= total}
      />
      <span className="source-nav-grow" />
    </>
  );
}

/** The cited passage's own words, for when the page can't show and mark it. */
function CitedPassage({ text, section }: { text: string; section: string | null }) {
  const { t } = useTranslation();
  return (
    <section className="source-cited" aria-label={t("sources.viewer.cited")}>
      <h3 className="source-cited-head">
        {t("sources.viewer.cited")}
        {section ? <span className="source-cited-where"> · {section}</span> : null}
      </h3>
      <p className="source-cited-text">{text}</p>
    </section>
  );
}

/** Why the file can't be shown now, and the way out when there is one. */
function Message({ reason, source }: { reason: "missing" | "removed" | "locked" | "reading" | "failed"; source?: PanelSource }) {
  const { t } = useTranslation();
  const [unlocking, setUnlocking] = useState(false);
  const linked = source?.original === null && source.missing;
  const titleKey = reason === "removed" ? "sources.panel.gone" : `sources.viewer.${reason}Title`;
  const bodyKey = reason === "missing" && source && !linked ? "sources.viewer.missingStored" : `sources.viewer.${reason}Body`;
  return (
    <div className="source-message" role="status">
      {reason === "reading" ? <Logo working decorative size={44} /> : <Icon name={reason === "locked" ? "lock" : "circle-alert"} size={22} />}
      <h3 className="source-message-title">{t(titleKey)}</h3>
      <p className="source-message-body">{t(bodyKey)}</p>
      {reason === "locked" && source?.errorJobId ? (
        <>
          <Button variant="secondary" size="sm" onClick={() => setUnlocking(true)}>
            {t("sources.pdfPassword.enter")}
          </Button>
          <PdfPasswordDialog target={unlocking ? { jobId: source.errorJobId, title: source.title } : null} onClose={() => setUnlocking(false)} />
        </>
      ) : null}
    </div>
  );
}

/** The text Pyxis read from a page or a slide: under a scan's picture, or as the slide itself. */
function ReadText({ where, unit, n, cited }: { where: { sourceId?: string; passageId?: string }; unit: "page" | "slide"; n: number; cited: boolean }) {
  const { t } = useTranslation();
  const rows = useQuery({ queryKey: ["source-panel-page", where, unit, n], queryFn: () => invoke("sources.panelPage", { ...where, unit, n }) });
  return (
    <details className="source-read" open={cited}>
      <summary>{t("sources.viewer.readText")}</summary>
      {rows.data?.length ? (
        rows.data.map((row) => (
          <p key={row.id} className={row.current ? "source-read-line is-current" : "source-read-line"}>
            {row.text}
          </p>
        ))
      ) : rows.isSuccess ? (
        <p className="source-read-line">{t("sources.viewer.noReadText")}</p>
      ) : null}
    </details>
  );
}

/** A photo or an image file, drawn from its original, with the text read from it under it. */
function ImageView({ source, where }: { source: PanelSource; where: { sourceId?: string; passageId?: string } }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let made: string | null = null;
    void (async () => {
      const parts: Uint8Array[] = [];
      let size = Infinity;
      for (let start = 0; start < size; ) {
        const chunk = await invoke("sources.readOriginal", { ...where, start, length: 2 * 1024 * 1024 });
        size = chunk.size;
        if (!chunk.bytes.length) break;
        parts.push(chunk.bytes);
        start += chunk.bytes.length;
      }
      if (disposed) return;
      made = URL.createObjectURL(new Blob(parts as BlobPart[], { type: source.mime ?? "image/jpeg" }));
      setUrl(made);
    })().catch(() => !disposed && setFailed(true));
    return () => {
      disposed = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [where.sourceId, where.passageId, source.mime]);
  const text = useQuery({
    queryKey: ["source-panel-text", source.sourceId],
    queryFn: () => invoke("sources.chapter", { sourceId: source.sourceId, chapter: 0 }),
  });
  return (
    <>
      {failed ? (
        <Message reason="missing" source={source} />
      ) : url ? (
        <img className="source-image" src={url} alt={source.title} />
      ) : (
        <PagePlaceholder />
      )}
      <details className="source-read" open={Boolean(source.passage)}>
        <summary>{t("sources.viewer.readTextPhoto")}</summary>
        {text.data?.length ? (
          text.data.map((row) => (
            <p key={row.id} className={row.id === source.passage?.id ? "source-read-line is-current" : "source-read-line"}>
              {row.text}
            </p>
          ))
        ) : text.isSuccess ? (
          <p className="source-read-line">{t("sources.viewer.noReadText")}</p>
        ) : null}
      </details>
    </>
  );
}

/** What Pyxis read, laid out on a sheet: a free book's chapter, a slide, a Word file, notes or a saved web page. */
function TextView({ location, source, plan, page, onClose }: { location: SourceLocation; source: PanelSource; plan: PanelPlan; page: number; onClose: () => void }) {
  const { t } = useTranslation();
  const holder = useRef<HTMLDivElement>(null);
  const [markdownReady, setMarkdownReady] = useState(markdown != null);
  useEffect(() => {
    if (!markdownReady) void loadMarkdown().then(() => setMarkdownReady(true));
  }, [markdownReady]);
  const passageId = location.passageId;
  const rows = useQuery({
    queryKey: ["source-panel-text", source.sourceId, plan.unit, page, passageId, location.chapter, location.paragraph],
    queryFn: async () => {
      if (plan.unit === "page" || plan.unit === "slide") {
        const lines = await invoke("sources.panelPage", { sourceId: passageId ? undefined : source.sourceId, passageId, unit: plan.unit, n: page });
        return lines.map((line) => ({ id: line.id, text: line.text, current: line.current }));
      }
      // The cited chapter of a free book, or the version the citation came from, as before; the whole text otherwise.
      if (passageId && (source.changed || (plan.unit === "chapter" && page === plan.start)))
        return (await invoke("sources.passage", { passageId })).map((row) => ({ id: row.id, text: row.text, current: row.current }));
      const all = await invoke("sources.chapter", {
        sourceId: source.sourceId,
        chapter: plan.unit === "chapter" ? page : (location.chapter ?? 0),
        paragraph: location.paragraph,
      });
      return all.map((row) => ({ id: row.id, text: row.text, current: row.current || row.id === passageId }));
    },
  });
  const list = rows.data ?? [];
  useEffect(() => {
    holder.current?.querySelector(".is-current")?.scrollIntoView({ block: "center" });
  }, [rows.data, markdownReady]);
  const own = plan.body.show === "text" ? plan.body.ownApp : null;
  return (
    <>
      {own ? <p className="source-view-note">{t(own === "slides" ? "sources.viewer.ownAppSlides" : "sources.viewer.ownApp")}</p> : null}
      {rows.isError ? <LoadError onRetry={() => void rows.refetch()}>{t("sources.viewerFailed")}</LoadError> : null}
      {rows.isPending || !markdownReady ? (
        <PagePlaceholder />
      ) : (
        <SelectionMenu
          sourceIds={[source.sourceId]}
          passageIds={list.map((row) => row.id)}
          onAsk={(chatId) => {
            onClose();
            window.location.hash = `/ask/${chatId}`;
          }}
        >
          <div ref={holder} className="source-paper source-viewer-chapter">
            {list.length === 0 && rows.isSuccess ? <p className="source-read-line">{t("sources.viewer.noReadText")}</p> : null}
            {list.map((row) => (
              <section
                key={row.id}
                className={row.current ? "source-viewer-paragraph is-current" : "source-viewer-paragraph"}
                aria-label={row.current ? t("sources.viewer.cited") : spokenText(topicTitle(row.text, 70)) || undefined}
              >
                {markdown ? <markdown.MarkdownView>{row.text}</markdown.MarkdownView> : null}
              </section>
            ))}
          </div>
        </SelectionMenu>
      )}
    </>
  );
}

/**
 * The source panel: beside the page on a wide window, over its right side on a narrow one, and never over Attività. It
 * grows from what opened it, takes the focus, and gives it back when it closes with Escape or its close button. Going to
 * another page closes it, since it belongs to the page that opened it.
 */
export function SourceViewer({ watch }: { watch?: (listener: () => void) => () => void } = {}) {
  const [opening, setOpening] = useState<(Opening & { key: number }) | null>(null);
  const [leaving, setLeaving] = useState(false);
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const grownFrom = useRef<DOMRect | null>(null);
  const counter = useRef(0);
  const shownAt = useRef<string | null>(null);
  const leavingAnimation = useRef<Animation | null>(null);
  const overDialog = useRef(false);
  useEffect(() => {
    const open = (event: Event) => {
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && panel.current?.contains(active);
      // A source opened from inside the panel keeps the first opener, so closing goes back to where it all started.
      if (!inside) {
        trigger.current = active instanceof HTMLElement && active !== document.body ? active : null;
        grownFrom.current = trigger.current?.getBoundingClientRect() ?? null;
      }
      counter.current += 1;
      shownAt.current = pathOf(window.location.hash);
      // Opened from a dialog (a citation in "Crea flashcard"), it sits over that dialog, as what was opened last.
      overDialog.current = active instanceof Element && active.closest(".ant-modal-wrap, .ant-drawer") !== null;
      // A panel on its way out comes back for the new source.
      leavingAnimation.current?.cancel();
      leavingAnimation.current = null;
      setLeaving(false);
      setOpening({ ...(event as CustomEvent<Opening>).detail, key: counter.current });
    };
    // Both end the panel at once; an exit still running then gives the focus to nothing.
    const shut = () => {
      counter.current += 1;
      setOpening(null);
    };
    const leave = () => {
      if (shownAt.current !== null && pathOf(window.location.hash) !== shownAt.current) {
        trigger.current = null;
        shut();
      }
    };
    window.addEventListener(eventName, open);
    window.addEventListener(closeName, shut);
    window.addEventListener("popstate", leave);
    window.addEventListener("hashchange", leave);
    // The router moves between pages without either event, so it says when it did.
    const unwatch = watch?.(leave);
    return () => {
      window.removeEventListener(eventName, open);
      window.removeEventListener(closeName, shut);
      window.removeEventListener("popstate", leave);
      window.removeEventListener("hashchange", leave);
      unwatch?.();
    };
  }, [watch]);
  const isOpen = opening !== null;
  useEffect(() => {
    const root = document.documentElement;
    if (isOpen) root.dataset.sourcePanel = "open";
    else delete root.dataset.sourcePanel;
    return () => {
      delete root.dataset.sourcePanel;
    };
  }, [isOpen]);
  // It grows out of the chip, cover or row that opened it, and takes the focus. A panel already open moves to the new
  // place without growing again.
  const firstKey = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!opening || !element) {
      firstKey.current = null;
      return;
    }
    if (firstKey.current !== null) {
      element.querySelector<HTMLElement>(".source-viewer-title")?.focus({ preventScroll: true });
      return;
    }
    firstKey.current = opening.key;
    element.querySelector<HTMLElement>(".source-viewer-title")?.focus({ preventScroll: true });
    const from = grownFrom.current;
    const box = element.getBoundingClientRect();
    if (reduced()) {
      element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear" });
    } else {
      const origin = from ? `${from.left + from.width / 2 - box.left}px ${from.top + from.height / 2 - box.top}px` : "100% 50%";
      element.animate(
        [
          { opacity: 0, transform: "scale(0.94)", transformOrigin: origin },
          { opacity: 1, transform: "none", transformOrigin: origin },
        ],
        { duration: 320, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
      );
    }
  }, [opening]);
  const close = useCallback(() => {
    const element = panel.current;
    const back = trigger.current;
    const closing = counter.current;
    trigger.current = null;
    // The exit ends this opening only: a source opened while it ran keeps its panel, and keeps the focus.
    const done = () => {
      if (counter.current !== closing) return;
      setOpening(null);
      setLeaving(false);
      if (back?.isConnected) back.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>("main h1, h1")?.focus({ preventScroll: true });
    };
    if (!element) return done();
    setLeaving(true);
    const out = reduced()
      ? element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120 })
      : element.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(16px)" }], {
          duration: 220,
          easing: "cubic-bezier(0.23, 1, 0.32, 1)",
        });
    leavingAnimation.current = out;
    out.onfinish = done;
    out.oncancel = done;
  }, []);
  // Back to the details panel that opened the viewer: it opens itself, so focus is not pulled to the row behind it.
  const goBack = opening?.back
    ? () => {
        const back = opening.back!;
        trigger.current = null;
        setOpening(null);
        back();
      }
    : undefined;
  const view = useSourceView(opening, { titleId, onClose: close, onBack: goBack, menu: opening?.menu, openKey: opening?.key });
  if (!opening) return null;
  return (
    <aside
      ref={panel}
      className={["source-panel", leaving && "is-leaving", overDialog.current && "is-over-dialog"].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if ((event.target as HTMLElement).closest(".px-item-menu, .ant-modal")) return;
        event.preventDefault();
        close();
      }}
    >
      {view.head}
      {view.body}
    </aside>
  );
}

/** The page part of the address, without its query: a passage chosen on the same page does not count as leaving it. */
function pathOf(hash: string): string {
  return hash.split("?")[0] ?? "";
}
