import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { MathInput } from "../../components/MathInput";
import { MarkdownView } from "../../components/MarkdownView";
import { Notice } from "../../components/Notice";
import { Tag } from "../../components/Tag";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";

type Exercise = Awaited<ReturnType<typeof invoke<"study.exercises">>>["exercises"][number];

function ExerciseCard({ exercise }: { exercise: Exercise }) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState("");
  const [steps, setSteps] = useState(0);
  const [hints, setHints] = useState(0);
  const flag = useMutation({
    mutationFn: () =>
      invoke("study.flag", { targetKind: "exercise", targetId: exercise.id }),
  });
  const allSteps = steps >= exercise.steps.length;
  return (
    <li className="passage">
      <Tag tone={exercise.generated ? "neutral" : "smartbook"}>
        {t(exercise.generated ? "components.tags.ai" : "components.tags.smartbook")}
      </Tag>
      <MarkdownView runnable>{exercise.prompt}</MarkdownView>
      <MathInput
        value={answer}
        rows={2}
        ariaLabel={t("practice.yourAnswer")}
        placeholder={t("practice.yourAnswer")}
        onChange={setAnswer}
      />
      {exercise.hints.slice(0, hints).map((hint, index) => (
        <p key={index} className="body">
          {t("practice.hintN", { n: index + 1 })} {hint}
        </p>
      ))}
      {exercise.steps.slice(0, steps).map((step, index) => (
        <MarkdownView
          key={index}
          runnable
          checks={step.check ? [step.check] : undefined}
        >
          {step.text}
        </MarkdownView>
      ))}
      {allSteps && steps > 0 && exercise.answer ? (
        <>
          <p className="meta">{t("practice.finalAnswer")}</p>
          <MarkdownView runnable>{exercise.answer}</MarkdownView>
        </>
      ) : null}
      <div className="gallery-row">
        {hints < exercise.hints.length ? (
          <Button shape="round" onClick={() => setHints(hints + 1)}>
            {t("practice.hint")}
          </Button>
        ) : null}
        {!allSteps ? (
          <Button shape="round" onClick={() => setSteps(steps + 1)}>
            {steps === 0 ? t("practice.reveal") : t("practice.nextStep")}
          </Button>
        ) : null}
        {exercise.generated ? (
          <Button
            type="text"
            shape="round"
            disabled={flag.isSuccess}
            loading={flag.isPending}
            onClick={() => flag.mutate()}
          >
            {flag.isSuccess ? t("lesson.flagged") : t("lesson.flag")}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function PracticePage() {
  const { t } = useTranslation();
  const { planId, topicId } = useParams();
  useActiveTime(planId, topicId ?? null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const plan = useQuery({
    queryKey: ["plan", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.read", { planId: planId ?? "" }),
  });
  const exercises = useQuery({
    queryKey: ["exercises", planId, topicId],
    enabled: Boolean(topicId),
    queryFn: () => invoke("study.exercises", { topicId: topicId ?? "", planId }),
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.job?.state ?? "") ? 1500 : false,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["exercises", planId, topicId] });
  // Finishing the set records it on the path, for this topic whatever the path suggested.
  const finish = useMutation({
    mutationFn: () =>
      invoke("plans.complete", { planId: planId ?? "", activity: "practice", topicId: topicId ?? null }),
    onSuccess: async () => {
      await Promise.all(
        [["plan", planId], ["recommend", planId]].map((queryKey) =>
          client.invalidateQueries({ queryKey }),
        ),
      );
      navigate(`/plans/${planId ?? ""}`);
    },
  });
  const generate = useMutation({
    mutationFn: () => invoke("study.exercises", { topicId: topicId ?? "", planId, generate: true }),
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: (jobId: string) => invoke("jobs.cancel", { jobId }),
    onSuccess: refresh,
  });
  const list = exercises.data?.exercises ?? [];
  const job = exercises.data?.job ?? null;
  const building = job?.state === "queued" || job?.state === "running";
  const stopped = job && !building && job.state !== "succeeded";

  return (
    <FocusLayout
      title={t("practice.title")}
      headerRight={
        <Button
          shape="round"
          onClick={() => navigate(`/plans/${planId ?? ""}/quiz/${topicId ?? ""}`)}
        >
          {t("quiz.title")}
        </Button>
      }
      secondary={
        <Button type="text" shape="round" onClick={() => navigate(`/plans/${planId ?? ""}`)}>
          {t("nav.back")}
        </Button>
      }
      primary={
        // Done comes after the exercises, as at the end of a lesson.
        list.length > 0 && plan.data ? (
          <Button
            type="primary"
            shape="round"
            loading={finish.isPending}
            onClick={() => finish.mutate()}
          >
            {t("lesson.markDone")}
          </Button>
        ) : null
      }
    >
      {finish.isError ? (
        <Notice tone="danger">{t("planOverview.failed")}</Notice>
      ) : null}
      {building ? (
        <div role="status">
          {t("practice.writing")}{" "}
          <Button onClick={() => cancel.mutate(job.jobId)}>{t("jobs.cancel")}</Button>
        </div>
      ) : null}
      {stopped || generate.isError ? (
        <Notice
          tone={job?.state === "cancelled" ? "info" : "warning"}
          details={job?.error ?? undefined}
          action={{ label: t("lesson.retry"), onClick: () => generate.mutate() }}
        >
          {t(
            job?.state === "cancelled"
              ? "practice.cancelled"
              : job?.state === "interrupted"
                ? "practice.interrupted"
                : "practice.failed",
          )}
        </Notice>
      ) : null}
      {list.length === 0 && !building && !stopped && exercises.isSuccess ? (
        <>
          <p className="body">{t("practice.emptyGenerate")}</p>
          <Button
            type="primary"
            shape="round"
            loading={generate.isPending}
            onClick={() => generate.mutate()}
          >
            {t("practice.generate")}
          </Button>
        </>
      ) : null}
      {list.length > 0 ? (
        <ol className="choice-list">
          {list.map((exercise) => (
            <ExerciseCard key={exercise.id} exercise={exercise} />
          ))}
        </ol>
      ) : null}
    </FocusLayout>
  );
}
