import { useMutation } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { MarkdownView } from "../../components/MarkdownView";
import { downloadText } from "../../lib/download";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";

function chosenRight(raw: string | undefined, left: string, index: number): string {
  if (!raw) return "";
  try {
    const pairs = JSON.parse(raw) as unknown;
    if (!Array.isArray(pairs)) return "";
    const row = pairs[index];
    return Array.isArray(row) && row[0] === left && typeof row[1] === "string" ? row[1] : "";
  } catch {
    return "";
  }
}

export function QuizPage() {
  const { t } = useTranslation();
  const { planId, topicId } = useParams();
  useActiveTime(planId, topicId ?? null);
  const navigate = useNavigate();
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [withAnswers, setWithAnswers] = useState(false);
  const start = useMutation({
    mutationFn: () =>
      topicId
        ? invoke("study.quizStart", { planId: planId ?? "", topicId })
        : invoke("study.diagnosticStart", { planId: planId ?? "" }),
  });
  const submit = useMutation({
    mutationFn: () =>
      invoke("study.quizSubmit", { attemptId: start.data?.attemptId ?? "", picks }),
  });
  const questions = start.data?.questions ?? [];

  return (
    <FocusLayout
      title={t("quiz.title")}
      secondary={
        <Button type="text" shape="round" onClick={() => navigate(`/plans/${planId ?? ""}`)}>
          {t("nav.back")}
        </Button>
      }
    >
      <label className="choice">
        <input
          type="checkbox"
          checked={withAnswers}
          onChange={(event) => setWithAnswers(event.target.checked)}
        />
        <span>{t("export.answers")}</span>
      </label>
      <Button
        shape="round"
        onClick={() => {
          if (!planId) return;
          void invoke("study.markdown", {
            planId,
            kind: "quiz",
            topicId,
            answers: withAnswers,
          }).then((file) => {
            downloadText(file.filename, file.markdown);
          });
        }}
      >
        {t("export.markdown")}
      </Button>
      {start.isSuccess && questions.length === 0 ? (
        <p className="small">{t("quiz.empty")}</p>
      ) : questions.length === 0 ? (
        <Button type="primary" shape="round" loading={start.isPending} onClick={() => start.mutate()}>
          {t("quiz.start")}
        </Button>
      ) : (
        <ol className="choice-list">
          {questions.map((question) => (
            <li key={question.id} className="passage">
              <MarkdownView>{question.stem}</MarkdownView>
              {question.grade.kind === "mcq" && question.options ? (
                <div className="choice-list">
                  {question.options.map((option, index) => (
                    <button
                      key={`${question.id}-${index}`}
                      type="button"
                      className={picks[question.id] === String(index) ? "choice is-selected" : "choice"}
                      aria-pressed={picks[question.id] === String(index)}
                      disabled={Boolean(submit.data)}
                      onClick={() =>
                        setPicks((current) => ({ ...current, [question.id]: String(index) }))
                      }
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : question.grade.kind === "tf" ? (
                <div className="choice-list">
                  {(["true", "false"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={picks[question.id] === value ? "choice is-selected" : "choice"}
                      aria-pressed={picks[question.id] === value}
                      disabled={Boolean(submit.data)}
                      onClick={() => setPicks((current) => ({ ...current, [question.id]: value }))}
                    >
                      {t(value === "true" ? "quiz.true" : "quiz.false")}
                    </button>
                  ))}
                </div>
              ) : question.grade.kind === "matching" && question.left && question.right ? (
                <div className="choice-list">
                  {question.left.map((left, index) => (
                    <div key={`${question.id}-${index}`}>
                      <p className="small">{left}</p>
                      {question.right?.map((right) => (
                        <button
                          key={right}
                          type="button"
                          className={
                            chosenRight(picks[question.id], left, index) === right
                              ? "choice is-selected"
                              : "choice"
                          }
                          aria-pressed={chosenRight(picks[question.id], left, index) === right}
                          disabled={Boolean(submit.data)}
                          onClick={() => {
                            const pairs = (question.left ?? []).map((item, itemIndex) => [
                              item,
                              itemIndex === index
                                ? right
                                : chosenRight(picks[question.id], item, itemIndex),
                            ]);
                            setPicks((current) => ({
                              ...current,
                              [question.id]: JSON.stringify(pairs),
                            }));
                          }}
                        >
                          {right}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <Input
                  aria-label={t("quiz.submit")}
                  value={picks[question.id] ?? ""}
                  disabled={Boolean(submit.data)}
                  onChange={(event) =>
                    setPicks((current) => ({ ...current, [question.id]: event.target.value }))
                  }
                />
              )}
              {submit.data ? (
                <>
                  <p className="small">
                    {submit.data.results.find((row) => row.id === question.id)?.expected}
                  </p>
                  {(submit.data.results.find((row) => row.id === question.id)?.score ?? 1) < 1 ? (
                    <Button
                      type="text"
                      shape="round"
                      onClick={() => {
                        const result = submit.data?.results.find((row) => row.id === question.id);
                        const expected = result?.expected ?? "";
                        void invoke("chats.seed", {
                          kind: "answer",
                          title: question.stem.slice(0, 80),
                          body: `Question: ${question.stem}\nYour answer: ${picks[question.id] ?? ""}\nExpected: ${expected}\n${result?.explanation ?? ""}`,
                        }).then((seeded) => navigate(`/ask/${seeded.chatId}`));
                      }}
                    >
                      {t("ask.askTutor")}
                    </Button>
                  ) : null}
                  <Button
                    type="text"
                    shape="round"
                    onClick={() => {
                      void invoke("study.flag", {
                        targetKind: "exercise",
                        targetId: question.sourceId ?? question.id,
                      });
                    }}
                  >
                    {t("quiz.flag")}
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {questions.length > 0 && !submit.data ? (
        <Button type="primary" shape="round" loading={submit.isPending} onClick={() => submit.mutate()}>
          {t("quiz.submit")}
        </Button>
      ) : null}
      {submit.data ? (
        <p className="body-strong">{t("quiz.score", { score: Math.round(submit.data.score * 100) })}</p>
      ) : null}
      {start.error ? <p className="small">{t("quiz.empty")}</p> : null}
    </FocusLayout>
  );
}
