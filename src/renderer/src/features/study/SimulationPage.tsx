import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Input, Modal, Segmented } from "antd";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { MarkdownView } from "../../components/MarkdownView";
import { Notice } from "../../components/Notice";
import { MasteryBar } from "../../components/MasteryBar";
import { StepLines } from "../../components/StepLines";
import { downloadText } from "../../lib/download";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";
import "./SimulationPage.css";

export function SimulationPage() {
  const { t } = useTranslation();
  const { planId = "", attemptId } = useParams();
  useActiveTime(planId, null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [started, setStarted] = useState<string | null>(attemptId ?? null);
  const [length, setLength] = useState<30 | 60 | 90 | 120>(30);
  const [source, setSource] = useState<"exam" | "mixed">("exam");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const [withAnswers, setWithAnswers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [now, setNow] = useState(Date.now());
  const drafts = useRef<Promise<unknown>>(Promise.resolve());
  const plan = useQuery({
    queryKey: ["plan", planId],
    queryFn: () => invoke("plans.read", { planId }),
    enabled: Boolean(planId),
  });
  const open = useQuery({
    queryKey: ["simulation", planId, started],
    enabled: Boolean(planId),
    refetchInterval: 1000,
    queryFn: () =>
      started
        ? invoke("study.simulationRead", { attemptId: started })
        : invoke("study.simulationOpen", { planId }),
  });
  const run = open.data?.planId === planId ? open.data : undefined;
  useEffect(() => {
    if (run && !started) {
      setStarted(run.attemptId);
      navigate(`/plans/${planId}/exam/${run.attemptId}`, { replace: true });
    }
  }, [run?.attemptId, started, planId, navigate]);
  useEffect(() => {
    setStarted(attemptId ?? null);
  }, [attemptId, planId]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setPicks({});
    setIndex(0);
  }, [run?.attemptId]);
  const seconds = run?.locked
    ? 0
    : run
      ? Math.max(0, Math.ceil((run.deadline - now) / 1000))
      : length * 60;
  const locked = Boolean(
    run && (run.submitted || run.grading || seconds === 0),
  );
  const shown = locked
    ? (run?.picks ?? {})
    : { ...(run?.picks ?? {}), ...picks };
  const question = run?.questions[index];
  const unanswered =
    run?.questions.filter((q) => !(shown[q.id] ?? "").trim()).length ?? 0;
  const time = `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  const provenance = [
    ...new Set(run?.results?.map((r) => `${r.provider} · ${r.model}`) ?? []),
  ].join(", ");
  async function submit() {
    if (!run || busy) return;
    setConfirm(false);
    setBusy(true);
    setNotice("");
    try {
      await drafts.current;
      await invoke("study.simulationSubmit", {
        attemptId: run.attemptId,
        picks: shown,
      });
      await client.invalidateQueries({ queryKey: ["simulation", planId] });
    } catch {
      setNotice(t("simulation.actionFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <FocusLayout
      title={
        run
          ? (plan.data?.title ?? t("simulation.title"))
          : t("simulation.title")
      }
      closable={!run || run.submitted}
      headerRight={
        run && !run.submitted ? (
          <div className="px-sim-header-actions">
            <span
              className="code px-sim-timer"
              role="timer"
              aria-label={t("simulation.timeLeft")}
            >
              {time}
            </span>
            {!locked && (
              <Button
                shape="round"
                disabled={busy}
                onClick={() => setConfirm(true)}
              >
                {t("simulation.submit")}
              </Button>
            )}
          </div>
        ) : undefined
      }
      secondary={
        !run || run.submitted ? (
          <Button
            type="text"
            shape="round"
            onClick={() => navigate(`/plans/${planId}`)}
          >
            {t("nav.back")}
          </Button>
        ) : undefined
      }
    >
      {notice && <Notice tone="danger">{notice}</Notice>}
      {open.isError && (
        <Notice tone="warning">{t("simulation.actionFailed")}</Notice>
      )}
      {!run ? (
        <section className="px-sim-setup">
          <h2 className="title-2">{t("simulation.setup")}</h2>
          <label className="body-strong">{t("simulation.duration")}</label>
          <Segmented
            aria-label={t("simulation.duration")}
            value={length}
            disabled={busy || open.isPending}
            options={([30, 60, 90, 120] as const).map((value) => ({
              value,
              label: t("simulation.minutes", { count: value }),
            }))}
            onChange={(value) => setLength(value as typeof length)}
          />
          <label className="body-strong">{t("simulation.material")}</label>
          <Segmented
            aria-label={t("simulation.material")}
            value={source}
            disabled={busy || open.isPending}
            options={[
              { value: "exam", label: t("simulation.exam") },
              { value: "mixed", label: t("simulation.mixed") },
            ]}
            onChange={(value) => setSource(value as typeof source)}
          />
          <Notice tone="info">{t("simulation.tutorLocked")}</Notice>
          <Button
            type="primary"
            shape="round"
            loading={busy}
            disabled={open.isPending}
            onClick={() => {
              setBusy(true);
              setNotice("");
              void invoke("study.simulationStart", {
                planId,
                minutes: length,
                source,
              })
                .then((next) => {
                  setStarted(next.attemptId);
                  navigate(`/plans/${planId}/exam/${next.attemptId}`, {
                    replace: true,
                  });
                })
                .catch(() => setNotice(t("simulation.empty")))
                .finally(() => setBusy(false));
            }}
          >
            {t("simulation.start")}
          </Button>
        </section>
      ) : run.submitted ? (
        <section className="px-sim-results">
          {run.score !== undefined && (
            <div className="px-sim-score">
              <span className="stat">{Math.round(run.score * 100)}</span>
              <span className="small">{t("simulation.outOf100")}</span>
            </div>
          )}
          <Notice tone="info">
            {provenance
              ? t("simulation.modelGrade", { model: provenance })
              : t("simulation.localGrade")}
          </Notice>
          <h2 className="title-2">{t("simulation.byTopic")}</h2>
          <ul className="px-sim-topics">
            {run.topics.map((topic) => (
              <li key={topic.id}>
                <span className="body-strong">{topic.title}</span>
                <MasteryBar
                  value={Math.round(topic.score * 100)}
                  label={topic.title}
                />
              </li>
            ))}
          </ul>
          {run.questions.map((q, i) => {
            const result = run.results?.find((r) => r.id === q.id);
            return (
              <details className="px-sim-feedback" key={q.id}>
                <summary className="body-strong">
                  {t("simulation.question", { count: i + 1 })}
                  {result && (
                    <span className="code">
                      {Math.round(result.score * 100)} / 100
                    </span>
                  )}
                </summary>
                <MarkdownView>{q.stem}</MarkdownView>
                <h3 className="body-strong">{t("quiz.yourAnswer")}</h3>
                <MarkdownView>
                  {shown[q.id] || t("simulation.blank")}
                </MarkdownView>
                {result && (
                  <>
                    <MarkdownView>{result.feedback}</MarkdownView>
                    {result.missed.length > 0 && (
                      <>
                        <h3 className="body-strong">
                          {t("simulation.missed")}
                        </h3>
                        <ul>
                          {result.missed.map((text, j) => (
                            <li key={j}>
                              <MarkdownView variant="body">{text}</MarkdownView>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <h3 className="body-strong">{t("simulation.reference")}</h3>
                    <MarkdownView>{result.expected}</MarkdownView>
                  </>
                )}
              </details>
            );
          })}
        </section>
      ) : run.grading ? (
        <section className="px-sim-grading">
          <h2 className="title-2">{t("simulation.grading")}</h2>
          <Notice tone="info">{t("simulation.frozen")}</Notice>
          <StepLines
            label={t("simulation.grading")}
            steps={run.questions.map((q, i) => {
              const complete = Math.floor(
                run.grading!.progress * run.questions.length,
              );
              const failed = ["failed", "cancelled", "interrupted"].includes(
                run.grading!.state,
              );
              return {
                id: q.id,
                label: t("simulation.question", { count: i + 1 }),
                state:
                  i < complete
                    ? "done"
                    : i === complete
                      ? failed
                        ? "failed"
                        : "running"
                      : "pending",
              };
            })}
          />
          {["failed", "cancelled", "interrupted"].includes(
            run.grading.state,
          ) && (
            <Notice
              tone="danger"
              action={{
                label: t("simulation.retryGrade"),
                onClick: () => void submit(),
              }}
            >
              {t("simulation.gradeFailed")}
            </Notice>
          )}
        </section>
      ) : (
        <section className="px-sim-run">
          <nav
            className="px-sim-questions"
            aria-label={t("simulation.navigate")}
          >
            {run.questions.map((q, i) => (
              <button
                type="button"
                className={`px-sim-question${shown[q.id]?.trim() ? " is-answered" : ""}`}
                aria-current={index === i ? "step" : undefined}
                aria-label={t("simulation.questionState", {
                  count: i + 1,
                  state: t(
                    shown[q.id]?.trim()
                      ? "simulation.answered"
                      : "simulation.unanswered",
                  ),
                })}
                key={q.id}
                onClick={() => setIndex(i)}
              >
                {i + 1}
                {shown[q.id]?.trim() && <Check size={14} aria-hidden />}
              </button>
            ))}
          </nav>
          {question && (
            <>
              <h2 className="small">
                {t("quiz.position", {
                  current: index + 1,
                  total: run.questions.length,
                })}
              </h2>
              <MarkdownView>{question.stem}</MarkdownView>
              <Input.TextArea
                aria-label={t("quiz.yourAnswer")}
                value={shown[question.id] ?? ""}
                disabled={locked || busy}
                autoSize={{ minRows: 7, maxRows: 16 }}
                maxLength={20000}
                onChange={(event) => {
                  const next = { ...shown, [question.id]: event.target.value };
                  setPicks(next);
                  drafts.current = drafts.current
                    .catch(() => undefined)
                    .then(() =>
                      invoke("study.simulationDraft", {
                        attemptId: run.attemptId,
                        picks: next,
                      }),
                    )
                    .catch(() => setNotice(t("simulation.saveFailed")));
                }}
              />
              <details className="px-sim-preview">
                <summary className="small">{t("quiz.preview")}</summary>
                <MarkdownView>{shown[question.id] ?? ""}</MarkdownView>
              </details>
            </>
          )}
        </section>
      )}
      {(!run || run.submitted) && (
        <div className="px-sim-export">
          <Checkbox
            checked={withAnswers}
            onChange={(event) => setWithAnswers(event.target.checked)}
          >
            {t("export.answers")}
          </Checkbox>
          <Button
            shape="round"
            onClick={() =>
              void invoke("study.markdown", {
                planId,
                kind: "simulation",
                answers: withAnswers,
              })
                .then((file) => downloadText(file.filename, file.markdown))
                .catch(() => setNotice(t("simulation.actionFailed")))
            }
          >
            {t("export.markdown")}
          </Button>
        </div>
      )}
      <Modal
        title={t("simulation.deliver")}
        open={confirm}
        onCancel={() => setConfirm(false)}
        okText={t("simulation.submit")}
        cancelText={t("simulation.keepWriting")}
        onOk={() => void submit()}
      >
        <p className="body">{t("simulation.confirm", { count: unanswered })}</p>
      </Modal>
    </FocusLayout>
  );
}
