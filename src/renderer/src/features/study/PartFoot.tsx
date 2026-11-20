import { Layers, PencilLine, RotateCcw } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { ChoiceMenu } from "../../components/ListToolbar";

export type OtherChoice = "practice" | "cards" | "reread";

/**
 * The end of a lesson part: what it was about ("Fine della parte 3" and its two-line summary), then one primary
 * Continua that names where it goes, a quiet "Scegli altro" with the topic's exercises, its flashcards and a part to
 * reread, and "Per oggi basta" back to the exam. At the end of the lesson, when a step follows it, the way to the exam
 * is a quiet button of its own, "Torna all'esame", right after Continua. Until the part is done its buttons stay quiet;
 * a part with no question offers "Fatto" first. The page moves the focus to Continua after the answer (`continueRef`).
 */
export function PartFoot({
  heading,
  summary,
  active,
  continueLabel,
  continueMinutes,
  continueNote,
  onContinue,
  busy,
  done,
  other,
  onOther,
  onEnough,
  onExam,
  continueRef,
  failed,
}: {
  heading: string;
  summary: string | null;
  /** The part is done: Continua is the primary action. */
  active: boolean;
  continueLabel: ReactNode;
  continueMinutes?: number;
  /** Quiet text beside the label of Continua, such as how many questions the quiz it opens has. */
  continueNote?: string;
  onContinue: () => void;
  /** What is running: Fatto or Continua. */
  busy?: "done" | "continue";
  /** "Fatto" on a part with no question, until it is done. */
  done?: () => void;
  other: { topic: string; practice: number | null; cardsDue: number | null; cardsNone: boolean; reread: boolean };
  onOther: (choice: OtherChoice) => void;
  /** "Per oggi basta"; absent when Continua already goes to the exam, so the foot has one way out. */
  onEnough?: () => void;
  /** The end of the lesson with a step after it: "Torna all'esame" replaces "Per oggi basta" and follows Continua. */
  onExam?: () => void;
  continueRef: RefObject<HTMLDivElement | null>;
  failed?: boolean;
}) {
  const { t } = useTranslation();
  const line = (title: string, detail: string | null) => (
    <span className="px-part-other">
      <span>
        <InlineMarkdown>{title}</InlineMarkdown>
      </span>
      {detail ? <span className="px-part-other-detail">{detail}</span> : null}
    </span>
  );
  const items = [
    {
      key: "practice",
      icon: <PencilLine size={16} strokeWidth={1.75} aria-hidden />,
      label: line(
        t("lesson.otherPractice", { topic: other.topic }),
        other.practice ? t("lesson.otherPracticeCount", { count: other.practice }) : null,
      ),
    },
    {
      key: "cards",
      icon: <Layers size={16} strokeWidth={1.75} aria-hidden />,
      label: line(
        t("lesson.otherCards", { topic: other.topic }),
        other.cardsNone
          ? t("lesson.otherCardsNone")
          : other.cardsDue
            ? t("lesson.otherCardsDue", { count: other.cardsDue })
            : null,
      ),
    },
    ...(other.reread
      ? [
          {
            key: "reread",
            icon: <RotateCcw size={16} strokeWidth={1.75} aria-hidden />,
            label: line(t("lesson.otherReread"), t("lesson.otherRereadHint")),
          },
        ]
      : []),
  ];
  return (
    <section className={`px-part-foot${active ? " is-active" : ""}`} aria-labelledby="px-part-foot-title">
      <p id="px-part-foot-title" className="px-part-foot-title">
        {heading}
      </p>
      {summary ? (
        <p className="px-part-foot-summary">
          <InlineMarkdown>{summary}</InlineMarkdown>
        </p>
      ) : null}
      <div className="px-part-foot-actions">
        {done && !active ? (
          <Button size="lg" onClick={done} disabled={busy === "done"}>
            {t("lesson.done")}
          </Button>
        ) : null}
        <div ref={continueRef} className="px-part-continue">
          <Button
            size="lg"
            variant={active ? "primary" : "secondary"}
            onClick={onContinue}
            disabled={busy === "continue"}
          >
            <span className="px-part-continue-label">{continueLabel}</span>
            {continueMinutes ? (
              <span className="px-part-continue-minutes">{t("lesson.minutesShort", { count: continueMinutes })}</span>
            ) : continueNote ? (
              <span className="px-part-continue-minutes">{continueNote}</span>
            ) : null}
          </Button>
        </div>
        {onExam ? (
          <Button variant="secondary" size="lg" onClick={onExam}>
            {t("places.backToExam")}
          </Button>
        ) : null}
        <div className="px-part-foot-other">
          <ChoiceMenu label={t("lesson.chooseOther")} items={items} onSelect={(key) => onOther(key as OtherChoice)} />
        </div>
        {onExam || !onEnough ? null : (
          <Button variant="ghost" className="px-part-enough" onClick={onEnough}>
            {t("lesson.enough")}
          </Button>
        )}
      </div>
      {failed ? (
        <p className="small px-reader-error" role="alert">
          {t("planOverview.failed")}
        </p>
      ) : null}
    </section>
  );
}
