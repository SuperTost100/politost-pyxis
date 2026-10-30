import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Pagination, Select, Skeleton } from "antd";
import { BookOpen, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { MarkdownView } from "../../components/MarkdownView";
import { Notice } from "../../components/Notice";
import { openSourceViewer } from "../../components/SourceViewer";
import { QUIZ_MAX_QUESTIONS } from "@shared/quiz";
import { invoke } from "../../lib/ipc";
import { useGradeScale } from "../../lib/useGradeScale";
import { i18n } from "../../locales/i18n";
import { TypedAnswer } from "./TypedAnswer";
import { answerSource, blanks, pairs, stemText, verdict } from "./quizText";
import "./QuizPage.css";
import "./MistakesNotebook.css";

const PAGE_SIZE = 25;

type Entry = RequestOutput<"study.mistakes">["entries"][number];

function dateText(at: number) {
  const date = new Date(at);
  const year = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(i18n.language, {
    day: "numeric",
    month: "short",
    ...(year ? {} : { year: "numeric" }),
  }).format(date);
}

/**
 * Every question whose latest answer was wrong, by exam and topic: the Exams tab, which can narrow to one exam. Redo
 * asks the questions again as a quiz.
 */
export function MistakesNotebook() {
  const { t } = useTranslation();
  const grade = useGradeScale();
  const navigate = useNavigate();
  // The exam filter lives in the URL, so a redo can bring the student back to the same exam.
  const [search, setSearch] = useSearchParams();
  const exam = search.get("exam") ?? "";
  const setExam = (value: string) => setSearch(value ? { exam: value } : {}, { replace: true });
  const [page, setPage] = useState(1);
  const summary = useRef<HTMLParagraphElement>(null);
  const notebook = useQuery({
    queryKey: ["mistakes", null],
    queryFn: () => invoke("study.mistakes", {}),
    refetchOnMount: "always",
  });
  const redo = useMutation({
    // `target` names the button that asked, so only that one spins.
    mutationFn: ({
      planId: plan,
      keys,
    }: {
      planId: string;
      keys: string[];
      target: string;
    }) => invoke("study.mistakesRedo", { planId: plan, keys }),
    onSuccess: ({ attemptId }, input) =>
      navigate(
        `/plans/${input.planId}/redo?attempt=${attemptId}${shownExam ? `&exam=${encodeURIComponent(shownExam)}` : ""}`,
      ),
  });
  const data = notebook.data;
  // An exam that no longer has mistakes cannot filter.
  const plans = (data?.plans ?? []).filter((plan) => plan.count > 0);
  const shownExam = plans.some((plan) => plan.id === exam) ? exam : "";
  const entries = (data?.entries ?? []).filter(
    (entry) => !shownExam || entry.planId === shownExam,
  );
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);
  useEffect(() => setPage(1), [shownExam]);

  if (notebook.isError && !data)
    return (
      <Notice
        tone="danger"
        action={{
          label: t("mistakes.retry"),
          onClick: () => void notebook.refetch(),
        }}
      >
        {t("mistakes.loadFailed")}
      </Notice>
    );
  if (data && data.entries.length === 0)
    return (
      <EmptyState
        title={t("mistakes.emptyTitle")}
        body={t("mistakes.emptyBody")}
      />
    );

  // The topic's questions in the whole list, so "Redo" on a topic does not stop at the page edge.
  const topicKeys = new Map<string, string[]>();
  for (const entry of entries) {
    const run = `${entry.planId}\u0000${entry.topicId ?? ""}`;
    topicKeys.set(run, [...(topicKeys.get(run) ?? []), entry.key]);
  }
  const shown = entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const sections: Array<{
    planId: string;
    title: string;
    subject: string | null;
    runs: Array<{ key: string; topicTitle: string | null; entries: Entry[] }>;
  }> = [];
  for (const entry of shown) {
    let section = sections.at(-1);
    if (!section || section.planId !== entry.planId) {
      section = {
        planId: entry.planId,
        title: entry.planTitle,
        subject: entry.subject,
        runs: [],
      };
      sections.push(section);
    }
    const key = `${entry.planId}\u0000${entry.topicId ?? ""}`;
    let run = section.runs.at(-1);
    if (!run || run.key !== key) {
      run = { key, topicTitle: entry.topicTitle, entries: [] };
      section.runs.push(run);
    }
    run.entries.push(entry);
  }

  function answerText(entry: Entry): string {
    if (entry.kind === "mcq")
      return entry.options?.[Number(entry.pick)] ?? entry.pick;
    if (entry.kind === "tf")
      return entry.pick === "true"
        ? t("quiz.true")
        : entry.pick === "false"
          ? t("quiz.false")
          : entry.pick;
    if (entry.kind === "completion") {
      const list = blanks(entry.pick);
      return list.length ? list.join(", ") : entry.pick;
    }
    if (entry.kind === "matching")
      return pairs(entry.pick)
        .map(([left, right]) => `${left} = ${right}`)
        .join("; ");
    return entry.pick;
  }
  const expectedText = (entry: Entry) =>
    entry.kind === "tf"
      ? t(entry.expected === "true" ? "quiz.true" : "quiz.false")
      : entry.expected;

  function renderEntry(entry: Entry, index: number) {
    const long = entry.kind === "open";
    const state = verdict(entry.score) === "partial" ? "partial" : "wrong";
    const answer = answerText(entry);
    const written = answerSource(entry.kind);
    const expected = expectedText(entry);
    const source = entry.passageId
      ? { passageId: entry.passageId }
      : entry.chapter
        ? { sourceId: entry.chapter.sourceId, chapter: entry.chapter.chapter }
        : null;
    const id = `mistake-${entry.planId}-${index}`;
    return (
      <li
        key={`${entry.planId}-${entry.key}`}
        className="px-notebook-entry"
        aria-labelledby={id}
      >
        <div id={id} className="px-notebook-stem">
          <MarkdownView variant="body">{stemText(entry.stem)}</MarkdownView>
        </div>
        <div className="px-quiz-answers">
          <div className={`px-quiz-answer is-${state}`}>
            <p className="label">
              {state === "partial"
                ? t("mistakes.yourAnswerScore", {
                    score: grade.format(entry.score),
                  })
                : t("quiz.yourAnswer")}
            </p>
            {written ? (
              <p className="body">
                <TypedAnswer text={answer} source={written} />
              </p>
            ) : (
              <p className="body">
                <InlineMarkdown>{answer}</InlineMarkdown>
              </p>
            )}
          </div>
          <div className="px-quiz-answer is-expected">
            <p className="label">
              {t(long ? "quiz.reference" : "mistakes.rightAnswer")}
            </p>
            {long ? (
              <MarkdownView variant="body">{expected}</MarkdownView>
            ) : (
              <p className="body">
                <InlineMarkdown>{expected}</InlineMarkdown>
              </p>
            )}
          </div>
        </div>
        {entry.explanation ? (
          <details className="px-notebook-why">
            <summary className="small">{t("mistakes.why")}</summary>
            <MarkdownView
              variant="body"
              citationResolver={(n) => entry.citations[n - 1]?.label}
              onCitationClick={(n) => {
                const cite = entry.citations[n - 1];
                if (cite) openSourceViewer({ passageId: cite.passageId });
              }}
            >
              {entry.explanation}
            </MarkdownView>
          </details>
        ) : null}
        <div className="px-notebook-foot">
          <span className="small px-notebook-origin">
            {t("mistakes.missedIn", {
              origin: t(`mistakes.origin.${entry.origin}`),
              date: dateText(entry.at),
            })}
          </span>
          <div className="px-notebook-actions">
            {source ? (
              <Button
                type="text"
                shape="round"
                size="small"
                icon={<BookOpen size={14} aria-hidden />}
                aria-describedby={id}
                onClick={() => openSourceViewer(source)}
              >
                {t("mistakes.source")}
              </Button>
            ) : null}
            <Button
              shape="round"
              size="small"
              icon={<RotateCcw size={14} aria-hidden />}
              aria-describedby={id}
              loading={
                redo.isPending &&
                redo.variables.target === `${entry.planId}\u0000${entry.key}`
              }
              disabled={redo.isPending}
              onClick={() =>
                redo.mutate({
                  planId: entry.planId,
                  keys: [entry.key],
                  target: `${entry.planId}\u0000${entry.key}`,
                })
              }
            >
              {t("mistakes.redo")}
            </Button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <div className="px-notebook">
      {plans.length > 1 ? (
        <div className="px-notebook-toolbar">
          <div className="px-form-field">
            <label className="label" htmlFor="mistakes-exam">
              {t("cardBrowser.exam")}
            </label>
            <Select
              id="mistakes-exam"
              value={shownExam}
              onChange={setExam}
              options={[
                { value: "", label: t("cardBrowser.allExams") },
                ...plans.map((plan) => ({ value: plan.id, label: plan.title })),
              ]}
            />
          </div>
        </div>
      ) : null}
      <p
        className="small px-notebook-summary"
        role="status"
        tabIndex={-1}
        ref={summary}
      >
        {data ? t("mistakes.summary", { count: entries.length }) : " "}
      </p>
      {redo.isError ? (
        <Notice tone="danger">{t("mistakes.redoFailed")}</Notice>
      ) : null}
      {!data ? (
        <ul className="px-notebook-list" aria-hidden>
          {[0, 1].map((key) => (
            <li key={key} className="px-notebook-entry">
              <Skeleton active title={false} paragraph={{ rows: 3 }} />
            </li>
          ))}
        </ul>
      ) : (
        <>
          {sections.map((section) => (
            <section
              key={section.planId}
              className="px-notebook-exam"
              aria-labelledby={`mistakes-exam-${section.planId}`}
            >
              <header>
                  <h2
                    className="title-3"
                    id={`mistakes-exam-${section.planId}`}
                  >
                    {section.title}
                  </h2>
                  <span className="small">
                    {[
                      section.subject,
                      t("mistakes.count", {
                        count:
                          plans.find((plan) => plan.id === section.planId)
                            ?.count ?? 0,
                      }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </header>
              {section.runs.map((run) => {
                const keys = topicKeys.get(run.key) ?? [];
                const heading = `mistakes-topic-${run.key.replace(/\W/g, "-")}`;
                return (
                  <div key={run.key} className="px-notebook-run">
                    <div className="px-notebook-topic">
                      <h3 className="body-strong" id={heading}>
                        {run.topicTitle ?? t("mistakes.noTopic")}
                      </h3>
                      {keys.length > 1 ? (
                        <Button
                          type="text"
                          shape="round"
                          size="small"
                          aria-describedby={heading}
                          loading={
                            redo.isPending && redo.variables.target === run.key
                          }
                          disabled={redo.isPending}
                          onClick={() =>
                            redo.mutate({
                              planId: section.planId,
                              keys,
                              target: run.key,
                            })
                          }
                        >
                          {t("mistakes.redoTopic", {
                            count: Math.min(keys.length, QUIZ_MAX_QUESTIONS),
                          })}
                        </Button>
                      ) : null}
                    </div>
                    <ul className="px-notebook-list" aria-labelledby={heading}>
                      {run.entries.map((entry) =>
                        renderEntry(entry, entries.indexOf(entry)),
                      )}
                    </ul>
                  </div>
                );
              })}
            </section>
          ))}
          {entries.length > PAGE_SIZE ? (
            <Pagination
              className="px-notebook-pages"
              align="center"
              current={page}
              total={entries.length}
              pageSize={PAGE_SIZE}
              showSizeChanger={false}
              onChange={(next) => {
                setPage(next);
                summary.current?.scrollIntoView({ block: "start" });
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
