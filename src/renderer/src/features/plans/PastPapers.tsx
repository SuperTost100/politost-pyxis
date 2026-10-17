import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Modal } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { Notice } from "../../components/Notice";
import { StepLines } from "../../components/StepLines";
import { invoke } from "../../lib/ipc";
import { jobErrorKey } from "../jobs/jobErrors";
import { LibraryPanel } from "../home/LibraryPanel";
import "./PastPapers.css";

type Papers = RequestOutput<"study.pastPapers">;
type Paper = Papers["papers"][number];
const TYPES = ["open", "choice", "numeric", "proof"] as const;

/** "open 4, numeric 2": the paper's question types with their counts, most frequent first. */
function typeList(
  t: (key: string, options?: Record<string, unknown>) => string,
  types: Paper["types"],
): string {
  return TYPES.filter((type) => types[type] > 0)
    .sort((a, b) => types[b] - types[a])
    .map((type) => `${t(`pastPapers.type.${type}`)} ${types[type]}`)
    .join(", ");
}

/**
 * The past exams of a plan: add one as a PDF or photos, see what Pyxis read from each, practise the questions.
 * Simulations copy their structure. They are kept apart from the plan's study material.
 */
export function PastPapers({ planId }: { planId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [modal, modalContext] = Modal.useModal();
  const [adding, setAdding] = useState(false);
  const [several, setSeveral] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const papers = useQuery({
    queryKey: ["past-papers", planId],
    queryFn: () => invoke("study.pastPapers", { planId }),
    refetchInterval: (query) =>
      query.state.data?.papers.some((paper) => paper.status === "reading") ? 1000 : false,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["past-papers", planId] });
  const add = useMutation({
    mutationFn: async (groups: string[][]) => {
      for (const sourceIds of groups) await invoke("study.pastPaperAdd", { planId, sourceIds });
    },
    onSuccess: () => setProblem(null),
    onError: (err: unknown) => {
      const key = (err as { messageKey?: unknown })?.messageKey;
      setProblem(typeof key === "string" ? key : "pastPapers.addFailed");
    },
    onSettled: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: (sourceId: string) => invoke("study.pastPaperRemove", { planId, sourceId }),
    onSettled: () => void refresh(),
  });
  const retry = useMutation({
    mutationFn: (paper: Paper) =>
      invoke(paper.status === "interrupted" ? "jobs.resume" : "jobs.retry", {
        jobId: paper.jobId ?? "",
      }),
    onSettled: () => void refresh(),
  });
  const list = papers.data?.papers ?? [];
  const style = papers.data?.style;
  const ready = list.filter((paper) => paper.status === "ready");
  const mix = style
    ? TYPES.filter((type) => style.types[type] > 0).sort((a, b) => style.types[b] - style.types[a])
    : [];
  const total = mix.reduce((sum, type) => sum + (style?.types[type] ?? 0), 0);
  const styleFacts = style
    ? [
        t("pastPapers.styleQuestions", { count: style.questions }),
        style.minutes ? t("pastPapers.minutes", { count: style.minutes }) : "",
        mix.length === 1 || (style.types[mix[0]!] ?? 0) / Math.max(1, total) >= 0.6
          ? t("pastPapers.styleMix", { type: t(`pastPapers.type.${mix[0]}`) })
          : t("pastPapers.styleMixed", {
              first: t(`pastPapers.type.${mix[0]}`),
              second: t(`pastPapers.type.${mix[1]}`),
            }),
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  function imported(ids: string[]) {
    if (ids.length === 1) add.mutate([ids]);
    else if (ids.length > 1) setSeveral(ids);
  }
  return (
    <section className="px-papers" aria-labelledby="px-papers-title">
      {modalContext}
      <header className="px-papers-head">
        <div>
          <h2 id="px-papers-title" className="title-3">
            {t("pastPapers.title")}
          </h2>
          <p className="small ink-muted">{t("pastPapers.help")}</p>
        </div>
        <div className="px-papers-actions">
          <Button shape="round" loading={add.isPending} onClick={() => setAdding(true)}>
            {t("pastPapers.add")}
          </Button>
          {ready.length ? (
            <Button
              shape="round"
              onClick={() => navigate(`/plans/${planId}/past`)}
            >
              {t("pastPapers.practise")}
            </Button>
          ) : null}
        </div>
      </header>
      {problem ? <Notice tone="danger">{t(problem)}</Notice> : null}
      {papers.isError ? <Notice tone="danger">{t("pastPapers.practiceFailed")}</Notice> : null}
      {papers.isSuccess && list.length === 0 ? (
        <div className="px-papers-empty">
          <p className="body-strong">{t("pastPapers.emptyTitle")}</p>
          <p className="small ink-muted">{t("pastPapers.emptyBody")}</p>
        </div>
      ) : null}
      {list.length ? (
        <ul className="px-papers-list" aria-label={t("pastPapers.listLabel")}>
          {list.map((paper) => (
            <li key={paper.sourceId} className="px-paper">
              <div className="px-paper-text">
                <span className="body-strong">{paper.title}</span>
                {paper.status === "ready" ? (
                  <span className="meta">
                    {[
                      t("pastPapers.questions", { count: paper.questions }),
                      paper.minutes ? t("pastPapers.minutes", { count: paper.minutes }) : "",
                      typeList(t, paper.types),
                      paper.files > 1 ? t("pastPapers.files", { count: paper.files }) : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : paper.status === "reading" ? (
                  <StepLines
                    label={t("pastPapers.reading")}
                    steps={[{ id: paper.sourceId, label: t("pastPapers.reading"), state: "running" }]}
                  />
                ) : (
                  <span className="small px-paper-failed" role="alert">
                    {paper.status === "cancelled"
                      ? t("pastPapers.readCancelled")
                      : paper.error
                        ? t(jobErrorKey(paper.error))
                        : t("pastPapers.readFailed")}
                  </span>
                )}
              </div>
              <div className="px-paper-actions">
                {paper.status === "ready" ? (
                  <Button
                    size="small"
                    shape="round"
                    onClick={() => navigate(`/plans/${planId}/past?paper=${paper.sourceId}`)}
                  >
                    {t("pastPapers.practisePaper")}
                  </Button>
                ) : paper.status !== "reading" && paper.jobId ? (
                  <Button size="small" shape="round" loading={retry.isPending} onClick={() => retry.mutate(paper)}>
                    {t(paper.status === "interrupted" ? "pastPapers.resume" : "pastPapers.retry")}
                  </Button>
                ) : null}
                <Button
                  size="small"
                  shape="round"
                  type="text"
                  onClick={() =>
                    modal.confirm({
                      title: t("pastPapers.removeTitle"),
                      content: t("pastPapers.removeBody", { title: paper.title }),
                      okText: t("pastPapers.remove"),
                      onOk: () => remove.mutateAsync(paper.sourceId),
                    })
                  }
                >
                  {t("pastPapers.remove")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {styleFacts ? <p className="small ink-muted">{t("pastPapers.style", { facts: styleFacts })}</p> : null}
      {adding ? <LibraryPanel importOnly onClose={() => setAdding(false)} onImported={imported} /> : null}
      <Modal
        open={several != null}
        title={t("pastPapers.add")}
        onCancel={() => setSeveral(null)}
        footer={null}
        width={480}
      >
        <p>{t("pastPapers.oneOrMany", { count: several?.length ?? 0 })}</p>
        <div className="px-papers-choice">
          <Button
            shape="round"
            onClick={() => {
              if (several) add.mutate(several.map((id) => [id]));
              setSeveral(null);
            }}
          >
            {t("pastPapers.separatePapers")}
          </Button>
          <Button
            type="primary"
            shape="round"
            onClick={() => {
              if (several) add.mutate([several]);
              setSeveral(null);
            }}
          >
            {t("pastPapers.onePaper")}
          </Button>
        </div>
      </Modal>
    </section>
  );
}
