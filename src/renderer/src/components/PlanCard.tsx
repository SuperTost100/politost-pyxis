import { Tag } from "./Tag";
import { Card } from "antd";
import { Button } from "./Button";
import { MasteryBar } from "./MasteryBar";
import "./PlanCard.css";

export function PlanCard({
  subject,
  importedLabel,
  continueLabel,
  title,
  mastery,
  target,
  meta,
  cta,
  onContinue,
}: {
  subject?: string;
  importedLabel?: string;
  continueLabel?: string;
  title: string;
  mastery: number;
  target?: number;
  meta: string;
  cta?: string;
  onContinue?: () => void;
}) {
  return (
    <Card className="px-card px-plan" variant="outlined">
      <div className="px-plan-top">
        <div>
          {subject ? <div className="px-plan-subject">{subject}</div> : null}
          {importedLabel && <Tag tone="neutral">{importedLabel}</Tag>}
          <h2 className="px-plan-title">{title}</h2>
        </div>
        <MasteryBar value={mastery} target={target} label={title} />
      </div>
      <div className="px-plan-foot">
        <span className="px-plan-meta">{meta}</span>
        <Button aria-label={continueLabel} variant="secondary" size="sm" onClick={onContinue}>
          {cta ?? "Continua"}
        </Button>
      </div>
    </Card>
  );
}
