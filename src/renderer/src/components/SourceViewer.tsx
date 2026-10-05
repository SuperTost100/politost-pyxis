import { useQuery } from "@tanstack/react-query";
import { Drawer, Skeleton } from "antd";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../lib/ipc";
import { MarkdownView } from "./MarkdownView";
import { Notice } from "./Notice";
import { SelectionMenu } from "./SelectionMenu";
import "./SourceViewer.css";

const PdfSourcePage = lazy(() => import("./PdfSourcePage"));

type SourceLocation = { passageId?: string; sourceId?: string; chapter?: number; paragraph?: string };
const eventName = "pyxis:source-viewer";
export function openSourceViewer(location: SourceLocation): void {
  window.dispatchEvent(new CustomEvent(eventName, { detail: location }));
}

export function SourceViewer() {
  const { t } = useTranslation();
  const [location, setLocation] = useState<SourceLocation | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setLocation((event as CustomEvent<SourceLocation>).detail);
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
  }, [passages.data]);
  function close(): void {
    setLocation(null);
  }
  return (
    <Drawer open={location != null} onClose={close} placement="right" size="min(560px, calc(100vw - 80px))"
      title={<div><span>{title}</span><div className="meta source-viewer-locator">{current?.sectionPath}</div></div>}
      afterOpenChange={(open) => { if (!open) trigger.current?.focus(); }}>
      {passages.isPending ? <Skeleton active /> : null}
      {passages.isError ? <Notice tone="danger">{t("sources.importFailed")}</Notice> : null}
      <SelectionMenu sourceIds={sourceId ? [sourceId] : []} onAsk={(chatId) => { close(); window.location.hash = `/ask/${chatId}`; }}>
      <div ref={body} className="source-viewer-chapter">
        {source.data?.kind === "pdf" && source.data.blobSha ?
          <Suspense fallback={<Skeleton active />}><PdfSourcePage sha={source.data.blobSha} initialPage={current?.locator.page ?? 1} excerpt={source.data.excerpt ?? current?.text ?? ""} /></Suspense>
          : rows.map((row) => <section key={row.id} className={row.current ? "source-viewer-paragraph is-current" : "source-viewer-paragraph"}
          aria-label={row.locator.paragraph}>
          <MarkdownView>{row.text}</MarkdownView>
        </section>)}
      </div>
      </SelectionMenu>
    </Drawer>
  );
}
