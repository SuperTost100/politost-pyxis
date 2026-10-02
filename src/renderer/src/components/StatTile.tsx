import { Card } from "antd";
import { MasteryBar } from "./MasteryBar";
import "./StatTile.css";

export function StatTile({
  label,
  value,
  unit = "%",
  target,
  pills,
  stats,
}: {
  label: string;
  value: number;
  unit?: string;
  target?: number;
  pills?: string[];
  stats?: { value: string; label: string }[];
}) {
  return (
    <Card className="px-card px-stat" variant="outlined">
      <div className="px-stat-head">
        <div>
          <div className="px-stat-label">{label}</div>
          <div className="px-stat-num">
            {value}
            <small>{unit}</small>
          </div>
        </div>
        <div className="px-stat-pills">
          {(pills ?? []).map((x) => (
            <span key={x} className="px-pill-meta">
              {x}
            </span>
          ))}
        </div>
      </div>
      <MasteryBar
        value={value}
        target={target}
        tone="primary"
        label={label}
        showValue={false}
      />
      {stats ? (
        <div className="px-stat-foot">
          {stats.map((s) => (
            <div key={s.label}>
              <b>{s.value}</b>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
