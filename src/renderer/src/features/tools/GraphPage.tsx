import { Button, Input } from "antd";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CanvasLayout } from "../../app/layouts/TaskLayouts";
import {
  derivative,
  evalExpr,
  sample,
  secondDerivative,
  simpson,
  splitSeries,
} from "../../../../core/math/plot";

const A = -8;
const B = 8;

export function GraphPage() {
  const { t } = useTranslation();
  const [source, setSource] = useState("sin(x)/x");
  const [expr, setExpr] = useState("sin(x)/x");
  const series = useMemo(() => {
    try {
      return {
        f: sample(expr, A, B),
        d1: fillDeriv(expr, derivative),
        d2: fillDeriv(expr, secondDerivative),
        area: simpson(expr, 0.05, B),
        error: null as string | null,
      };
    } catch {
      return { f: [], d1: [], d2: [], area: 0, error: t("graph.invalid") };
    }
  }, [expr, t]);

  return (
    <CanvasLayout title={t("graph.title")} closeTo="/ask">
      <div className="gallery-row">
        <Input
          aria-label={t("graph.title")}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          style={{ maxWidth: 280 }}
        />
        <Button type="primary" shape="round" onClick={() => setExpr(source)}>
          {t("graph.plot")}
        </Button>
        <span className="small">
          {t("graph.integral", { value: series.area.toFixed(3) })}
        </span>
      </div>
      {series.error ? <p className="small">{series.error}</p> : null}
      <Curve
        f={series.f}
        d1={series.d1}
        d2={series.d2}
        fAt={(x) => evalExpr(expr, x)}
        d1At={(x) => derivative(expr, x)}
        d2At={(x) => secondDerivative(expr, x)}
      />
      <p className="small">{t("graph.legend")}</p>
    </CanvasLayout>
  );
}

function fillDeriv(source: string, fn: (source: string, x: number) => number) {
  const points = [];
  for (let i = 0; i <= 160; i += 1) {
    const x = A + ((B - A) * i) / 160;
    if (Math.abs(x) < 1e-3) continue;
    const y = fn(source, x);
    if (Number.isFinite(y)) points.push({ x, y });
  }
  return points;
}

function Curve(props: {
  f: Array<{ x: number; y: number }>;
  d1: Array<{ x: number; y: number }>;
  d2: Array<{ x: number; y: number }>;
  fAt: (x: number) => number;
  d1At: (x: number) => number;
  d2At: (x: number) => number;
}) {
  const w = 960;
  const h = 420;
  const ys = [...props.f, ...props.d1, ...props.d2].map((point) => point.y);
  const minY = Math.min(-1, ...ys);
  const maxY = Math.max(1, ...ys);
  const X = (x: number) => ((x - A) / (B - A)) * (w - 40) + 20;
  const Y = (y: number) => h - 20 - ((y - minY) / (maxY - minY || 1)) * (h - 40);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="f" style={{ width: "100%", height: "60vh" }}>
      <line x1={20} y1={Y(0)} x2={w - 20} y2={Y(0)} stroke="currentColor" strokeWidth={1} />
      {splitSeries(props.f, props.fAt).map((part, index) => (
        <polyline key={`f${index}`} fill="none" stroke="var(--mastery, #3dbe8b)" strokeWidth={2} points={path(part, X, Y)} />
      ))}
      {splitSeries(props.d1, props.d1At).map((part, index) => (
        <polyline key={`d${index}`} fill="none" stroke="var(--primary, #3262db)" strokeWidth={1.5} points={path(part, X, Y)} />
      ))}
      {splitSeries(props.d2, props.d2At).map((part, index) => (
        <polyline key={`s${index}`} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="4 4" points={path(part, X, Y)} />
      ))}
    </svg>
  );
}

function path(
  points: Array<{ x: number; y: number }>,
  X: (x: number) => number,
  Y: (y: number) => number,
) {
  return points.map((point) => `${X(point.x)},${Y(point.y)}`).join(" ");
}
