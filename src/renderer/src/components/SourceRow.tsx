import { Button, Dropdown, type MenuProps } from "antd";
import {
  AlertCircle,
  BookMarked,
  CheckCircle2,
  ChevronRight,
  FileText,
  MoreHorizontal,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useJobs } from "../features/jobs/queries";
import { i18n } from "../locales/i18n";
import "./SourceRow.css";
import { formatBytes } from "@shared/format-bytes";
import { Logo } from "./Logo";

export const sizeText = (bytes: number) => formatBytes(bytes, i18n.language);

const PROBLEM = new Set(["failed", "needs-ocr", "interrupted", "cancelled"]);

/** The parts of a source a row shows. Whatever a caller does not know is left out of the meta line. */
export type SourceRowData = {
  id: string;
  title: string;
  kind: string;
  status: string;
  bytes?: number | null;
  sections?: number;
  planCount?: number;
  /** The subject the source belongs to, such as one found from a linked folder. */
  subject?: string | null;
  /** The job reading this scan, whose progress the row shows. */
  scanJobId?: string;
};

/** How far a scan's reading is. Only a row being read renders it, so the other rows skip job updates. */
function ScanPercent({ jobId }: { jobId: string }) {
  const { data: jobs = [] } = useJobs();
  const job = jobs.find((item) => item.id === jobId);
  if (!job || job.state !== "running") return null;
  return <> · {Math.round(job.progress * 100)}%</>;
}

/** One source in a list: the Library and a plan's Sources tab show the same row. */
export function SourceRow(props: {
  source: SourceRowData;
  /** Opens the source. Without it the title is plain text. */
  onOpen?: () => void;
  selected?: boolean;
  /** A class for a passing state, such as a row that just landed in its list. */
  className?: string;
  /** Shown in place of the state, such as the subject picker of a file waiting for one. */
  aside?: ReactNode;
  /** Lines under the meta line, such as a failed import's reason or a new book version. */
  notes?: ReactNode;
  actions: {
    items: NonNullable<MenuProps["items"]>;
    onSelect: (key: string) => void;
    disabled?: boolean;
  };
}) {
  const { t } = useTranslation();
  const { source } = props;
  const meta = [
    t(`sources.kind.${source.kind}`, { defaultValue: source.kind }),
    source.subject ?? null,
    source.sections == null
      ? null
      : t("sources.sectionCount", { count: source.sections }),
    source.bytes == null ? null : sizeText(source.bytes),
    source.planCount ? t("sources.usedIn", { count: source.planCount }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const problem = PROBLEM.has(source.status);
  return (
    <li
      className={["px-source-row", props.selected ? "is-selected" : "", props.className ?? ""].filter(Boolean).join(" ")}
      data-source-id={source.id}
    >
      <span className="px-source-row-icon" aria-hidden>
        {source.kind === "smartbook" ? (
          <BookMarked size={18} strokeWidth={1.75} />
        ) : (
          <FileText size={18} strokeWidth={1.75} />
        )}
      </span>
      <div className="px-source-row-main">
        {props.onOpen ? (
          // One control for the whole row: its ::after covers the row, so the meta line opens it too and the name stays the only tab stop.
          <button
            type="button"
            className="px-source-row-open"
            onClick={props.onOpen}
          >
            <span className="body-strong px-source-row-title">
              {source.title}
            </span>
          </button>
        ) : (
          <span className="body-strong px-source-row-title">
            {source.title}
          </span>
        )}
        <span className="small px-source-row-meta">{meta}</span>
        {props.notes}
      </div>
      {props.aside ?? (
      <span
        className={
          problem
            ? "small px-source-row-status is-problem"
            : "small px-source-row-status"
        }
      >
        {source.status === "ready" ? (
          <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden />
        ) : problem ? (
          <AlertCircle size={16} strokeWidth={1.75} aria-hidden />
        ) : (
          <Logo working decorative size={16} />
        )}
        {t(`sources.status.${source.status}`, { defaultValue: source.status })}
        {source.status === "ocr-queued" && source.scanJobId ? (
          <ScanPercent jobId={source.scanJobId} />
        ) : null}
      </span>
      )}
      <Dropdown
        trigger={["click"]}
        autoFocus
        disabled={props.actions.disabled}
        popupRender={(menu) => (
          <div role="region" aria-label={t("sources.actionsColumn")}>
            {menu}
          </div>
        )}
        menu={{
          items: props.actions.items,
          // A submenu's arrow is drawn, not read: its title is named by its label alone.
          expandIcon: <ChevronRight size={14} strokeWidth={1.75} aria-hidden className="px-source-row-submenu" />,
          onClick: ({ key }) => props.actions.onSelect(key),
        }}
      >
        <Button
          type="text"
          shape="circle"
          disabled={props.actions.disabled}
          aria-label={t("sources.actionsFor", { title: source.title })}
          icon={<MoreHorizontal size={18} strokeWidth={1.75} />}
        />
      </Dropdown>
    </li>
  );
}
