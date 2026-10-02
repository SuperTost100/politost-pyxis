import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { MarkdownView } from "../../components/MarkdownView";
import { ExportButton } from "../share/ExportButton";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";

export function LessonPage() {
  const { t } = useTranslation();
  const { planId, topicId } = useParams();
  useActiveTime(planId, topicId ?? null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const lesson = useQuery({
    queryKey: ["lesson", planId, topicId],
    enabled: Boolean(planId && topicId),
    queryFn: () =>
      invoke("study.lesson", { planId: planId ?? "", topicId: topicId ?? "" }),
  });
  const plan = useQuery({
    queryKey: ["plan", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.read", { planId: planId ?? "" }),
  });
  const node = (plan.data?.nodes ?? []).find(
    (item) =>
      item.kind === "learn" &&
      item.topicId === topicId &&
      item.state === "current",
  );

  return (
    <FocusLayout
      title={t("lesson.title")}
      secondary={
        <Button
          type="text"
          shape="round"
          onClick={() => navigate(`/plans/${planId ?? ""}`)}
        >
          {t("nav.back")}
        </Button>
      }
    >
      <Button
        shape="round"
        onClick={() => navigate(`/plans/${planId ?? ""}/map/${topicId ?? ""}`)}
      >
        {t("map.title")}
      </Button>
      <ExportButton
        planId={planId ?? ""}
        topicId={topicId}
        kind="lesson"
        disabled={!lesson.data}
      />
      <article className="passage">
        <MarkdownView>{lesson.data?.markdown ?? ""}</MarkdownView>
      </article>
      {node ? (
        <Button
          type="primary"
          shape="round"
          onClick={() => {
            if (!planId) return;
            void invoke("plans.complete", { planId, nodeId: node.id }).then(
              () => {
                void client.invalidateQueries({ queryKey: ["plan", planId] });
                navigate(`/plans/${planId}`);
              },
            );
          }}
        >
          {t("lesson.done")}
        </Button>
      ) : null}
    </FocusLayout>
  );
}
