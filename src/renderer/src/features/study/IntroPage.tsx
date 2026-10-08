import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { parseSmartText, smartQuestions } from "@shared/smart-text";
import { invoke } from "../../lib/ipc";
import { Notice } from "../../components/Notice";
import { SmartText } from "../../components/SmartText";
import { ReaderEnd, ReaderLayout, ReaderProgress } from "./Reader";

type Intro = RequestOutput<"plans.intro">;

/** The course introduction, read like a lesson: welcome text with a quick check or two. */
export function IntroPage() {
  const { t } = useTranslation();
  const { planId = "" } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const key = ["plan", planId, "intro"];
  const intro = useQuery({
    queryKey: key,
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.intro", { planId }),
  });
  const plan = useQuery({
    queryKey: ["plan", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.read", { planId }),
  });
  const node = plan.data?.nodes.find((item) => item.kind === "intro");
  const refreshPlan = () =>
    Promise.all(
      [["plan", planId], ["recommend", planId]].map((queryKey) =>
        client.invalidateQueries({ queryKey }),
      ),
    );
  const markDone = useMutation({
    mutationFn: (nodeId: string) => invoke("plans.complete", { planId, nodeId }),
    onSuccess: async () => {
      await refreshPlan();
      navigate(`/plans/${planId}`);
    },
  });
  const unanswered = useMemo(() => {
    if (!intro.data) return false;
    const ids = [...smartQuestions(parseSmartText(intro.data.markdown)).keys()];
    return ids.some((id) => intro.data?.answers[id] === undefined);
  }, [intro.data]);

  async function answer(blockId: string, pick: number) {
    if (!intro.data) return;
    const result = await invoke("study.lessonAnswer", {
      planId,
      itemId: intro.data.itemId,
      blockId,
      pick,
    });
    client.setQueryData<Intro>(key, (current) =>
      current
        ? { ...current, answers: { ...current.answers, [blockId]: result.pick } }
        : current,
    );
    if (result.finished) await refreshPlan();
  }

  return (
    <ReaderLayout
      eyebrow={t("plans.intro")}
      title={plan.data?.title ?? t("plans.intro")}
      backLabel={t("lesson.back")}
      onBack={() => navigate(`/plans/${planId}`)}
    >
      {intro.isPending ? <ReaderProgress label={t("lesson.loading")} empty /> : null}
      {intro.isError ? (
        <Notice
          tone="warning"
          action={{ label: t("lesson.retry"), onClick: () => void intro.refetch() }}
        >
          {t("lesson.introFailed")}
        </Notice>
      ) : null}
      {intro.isSuccess && !intro.data ? (
        <p className="body ink-muted">{t("lesson.introMissing")}</p>
      ) : null}
      {intro.data ? (
        <SmartText answers={intro.data.answers} onAnswer={answer}>
          {intro.data.markdown}
        </SmartText>
      ) : null}
      {intro.isSuccess ? (
        <ReaderEnd
          state={
            node?.state === "done"
              ? "done"
              : node?.state === "current"
                ? "current"
                : "other"
          }
          doneLabel={t("lesson.introDone")}
          pendingHint={unanswered ? t("lesson.introPrompt") : undefined}
          busy={markDone.isPending}
          failed={markDone.isError}
          onMarkDone={() => node && markDone.mutate(node.id)}
          onBack={() => navigate(`/plans/${planId}`)}
        />
      ) : null}
    </ReaderLayout>
  );
}
