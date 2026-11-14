import { Button, Modal } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { usePlace } from "../../app/usePlace";
import { BackControl } from "../../components/BackControl";
import { ErrorState } from "../../components/ErrorState";
import { Notice } from "../../components/Notice";
import { SkeletonRows } from "../../components/Skeleton";
import { SourceDetails } from "../../components/SourceDetails";
import { closeSourceViewer, openSourceViewer } from "../../components/SourceViewer";
import { SourceRow } from "../../components/SourceRow";
import { errorDetails } from "../../lib/errorDetails";
import { invoke } from "../../lib/ipc";
import { sourcesQuery, usePlan } from "../../lib/queries";
import { refreshPlan } from "../../lib/refreshPlan";
import { AttachSourcesDialog } from "./AttachSourcesDialog";
import { PastPapers } from "./PastPapers";
import { RebuildDialog } from "./RebuildDialog";
import "./ExamPage.css";

/**
 * All of an exam's material, reached from Materiale on its page: the sources with their details, adding and removing
 * them, rebuilding the topics after a change, and the past exam papers.
 */
export function PlanSources({ planId }: { planId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const plan = usePlan(planId);
  const back = usePlace({ parent: plan.data ? { name: { text: plan.data.title } } : undefined });
  // The rows show each file's size, which the library holds.
  const library = useQuery(sourcesQuery);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detailSourceId, setDetailSourceId] = useState<string | null>(null);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const [modal, modalContext] = Modal.useModal();
  const refresh = () => refreshPlan(client, planId);
  async function action(run: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await run();
    } catch {
      setError(t("planOverview.failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  if (plan.isError || (plan.isSuccess && !plan.data)) {
    const toExams = {
      label: t("nav.toExams"),
      onClick: () => navigate("/exams"),
    };
    return plan.isError ? (
      <ErrorState
        action={{
          label: t("components.notice.retry"),
          onClick: () => void plan.refetch(),
        }}
        secondary={toExams}
        details={errorDetails(plan.error)}
      >
        {t("planOverview.unavailable")}
      </ErrorState>
    ) : (
      <ErrorState action={toExams}>{t("planOverview.gone")}</ErrorState>
    );
  }
  return (
    <div className="px-exam-sub">
      {modalContext}
      <BackControl target={back} variant="page" />
      <h1 className="title-1">{t("examPage.material")}</h1>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {plan.isPending ? (
        <SkeletonRows label={t("components.loading")} />
      ) : (
        <section className="px-plan-sources">
          {plan.data?.needsRebuild && (
            <Notice
              tone="info"
              action={{
                label: t("plans.rebuild"),
                onClick: () => setRebuildOpen(true),
              }}
            >
              {t("planOverview.rebuildSuggested")}
            </Notice>
          )}
          {plan.data?.sources.length ? (
            <ul className="px-list-surface" aria-label={t("plans.tabSources")}>
              {plan.data.sources.map((source) => {
                const removeItem = { key: "remove", label: t("planOverview.removeSource"), danger: true };
                const askRemove = () =>
                  modal.confirm({
                    title: t("planOverview.removeSource"),
                    content: t("planOverview.removeSourceHelp", {
                      title: source.title,
                    }),
                    onOk: () =>
                      action(async () => {
                        await invoke("plans.removeSource", {
                          planId,
                          sourceId: source.id,
                        });
                        await refresh();
                      }),
                  });
                return (
                  <SourceRow
                    key={source.id}
                    source={{
                      ...source,
                      bytes: library.data?.find((item) => item.id === source.id)
                        ?.bytes,
                    }}
                    selected={source.id === detailSourceId}
                    // The file opens at its first page; its details are an item of the panel's menu.
                    onOpen={() =>
                      openSourceViewer(
                        { sourceId: source.id },
                        {
                          menu: () => ({
                            items: [{ key: "details", label: t("sources.details") }, { type: "divider" }, removeItem],
                            onSelect: (key) => {
                              if (key === "remove") return askRemove();
                              closeSourceViewer();
                              setDetailSourceId(source.id);
                            },
                          }),
                        },
                      )
                    }
                    actions={{
                      disabled: busy,
                      items: [{ key: "details", label: t("sources.details") }, { type: "divider" }, removeItem],
                      onSelect: (key) => (key === "remove" ? askRemove() : setDetailSourceId(source.id)),
                    }}
                  />
                );
              })}
            </ul>
          ) : plan.data ? (
            <p className="body ink-muted">{t("planOverview.noSources")}</p>
          ) : null}
          <Button shape="round" onClick={() => setPickerOpen(true)}>
            {t("planOverview.addSources")}
          </Button>
          <PastPapers planId={planId} />
          <SourceDetails
            sourceId={detailSourceId}
            known={plan.data?.sources.find(
              (source) => source.id === detailSourceId,
            )}
            onClose={() => setDetailSourceId(null)}
            onOpen={setDetailSourceId}
          />
        </section>
      )}
      <RebuildDialog
        planId={planId}
        sourceIds={plan.data?.sources.map((source) => source.id) ?? []}
        open={rebuildOpen}
        onClose={() => setRebuildOpen(false)}
        onDone={async () => {
          await refresh();
        }}
      />
      <AttachSourcesDialog
        planId={planId}
        attached={plan.data?.sources.map((source) => source.id) ?? []}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
