import { Button, Form, Modal, Select } from "antd";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import type { IconName } from "../../components/Icon";
import { LessonTile } from "../../components/LessonTile";
import { Notice } from "../../components/Notice";
import { SegmentedTabs } from "../../components/SegmentedTabs";
import { invoke } from "../../lib/ipc";
import { pastPapersQuery } from "../../lib/queries";

type Plan = NonNullable<RequestOutput<"plans.read">>;
type Guide = NonNullable<RequestOutput<"plans.recommend">>;
const kinds = ["mcq", "completion", "matching", "tf", "open"] as const;
type QuizKind = (typeof kinds)[number];

/**
 * "Crea un'attività": any activity on any topic, a quiz with the kinds of question chosen, or a simulation of a chosen
 * length and material. Opened from the exam page's menu and from a topic on the path.
 */
export function ExamCreateDialog({
  planId,
  plan,
  guide,
  open: createOpen,
  initialTopic,
  onClose,
}: {
  planId: string;
  plan: Plan | undefined;
  guide: Guide | undefined;
  open: boolean;
  /** The topic the dialog opens on; the path's next topic when not given. */
  initialTopic: string | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pastPapers = useQuery({
    ...pastPapersQuery(planId),
    enabled: !!planId && createOpen,
  });
  const [group, setGroup] = useState("learn");
  const [lessonKind, setLessonKind] = useState<string | null>(null);
  const [picked, setTopicId] = useState<string | null>(null);
  const topicId =
    picked ?? initialTopic ?? guide?.next?.topicId ?? plan?.topics[0]?.id ?? "";
  const [quizKinds, setQuizKinds] = useState<QuizKind[]>([...kinds]);
  const [minutes, setMinutes] = useState<30 | 60 | 90 | 120>(60);
  const [material, setMaterial] = useState<"exam" | "mixed">("mixed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const [wasOpen, setWasOpen] = useState(createOpen);
  // Each opening starts from the first screen, on the topic it was opened for.
  if (createOpen !== wasOpen) {
    setWasOpen(createOpen);
    if (createOpen) {
      setTopicId(null);
      setLessonKind(null);
      setGroup("learn");
      setError("");
    }
  }
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
  function chooseLesson(kind: string) {
    if (["quiz", "simulation"].includes(kind)) {
      setLessonKind(kind);
      return;
    }
    onClose();
    navigate(
      `/plans/${planId}/${kind}${["lesson", "practice", "cards", "map"].includes(kind) ? `/${topicId}` : ""}`,
    );
  }
  return (
    <Modal
      width={640}
      open={createOpen}
      title={t("planOverview.create")}
      onCancel={() => !busy && onClose()}
      footer={null}
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {!lessonKind ? (
        <>
          <SegmentedTabs
            label={t("planOverview.lessonGroup")}
            value={group}
            onChange={setGroup}
            items={[
              { value: "learn", label: t("planOverview.learn") },
              { value: "practice", label: t("plans.practice") },
              { value: "exam", label: t("nav.exams") },
            ]}
          />
          <label
            className="small px-plan-topic-label"
            htmlFor="plan-lesson-topic"
          >
            {t("planOverview.topic")}
          </label>
          <Select
            id="plan-lesson-topic"
            value={topicId}
            onChange={setTopicId}
            options={plan?.topics.map((topic) => ({
              value: topic.id,
              label: topic.title,
            }))}
            style={{ width: "100%" }}
          />
          <div className="px-plan-lesson-grid">
            {(group === "learn"
              ? [
                  {
                    kind: "lesson",
                    icon: "book-open",
                    label: t("lesson.title"),
                  },
                  { kind: "map", icon: "network", label: t("map.title") },
                ]
              : group === "practice"
                ? [
                    {
                      kind: "quiz",
                      icon: "list-checks",
                      label: t("quiz.title"),
                    },
                    {
                      kind: "cards",
                      icon: "layers",
                      label: t("cards.title"),
                    },
                    {
                      kind: "practice",
                      icon: "pencil-line",
                      label: t("practice.title"),
                    },
                  ]
                : [
                    {
                      kind: "diagnostic",
                      icon: "list-checks",
                      label: t("quiz.diagnostic"),
                    },
                    {
                      kind: "simulation",
                      icon: "clock",
                      label: t("simulation.title"),
                    },
                    ...(pastPapers.data?.papers.some(
                      (paper) => paper.status === "ready",
                    )
                      ? [
                          {
                            kind: "past",
                            icon: "file-pen",
                            label: t("pastPapers.practiceTitle"),
                          },
                        ]
                      : []),
                  ]
            ).map((tile) => (
              <LessonTile
                key={tile.kind}
                icon={tile.icon as IconName}
                label={tile.label}
                recommended={
                  guide?.next?.activity === tile.kind &&
                  [topicId, null].includes(guide.next.topicId)
                }
                recommendedLabel={t("plans.path.suggested")}
                onClick={() => chooseLesson(tile.kind)}
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <Button
            type="text"
            disabled={busy}
            onClick={() => setLessonKind(null)}
          >
            {t("nav.back")}
          </Button>
          {lessonKind === "quiz" ? (
            <>
              <fieldset className="px-plan-quiz-types">
                <legend>{t("quiz.types")}</legend>
                {kinds.map((kind) => (
                  <label key={kind}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={quizKinds.includes(kind)}
                      onChange={() =>
                        setQuizKinds((current) =>
                          current.includes(kind)
                            ? current.filter((value) => value !== kind)
                            : [...current, kind],
                        )
                      }
                    />
                    {t(`quiz.kinds.${kind}`)}
                  </label>
                ))}
              </fieldset>
            </>
          ) : (
            <Form layout="vertical">
              <Form.Item label={t("simulation.duration")}>
                <Select
                  value={minutes}
                  onChange={setMinutes}
                  disabled={busy}
                  options={[30, 60, 90, 120].map((value) => ({
                    value,
                    label: t("simulation.minutes", { count: value }),
                  }))}
                />
              </Form.Item>
              <Form.Item label={t("simulation.material")}>
                <Select
                  value={material}
                  onChange={setMaterial}
                  disabled={busy}
                  options={[
                    { value: "exam", label: t("simulation.exam") },
                    { value: "mixed", label: t("simulation.mixed") },
                  ]}
                />
              </Form.Item>
            </Form>
          )}
          <Button
            type="primary"
            loading={busy}
            disabled={lessonKind === "quiz" && !quizKinds.length}
            onClick={() =>
              void action(async () => {
                if (lessonKind === "quiz") {
                  const result = await invoke("study.quizStart", {
                    planId,
                    topicId,
                    count: 10,
                    types: quizKinds,
                  });
                  navigate(
                    `/plans/${planId}/quiz/${topicId}?attempt=${result.attemptId}`,
                  );
                } else {
                  const result = await invoke("study.simulationPrepare", {
                    planId,
                    minutes,
                    source: material,
                  });
                  navigate(
                    result.attemptId
                      ? `/plans/${planId}/exam/${result.attemptId}`
                      : `/plans/${planId}/simulation`,
                  );
                }
              })
            }
          >
            {t("planOverview.start")}
          </Button>
        </>
      )}
    </Modal>
  );
}
