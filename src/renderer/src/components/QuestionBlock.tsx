import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { questionFeedback, type ChatQuestion } from "@shared/chat-blocks";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { InlineMarkdown } from "./InlineMarkdown";
import { Working } from "./Working";
import "./QuestionBlock.css";

/**
 * A ```pyxis-question block of a chat answer: a practice question the student answers where it stands. The options are
 * a radio group; «Controlla» keeps the pick with the reply (`onCheck`, given as the option's place in the block) and
 * shows the right option, the student's, and the feedback. «Un'altra domanda» asks the chat for one more. It counts
 * nowhere: no grade, mistake, mastery, review or study time.
 *
 * `pick` is the stored answer, as the option's place in the block. A reply still being written (`drawing`) shows the
 * question without letting it be answered, and a block not whole yet as a placeholder; one that does not validate is a
 * quiet line.
 */
export function QuestionBlock({
  question,
  pick,
  drawing = false,
  onCheck,
  onAnother,
  onPicking,
}: {
  question: ChatQuestion | null;
  pick?: number;
  drawing?: boolean;
  onCheck?: (questionId: string, pick: number) => Promise<number>;
  onAnother?: () => void;
  onPicking?: (questionId: string, picking: boolean) => void;
}) {
  const { t } = useTranslation();
  if (!question) {
    if (drawing) return <Working className="px-qb-pending" line={t("components.question.writing")} />;
    return <p className="small px-qb-failed">{t("components.question.failed")}</p>;
  }
  return (
    <Question
      key={question.id}
      question={question}
      pick={pick}
      live={!drawing && Boolean(onCheck)}
      onCheck={onCheck}
      onAnother={onAnother}
      onPicking={onPicking}
    />
  );
}

function Question({
  question,
  pick,
  live,
  onCheck,
  onAnother,
  onPicking,
}: {
  question: ChatQuestion;
  pick?: number;
  live: boolean;
  onCheck?: (questionId: string, pick: number) => Promise<number>;
  onAnother?: () => void;
  onPicking?: (questionId: string, picking: boolean) => void;
}) {
  const { t } = useTranslation();
  // The stored pick is the option's place in the block; the chat shows the options in their own order.
  const [stored, setStored] = useState<number | undefined>(pick === undefined ? undefined : question.order.indexOf(pick));
  useEffect(() => {
    if (pick !== undefined) setStored(question.order.indexOf(pick));
  }, [pick, question.order]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  const actions = useRef<HTMLDivElement>(null);
  const checkedHere = useRef(false);
  const done = stored !== undefined && stored >= 0;
  // While an option is picked and not checked, «Controlla» is the next step and the composer's Invia goes quiet.
  const picking = chosen !== null && !done && live;
  useEffect(() => {
    if (!picking) return;
    onPicking?.(question.id, true);
    return () => onPicking?.(question.id, false);
  }, [picking, onPicking, question.id]);
  useEffect(() => {
    if (done && checkedHere.current) actions.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [done]);

  async function check() {
    if (chosen === null || !onCheck || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const kept = await onCheck(question.id, question.order[chosen]!);
      checkedHere.current = true;
      setStored(question.order.indexOf(kept));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  // Arrows move the choice within the group, as in any radio group; Enter or Space picks the focused option.
  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = question.options.length;
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? (index + 1) % count
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? (index - 1 + count) % count
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      setChosen(next);
      options.current[next]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setChosen(index);
    }
  }

  const right = done && stored === question.answer;
  const feedback = done ? questionFeedback(question, stored) : "";
  const focusable = chosen ?? 0;
  return (
    <section className={done ? "px-qb is-done" : "px-qb"} aria-label={t("components.question.label")}>
      <p className="px-qb-kicker">{t("components.question.label")}</p>
      <div className="px-qb-text">
        <InlineMarkdown>{question.question}</InlineMarkdown>
      </div>
      <div className="px-qb-options" role="radiogroup" aria-label={t("components.question.options")} aria-disabled={done || !live || undefined}>
        {question.options.map((option, index) => {
          const isRight = done && index === question.answer;
          const isWrong = done && index === stored && !right;
          const checked = done ? index === stored : chosen === index;
          return (
            <button
              key={index}
              ref={(node) => {
                options.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-disabled={done || !live || undefined}
              tabIndex={done || !live ? -1 : index === focusable ? 0 : -1}
              className={["px-qb-option", isRight && "is-right", isWrong && "is-wrong", !done && checked && "is-chosen"]
                .filter(Boolean)
                .join(" ")}
              onClick={done || !live ? undefined : () => setChosen(index)}
              onKeyDown={done || !live ? undefined : (event) => onKey(event, index)}
            >
              <span className="px-qb-key" aria-hidden>
                {String.fromCharCode(65 + index)}
              </span>
              <span className="px-qb-option-text">
                <InlineMarkdown>{option}</InlineMarkdown>
              </span>
              {isRight ? (
                <span className="px-qb-state">
                  <Icon name="check" size={16} strokeWidth={2} />
                  {t("components.question.right")}
                </span>
              ) : isWrong ? (
                <span className="px-qb-state">
                  <Icon name="circle-x" size={16} strokeWidth={2} />
                  {t("components.question.yours")}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div aria-live="polite">
        {done ? (
          <p className={right ? "px-qb-why is-right" : "px-qb-why"}>
            <b>{right ? t("components.question.correct") : t("components.question.notQuite")}</b>{" "}
            {feedback ? <InlineMarkdown>{feedback}</InlineMarkdown> : null}
          </p>
        ) : failed ? (
          <p className="small px-qb-error" role="alert">
            {t("components.question.saveFailed")}
          </p>
        ) : null}
      </div>
      <div ref={actions} className="px-qb-actions">
        {done ? (
          onAnother ? (
            <Button size="sm" variant="secondary" onClick={onAnother}>
              {t("components.question.another")}
            </Button>
          ) : null
        ) : (
          <Button
            size="sm"
            variant={chosen !== null && live ? "primary" : "secondary"}
            disabled={chosen === null || !live || busy}
            onClick={() => void check()}
          >
            {t("components.question.check")}
          </Button>
        )}
        <small className="px-qb-note">{t("components.question.practice")}</small>
      </div>
    </section>
  );
}
