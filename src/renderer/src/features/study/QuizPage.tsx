import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Input, Slider } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { StepLines } from "../../components/StepLines";
import { MarkdownView } from "../../components/MarkdownView";
import { downloadText } from "../../lib/download";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";
import "./QuizPage.css";

const KINDS = ["mcq", "completion", "matching", "tf", "open"] as const;
type Kind = (typeof KINDS)[number];
type Result = {
  id: string;
  score: number;
  expected: string;
  explanation: string;
  model?: string;
};
function blanks(raw: string | undefined): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) &&
      value.every((item) => typeof item === "string")
      ? value
      : [];
  } catch {
    return [];
  }
}
function pairs(raw: string | undefined): Array<[string, string]> {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value)
      ? value.filter(
          (item): item is [string, string] =>
            Array.isArray(item) &&
            typeof item[0] === "string" &&
            typeof item[1] === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function QuizPage() {
  const { t } = useTranslation();
  const { planId, topicId } = useParams();
  useActiveTime(planId, topicId ?? null);
  const navigate = useNavigate();
  const diagnostic = !topicId;
  const [searchParams, setSearchParams] = useSearchParams();
  const savedAttempt = diagnostic ? null : searchParams.get("attempt");
  const restoredAttempt = useRef<string | null>(null);
  const [hydratedAttempt, setHydratedAttempt] = useState<string | null>(null);
  const draftToSave = useRef<{
    attemptId: string;
    picks: Record<string, string>;
    index: number;
  } | null>(null);
  const [count, setCount] = useState(20);
  const [types, setTypes] = useState<Kind[]>([...KINDS]);
  const [feedback, setFeedback] = useState(true);
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, Result>>({});
  const [withAnswers, setWithAnswers] = useState(false);
  const [actionError, setActionError] = useState(false);
  const heading = useRef<HTMLDivElement>(null);
  const start = useMutation({
    mutationFn: () =>
      topicId
        ? invoke("study.quizStart", {
            planId: planId ?? "",
            topicId,
            count,
            types,
            feedback,
          })
        : invoke("study.diagnosticStart", { planId: planId ?? "" }),
    onSuccess: (session) => {
      if (!diagnostic) setSearchParams({ attempt: session.attemptId });
    },
  });
  const attemptId = savedAttempt ?? start.data?.attemptId ?? "";
  const session = useQuery({
    queryKey: ["quiz-session", attemptId],
    queryFn: () => invoke("study.quizRead", { attemptId }),
    enabled: !diagnostic && Boolean(attemptId),
    refetchInterval: (query) =>
      query.state.data &&
      ["succeeded", "failed", "cancelled", "interrupted"].includes(
        query.state.data.state,
      )
        ? false
        : 500,
  });
  const questions = session.data?.questions ?? start.data?.questions ?? [];
  const requestedCount = diagnostic
    ? questions.length
    : (session.data?.requestedCount ?? count);
  const generationFailed = Boolean(
    session.data &&
    ["failed", "cancelled", "interrupted"].includes(session.data.state),
  );
  const generating =
    !diagnostic &&
    Boolean(attemptId) &&
    !generationFailed &&
    session.data?.state !== "succeeded";
  const canFinish =
    diagnostic ||
    (session.data?.state === "succeeded" && questions.length >= requestedCount);
  const retry = useMutation({
    mutationFn: async () => {
      if (!session.data?.jobId) return;
      await invoke(
        session.data.state === "interrupted" ? "jobs.resume" : "jobs.retry",
        { jobId: session.data.jobId },
      );
      await session.refetch();
    },
  });
  useEffect(() => {
    if (!session.data) return;
    const restoring = restoredAttempt.current !== attemptId;
    setChecked((current) => ({
      ...(restoring ? {} : current),
      ...Object.fromEntries(session.data.checked.map((row) => [row.id, row])),
    }));
    setPicks((current) => {
      const merged = {
        ...(restoring ? {} : current),
        ...(restoring ? session.data.draft?.picks : undefined),
        ...Object.fromEntries(
          session.data.checked.map((row) => [row.id, row.pick]),
        ),
        ...session.data.result?.picks,
      };
      return Object.keys(merged).length === Object.keys(current).length &&
        Object.entries(merged).every(([key, value]) => current[key] === value)
        ? current
        : merged;
    });
    if (restoring) {
      restoredAttempt.current = attemptId;
      const firstUnchecked = session.data.questions.findIndex(
        (row) => !session.data.checked.some((answer) => answer.id === row.id),
      );
      setIndex(
        Math.min(
          Math.max(
            0,
            session.data.draft?.index ??
              (firstUnchecked < 0
                ? session.data.questions.length - 1
                : firstUnchecked),
          ),
          Math.max(0, session.data.questions.length - 1),
        ),
      );
      setHydratedAttempt(attemptId);
    }
  }, [session.data, attemptId]);
  const question = questions[index];
  const immediate = (session.data?.feedback ?? feedback) && !diagnostic;
  const check = useMutation({
    mutationFn: () =>
      invoke("study.quizCheck", {
        attemptId,
        questionId: question!.id,
        pick: picks[question!.id] ?? "",
      }),
    onSuccess: (result) =>
      setChecked((current) => ({ ...current, [result.id]: result })),
  });
  const submit = useMutation({
    mutationFn: () =>
      invoke("study.quizSubmit", {
        attemptId,
        picks,
      }),
  });
  const finalResult = submit.data ?? session.data?.result;
  useEffect(() => {
    draftToSave.current =
      !diagnostic &&
      attemptId &&
      hydratedAttempt === attemptId &&
      !finalResult &&
      session.data?.submittedAt == null
        ? { attemptId, picks, index }
        : null;
    if (!draftToSave.current) return;
    const timer = window.setTimeout(() => {
      void flushDraft();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    attemptId,
    hydratedAttempt,
    diagnostic,
    picks,
    index,
    finalResult,
    session.data?.submittedAt,
  ]);
  useEffect(
    () => () => {
      const draft = draftToSave.current;
      if (draft) void invoke("study.quizDraft", draft).catch(() => undefined);
    },
    [],
  );
  async function flushDraft() {
    const draft = draftToSave.current;
    if (!draft) return;
    try {
      await invoke("study.quizDraft", draft);
    } catch {
      setActionError(true);
    }
  }
  async function back() {
    await flushDraft();
    navigate(`/plans/${planId ?? ""}`);
  }
  const result = question ? checked[question.id] : undefined;
  const locked = Boolean(result) || check.isPending || submit.isPending;
  const [remaining, setRemaining] = useState(10);
  useEffect(() => {
    setRemaining(10);
  }, [question?.id]);
  useEffect(() => {
    if (question?.grade.kind !== "tf" || result || finalResult) return;
    const deadline = Date.now() + 10000;
    const timer = window.setInterval(
      () => setRemaining(Math.max(0, (deadline - Date.now()) / 1000)),
      100,
    );
    return () => window.clearInterval(timer);
  }, [question?.id, question?.grade.kind, result, finalResult]);
  useEffect(() => {
    if (question) heading.current?.focus();
  }, [question?.id]);
  function pick(value: string) {
    if (question && !locked)
      setPicks((current) => ({ ...current, [question.id]: value }));
  }
  function next() {
    if (index + 1 < questions.length) {
      check.reset();
      setIndex(index + 1);
    } else if (canFinish) submit.mutate();
  }
  function answerText(id: string): string {
    const item = questions.find((row) => row.id === id);
    const raw = picks[id] ?? "";
    if (!raw) return "";
    if (item?.grade.kind === "mcq") return item.options?.[Number(raw)] ?? raw;
    if (item?.grade.kind === "tf")
      return raw === "true"
        ? t("quiz.true")
        : raw === "false"
          ? t("quiz.false")
          : "";
    if (item?.grade.kind === "completion") return blanks(raw).join(", ");
    if (item?.grade.kind === "matching")
      return pairs(raw)
        .map(([left, right]) => `${left} = ${right}`)
        .join("; ");
    return raw;
  }
  function expectedText(answer: Result): string {
    const item = questions.find((row) => row.id === answer.id);
    return item?.grade.kind === "tf"
      ? t(answer.expected === "true" ? "quiz.true" : "quiz.false")
      : answer.expected;
  }
  async function ask(id: string, answer: Result) {
    const item = questions.find((row) => row.id === id);
    if (!item) return;
    try {
      const seeded = await invoke("chats.seed", {
        kind: "answer",
        title: item.stem.slice(0, 80),
        body: `${t("quiz.question")}: ${item.stem}\n${t("quiz.yourAnswer")}: ${answerText(id)}\n${t("quiz.expected")}: ${expectedText(answer)}\n${answer.explanation}`,
      });
      navigate(`/ask/${seeded.chatId}`);
    } catch {
      setActionError(true);
    }
  }
  function flag(id: string) {
    const item = questions.find((row) => row.id === id);
    void invoke("study.flag", {
      targetKind: "exercise",
      targetId: item?.sourceId ?? id,
    }).catch(() => setActionError(true));
  }
  const rawPick = question ? (picks[question.id] ?? "") : "";
  const blankCount = question
    ? Math.max(1, [...question.stem.matchAll(/\{\{\d+\}\}/g)].length)
    : 1;
  const hasAnswer = Boolean(
    question &&
    (question.grade.kind === "completion"
      ? Array.from(
          { length: blankCount },
          (_, i) => blanks(rawPick)[i] ?? "",
        ).every((value) => value.trim())
      : question.grade.kind === "matching"
        ? question.left?.every((_, i) => pairs(rawPick)[i]?.[1]?.trim())
        : rawPick.trim()),
  );
  const error =
    start.error ||
    session.error ||
    retry.error ||
    check.error ||
    submit.error ||
    actionError;
  const errorKey =
    error && typeof error === "object" && "messageKey" in error
      ? String(error.messageKey)
      : "quiz.error";
  return (
    <FocusLayout
      title={t("quiz.title")}
      meta={
        question && !finalResult
          ? t("quiz.position", { current: index + 1, total: requestedCount })
          : undefined
      }
      progress={
        questions.length
          ? finalResult
            ? 1
            : index / requestedCount
          : undefined
      }
      secondary={
        <Button type="text" shape="round" onClick={() => void back()}>
          {t("nav.back")}
        </Button>
      }
    >
      {!diagnostic && attemptId ? (
        <div className="px-quiz-generation">
          {generating ? (
            <p className="meta" role="status">
              {t("quiz.available", {
                available: questions.length,
                total: requestedCount,
              })}
            </p>
          ) : null}
          {generationFailed ? (
            <>
              <p className="small" role="alert">
                {t(
                  session.data?.state === "cancelled"
                    ? "quiz.buildCancelled"
                    : "quiz.buildFailed",
                )}
              </p>
              {session.data?.jobId ? (
                <Button
                  shape="round"
                  loading={retry.isPending}
                  onClick={() => retry.mutate()}
                >
                  {t(
                    session.data.state === "interrupted"
                      ? "quiz.resume"
                      : "quiz.retry",
                  )}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {!start.data && !savedAttempt ? (
        <section className="px-quiz-setup">
          {!diagnostic ? (
            <>
              <div className="px-quiz-count">
                <label htmlFor="quiz-count" className="body-strong">
                  {t("quiz.count")}
                </label>
                <output>{count}</output>
              </div>
              <Slider
                id="quiz-count"
                min={10}
                max={100}
                value={count}
                onChange={setCount}
                disabled={start.isPending}
                ariaLabelForHandle={t("quiz.count")}
              />
              <fieldset className="px-quiz-types">
                <legend className="body-strong">{t("quiz.types")}</legend>
                <div className="px-quiz-pills">
                  {KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className={
                        types.includes(kind) ? "choice is-selected" : "choice"
                      }
                      aria-pressed={types.includes(kind)}
                      disabled={start.isPending}
                      onClick={() =>
                        setTypes((current) =>
                          current.includes(kind)
                            ? current.filter((item) => item !== kind)
                            : [...current, kind],
                        )
                      }
                    >
                      {t(`quiz.kinds.${kind}`)}
                    </button>
                  ))}
                </div>
              </fieldset>
              <Button
                shape="round"
                disabled={start.isPending}
                onClick={() => setTypes(["tf"])}
              >
                {t("quiz.tfOnly")}
              </Button>
              <label className="px-quiz-toggle">
                <input
                  type="checkbox"
                  checked={feedback}
                  disabled={start.isPending}
                  onChange={(event) => setFeedback(event.target.checked)}
                />
                <span>{t("quiz.feedback")}</span>
              </label>
            </>
          ) : (
            <p className="body">{t("quiz.diagnostic")}</p>
          )}
          <Button
            type="primary"
            shape="round"
            disabled={!diagnostic && !types.length}
            loading={start.isPending}
            onClick={() => start.mutate()}
          >
            {t("quiz.start")}
          </Button>
          {start.isPending ? (
            <p className="small" role="status">
              {t("quiz.preparing")}
            </p>
          ) : null}
        </section>
      ) : !questions.length && !diagnostic && attemptId ? (
        <section className="px-quiz-setup">
          <StepLines
            label={t("quiz.preparing")}
            steps={[
              {
                id: "questions",
                label: t("quiz.preparing"),
                state: generationFailed ? "failed" : "running",
              },
            ]}
          />
        </section>
      ) : finalResult ? (
        <section className="px-quiz-results">
          <p className="title-1" role="status">
            {t("quiz.score", { score: Math.round(finalResult.score * 100) })}
          </p>
          <p className="small">
            {t("quiz.correctCount", {
              correct: finalResult.results.filter((row) => row.score === 1)
                .length,
              total: finalResult.results.length,
            })}
          </p>
          {finalResult.results.map((answer) => {
            const item = questions.find((row) => row.id === answer.id);
            return (
              <details key={answer.id} className="px-quiz-review">
                <summary>
                  {answer.score === 1
                    ? t("quiz.correct")
                    : t("quiz.reviewAnswer")}{" "}
                  · {item?.stem.slice(0, 90)}
                </summary>
                <MarkdownView>{item?.stem ?? ""}</MarkdownView>
                <p className="small">
                  {t("quiz.yourAnswer")}: {answerText(answer.id)}
                </p>
                <p className="body">
                  {t("quiz.expected")}: {expectedText(answer)}
                </p>
                <MarkdownView>{answer.explanation}</MarkdownView>
                <div className="px-quiz-actions">
                  {answer.score < 1 ? (
                    <Button
                      type="text"
                      shape="round"
                      onClick={() => void ask(answer.id, answer)}
                    >
                      {t("ask.askTutor")}
                    </Button>
                  ) : null}
                  <Button
                    type="text"
                    shape="round"
                    onClick={() => flag(answer.id)}
                  >
                    {t("quiz.flag")}
                  </Button>
                </div>
              </details>
            );
          })}
          <div className="px-quiz-actions">
            <label className="px-quiz-toggle">
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
                if (planId)
                  void invoke("study.markdown", {
                    planId,
                    kind: "quiz",
                    topicId,
                    answers: withAnswers,
                  })
                    .then((file) => downloadText(file.filename, file.markdown))
                    .catch(() => setActionError(true));
              }}
            >
              {t("export.markdown")}
            </Button>
          </div>
        </section>
      ) : question ? (
        <section className="px-quiz-question">
          <div ref={heading} tabIndex={-1} className="px-quiz-stem">
            <MarkdownView>{question.stem}</MarkdownView>
          </div>
          {question.grade.kind === "tf" ? (
            <div className="px-quiz-soft-time">
              <div
                className="px-quiz-soft-track"
                role="progressbar"
                aria-label={t("quiz.softTimer")}
                aria-valuemin={0}
                aria-valuemax={10}
                aria-valuenow={Math.ceil(remaining)}
              >
                <span style={{ width: `${remaining * 10}%` }} />
              </div>
              <p className="meta">{t("quiz.softHint")}</p>
            </div>
          ) : null}
          {question.grade.kind === "mcq" || question.grade.kind === "tf" ? (
            <div className="choice-list">
              {(question.grade.kind === "tf"
                ? [t("quiz.true"), t("quiz.false")]
                : (question.options ?? [])
              ).map((option, optionIndex) => {
                const value =
                  question.grade.kind === "tf"
                    ? optionIndex === 0
                      ? "true"
                      : "false"
                    : String(optionIndex);
                return (
                  <button
                    key={optionIndex}
                    type="button"
                    className={
                      picks[question.id] === value
                        ? "choice is-selected"
                        : "choice"
                    }
                    aria-pressed={picks[question.id] === value}
                    disabled={locked}
                    onClick={() => pick(value)}
                  >
                    <span className="px-quiz-letter" aria-hidden>
                      {String.fromCharCode(65 + optionIndex)}
                    </span>
                    <MarkdownView>{option}</MarkdownView>
                  </button>
                );
              })}
            </div>
          ) : question.grade.kind === "matching" ? (
            <div className="px-quiz-matching">
              {question.left?.map((left, leftIndex) => (
                <label key={leftIndex}>
                  <MarkdownView>{left}</MarkdownView>
                  <select
                    aria-label={t("quiz.matchFor", { item: left })}
                    disabled={locked}
                    value={pairs(picks[question.id])[leftIndex]?.[1] ?? ""}
                    onChange={(event) =>
                      pick(
                        JSON.stringify(
                          (question.left ?? []).map((item, itemIndex) => [
                            item,
                            itemIndex === leftIndex
                              ? event.target.value
                              : (pairs(picks[question.id])[itemIndex]?.[1] ??
                                ""),
                          ]),
                        ),
                      )
                    }
                  >
                    <option value="">{t("quiz.chooseMatch")}</option>
                    {question.right?.map((right, rightIndex) => (
                      <option key={rightIndex} value={right}>
                        {right}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : question.grade.kind === "completion" ? (
            <div className="px-quiz-blanks">
              {Array.from(
                {
                  length: Math.max(
                    1,
                    [...question.stem.matchAll(/\{\{\d+\}\}/g)].length,
                  ),
                },
                (_, blankIndex) => (
                  <label key={blankIndex}>
                    <span className="small">
                      {t("quiz.blank", { index: blankIndex + 1 })}
                    </span>
                    <Input
                      disabled={locked}
                      value={blanks(picks[question.id])[blankIndex] ?? ""}
                      onChange={(event) => {
                        const values = blanks(picks[question.id]);
                        values[blankIndex] = event.target.value;
                        pick(JSON.stringify(values));
                      }}
                    />
                  </label>
                ),
              )}
            </div>
          ) : (
            <div className="px-quiz-open">
              <Input.TextArea
                aria-label={t("quiz.yourAnswer")}
                rows={6}
                disabled={locked}
                value={picks[question.id] ?? ""}
                onChange={(event) => pick(event.target.value)}
              />
              {picks[question.id]?.includes("$") ? (
                <div className="px-quiz-preview">
                  <p className="meta">{t("quiz.preview")}</p>
                  <MarkdownView>{picks[question.id] ?? ""}</MarkdownView>
                </div>
              ) : null}
            </div>
          )}
          {result && immediate ? (
            <div className="px-quiz-feedback" role="status">
              <p className="body-strong">
                {result.score === 1
                  ? t("quiz.correct")
                  : result.score > 0
                    ? t("quiz.partial")
                    : t("quiz.incorrect")}
              </p>
              <p>
                {t("quiz.expected")}: {expectedText(result)}
              </p>
              <MarkdownView>{result.explanation}</MarkdownView>
              {result.model ? (
                <p className="meta">
                  {t("quiz.gradedBy", { model: result.model })}
                </p>
              ) : null}
              <div className="px-quiz-actions">
                {result.score < 1 ? (
                  <Button
                    type="text"
                    shape="round"
                    onClick={() => void ask(question.id, result)}
                  >
                    {t("ask.askTutor")}
                  </Button>
                ) : null}
                <Button
                  type="text"
                  shape="round"
                  onClick={() => flag(question.id)}
                >
                  {t("quiz.flag")}
                </Button>
              </div>
            </div>
          ) : null}
          {check.isPending ? (
            <p className="small" role="status">
              {t("quiz.grading")}
            </p>
          ) : null}
          <div className="px-quiz-actions">
            {immediate && !result ? (
              <Button
                type="primary"
                shape="round"
                loading={check.isPending}
                disabled={!hasAnswer || submit.isPending}
                onClick={() => check.mutate()}
              >
                {t("quiz.submit")}
              </Button>
            ) : (
              <Button
                type="primary"
                shape="round"
                loading={submit.isPending}
                onClick={next}
                disabled={index + 1 >= questions.length && !canFinish}
              >
                {t(
                  index + 1 < questions.length
                    ? "quiz.next"
                    : canFinish
                      ? "quiz.finish"
                      : "quiz.waitingBatch",
                )}
              </Button>
            )}
          </div>
        </section>
      ) : (
        <p className="small">{t("quiz.empty")}</p>
      )}
      {error ? (
        <p className="small" role="alert">
          {t(errorKey, { defaultValue: t("quiz.error") })}
        </p>
      ) : null}
    </FocusLayout>
  );
}
