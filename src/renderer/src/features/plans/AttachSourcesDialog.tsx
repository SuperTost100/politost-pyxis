import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Table } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "../../components/Dialog";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";
import { pastPapersQuery, sourcesQuery } from "../../lib/queries";
import { refreshPlan } from "../../lib/refreshPlan";
import { attachableSources, sourcesUnreadable } from "./examSettingsData";
import { LibraryPanel } from "../home/LibraryPanel";

/**
 * Picks library sources to add to a plan, or imports a new one first. The exam's Sources tab and its settings page
 * open the same dialog. Sources already in the plan, and those it uses as past papers, are not offered.
 */
export function AttachSourcesDialog({
  planId,
  attached,
  open,
  onClose,
}: {
  planId: string;
  /** IDs of the sources the plan already has. */
  attached: string[];
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const library = useQuery({ ...sourcesQuery, enabled: open, refetchInterval: open ? 1000 : false });
  const pastPapers = useQuery({ ...pastPapersQuery(planId), enabled: open && !!planId });
  const [selected, setSelected] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const offered = attachableSources(library.data, attached, pastPapers.data);
  // A source that stops being offered (attached meanwhile, or made a past paper) drops out of the selection.
  const picked = selected.filter((id) => offered.some((source) => source.id === id));
  async function attach() {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await invoke("plans.attachSources", { planId, sourceIds: picked });
      await refreshPlan(client, planId);
      onClose();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        open={open}
        width="lg"
        title={t("planOverview.addSources")}
        busy={busy}
        onClose={onClose}
        // The picks and the error go once it has shrunk away.
        onClosed={() => {
          setSelected([]);
          setError(false);
        }}
        actions={[
          { label: t("planOverview.attachSources"), disabled: !picked.length, working: busy, onClick: () => void attach() },
        ]}
      >
        {error ? <Notice tone="danger">{t("planOverview.failed")}</Notice> : null}
        {/* Without both lists nothing is offered, so an empty table must not pass for "nothing to add". */}
        {sourcesUnreadable(library, pastPapers) ? (
          <Notice
            tone="danger"
            action={{
              label: t("components.notice.retry"),
              onClick: () => {
                if (library.isError) void library.refetch();
                if (pastPapers.isError) void pastPapers.refetch();
              },
            }}
          >
            {t("planOverview.sourcesUnreadable")}
          </Notice>
        ) : null}
        <p className="small ink-muted">{t("planOverview.pickerHelp")}</p>
        <Table
          tableLayout="fixed"
          className="px-plan-source-table"
          size="small"
          rowKey="id"
          loading={library.isPending || pastPapers.isPending}
          dataSource={offered}
          rowSelection={{
            selectedRowKeys: picked,
            onChange: (keys) => setSelected(keys.map(String)),
            getCheckboxProps: (source) => ({
              disabled: busy || source.status !== "ready",
              name: source.title,
              "aria-label": source.title,
            }),
          }}
          columns={[
            { title: t("sources.nameColumn"), dataIndex: "title" },
            {
              title: t("sources.typeColumn"),
              dataIndex: "kind",
              render: (kind: string) => t(`sources.kind.${kind}`, { defaultValue: kind }),
            },
            {
              title: t("sources.statusColumn"),
              dataIndex: "status",
              render: (status: string) => t(`sources.status.${status}`, { defaultValue: status }),
            },
          ]}
        />
        <Button onClick={() => setImportOpen(true)}>{t("planOverview.importSource")}</Button>
      </Dialog>
      {importOpen ? (
        <LibraryPanel
          importOnly
          onClose={() => {
            setImportOpen(false);
            void library.refetch();
          }}
        />
      ) : null}
    </>
  );
}
