import { useQuery } from "@tanstack/react-query";
import { Button, Drawer, Skeleton } from "antd";
import { ArrowLeft } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../lib/ipc";
import { LoadError } from "./LoadError";
import { SelectionMenu } from "./SelectionMenu";
import "./SourceViewer.css";

const PdfSourcePage = lazy(() => import("./PdfSourcePage"));
// The viewer is mounted with the window, but Markdown and math load only when it first opens. The drawer opens at
// once all the same: opening it later would let another dialog take focus first, and closing it would not return
// focus to the citation.
let markdown: typeof import("./MarkdownView") | undefined;
const loadMarkdown = async () => (markdown ??= await import("./MarkdownView"));

type SourceLocation = { passageId?: string; sourceId?: string; chapter?: number; paragraph?: string };
const eventName = "pyxis:source-viewer";
/** `back`, when the viewer was opened from another panel (the source details), adds a way back to it. */
export function openSourceViewer(location: SourceLocation, back?: () => void): void {
  window.dispatchEvent(new CustomEvent(eventName, { detail: back ? { ...location, back } : location }));
}

export function SourceViewer() {
  const { t } = useTranslation();
  const [location, setLocation] = useState<SourceLocation | null>(null);
  const [back, setBack] = useState<(() => void) | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const [markdownReady, setMarkdownReady] = useState(markdown != null);
  useEffect(() => {
    const open = (event: Event) => {
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const { back: backTo, ...place } = (event as CustomEvent<SourceLocation & { back?: () => void }>).detail;
      setLocation(place);
      setBack(backTo ? () => backTo : null);
      if (!markdown) void loadMarkdown().then(() => setMarkdownReady(true));
    };
    window.addEventListener(eventName, open);
    return () => window.removeEventListener(eventName, open);
  }, []);
  const passages = useQuery({
    queryKey: ["viewer", location], enabled: location != null,
    queryFn: async () => location?.passageId
      ? invoke("sources.passage", { passageId: location.passageId })
      : invoke("sources.chapter", { sourceId: location?.sourceId ?? "", chapter: location?.chapter ?? 0, paragraph: location?.paragraph }),
  });
  const source = useQuery({ queryKey: ["viewer-document", location], queryFn: () => invoke("sources.viewerDocument", location ?? {}), enabled: location != null });
  const rows = passages.data ?? [];
  const current = rows.find((row) => row.current) ?? rows[0];
  const sourceId = location?.sourceId ?? (current && "sourceId" in current ? current.sourceId : undefined);
  const title = source.data?.title ?? t("exams.sources");
  useEffect(() => {
    body.current?.querySelector(".is-current")?.scrollIntoView({ block: "center" });
  }, [passages.data, markdownReady]);
  function close(): void {
    setLocation(null);
  }
  // Back to the panel that opened the viewer: it opens itself, so focus is not pulled to the row behind it.
  function goBack(): void {
    trigger.current = null;
    setLocation(null);
    back?.();
  }
  return (
    <Drawer open={location != null} onClose={close} placement="right" size="min(560px, calc(100vw - 80px))"
      title={<div>
        {back ? <Button type="text" size="small" shape="round" className="source-viewer-back" icon={<ArrowLeft size={16} aria-hidden />} onClick={goBack}>{t("sources.viewerBack")}</Button> : null}
        <span>{title}</span><div className="meta source-viewer-locator">{current?.sectionPath}</div></div>}
      afterOpenChange={(open) => { if (!open) trigger.current?.focus(); }}>
      {passages.isPending || (!markdownReady && source.data?.kind !== "pdf") ? <Skeleton active /> : null}
      {passages.isError || source.isError ? (
        <LoadError onRetry={() => void Promise.all([passages.isError ? passages.refetch() : null, source.isError ? source.refetch() : null])}>
          {t("sources.viewerFailed")}
        </LoadError>
      ) : null}
      <SelectionMenu sourceIds={sourceId ? [sourceId] : []} passageIds={rows.map((row) => row.id)} onAsk={(chatId) => { close(); window.location.hash = `/ask/${chatId}`; }}>
      <div ref={body} className="source-viewer-chapter">
        {source.data?.kind === "pdf" && source.data.blobSha ?
          <Suspense fallback={<Skeleton active />}><PdfSourcePage sha={source.data.blobSha} initialPage={current?.locator.page ?? 1} excerpt={source.data.excerpt ?? current?.text ?? ""} /></Suspense>
          : rows.map((row) => <section key={row.id} className={row.current ? "source-viewer-paragraph is-current" : "source-viewer-paragraph"}
          aria-label={row.locator.paragraph}>
          {markdownReady && markdown ? <markdown.MarkdownView>{row.text}</markdown.MarkdownView> : null}
        </section>)}
      </div>
      </SelectionMenu>
    </Drawer>
  );
}
