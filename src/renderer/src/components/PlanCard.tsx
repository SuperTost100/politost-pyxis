import { Card } from "antd";
import { Button } from "./Button";
import { MasteryBar } from "./MasteryBar";
import "./PlanCard.css";

export function PlanCard({
  subject,
  title,
  mastery,
  target,
  meta,
  cta,
  onContinue,
}: {
  subject?: string;
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
          <h3 className="px-plan-title">{title}</h3>
        </div>
        <MasteryBar value={mastery} target={target} />
      </div>
      <div className="px-plan-foot">
        <span className="px-plan-meta">{meta}</span>
        <Button size="sm" onClick={onContinue}>{cta ?? "Continua"}</Button>
      </div>
    </Card>
  );
}
