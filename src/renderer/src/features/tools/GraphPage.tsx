import { Button, Input, InputNumber, Switch } from "antd";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toPng } from "html-to-image";
import katex from "katex";
import { CanvasLayout } from "../../app/layouts/TaskLayouts";
import { invoke } from "../../lib/ipc";
import {
  analyzeGraph,
  graphExpression,
  graphLatex,
  type GraphPoint,
  type GraphRange,
} from "../../../../core/math/graph-analysis";
import "./GraphPage.css";

export function GraphPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [source, setSource] = useState("sin(x)/x");
  const [extent, setExtent] = useState<GraphRange>([-8, 8]);
  const [range, setRange] = useState<GraphRange>([-8, 8]);
  const [lower, setLower] = useState(0);
  const [analysis, setAnalysis] = useState(false);
  const [symbolic, setSymbolic] = useState<{
    source: string;
    d1: string;
    d2: string;
    integral: string;
  } | null>(null);
  const [symbolicBusy, setSymbolicBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const plots = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const parsed = useMemo(() => {
    try {
      return graphExpression(source);
    } catch {
      return null;
    }
  }, [source]);
  const data = useMemo(() => {
    try {
      return parsed ? analyzeGraph(parsed, range, lower) : null;
    } catch {
      return null;
    }
  }, [parsed, range, lower]);
  const latex = parsed ? graphLatex(parsed) : source;
  const currentSymbolic = symbolic?.source === parsed ? symbolic : null;
  useEffect(() => {
    request.current++;
    return () => {
      request.current++;
    };
  }, [parsed]);

  async function findSymbolic() {
    if (!parsed) return;
    const token = ++request.current;
    setSymbolicBusy(true);
    setNotice(null);
    const runtime = await invoke("tools.runtime", {}).catch(() => null);
    if (runtime?.phase !== "ready") {
      setSymbolicBusy(false);
      setNotice(t("graph.runtimeNeeded"));
      return;
    }
    // The scalar expression has already passed the closed local grammar. JSON
    // string quoting keeps its text separate from the Python program.
    const code = `import json, sympy as s\nx = s.Symbol('x', real=True)\nf = s.sympify(${JSON.stringify(parsed.replaceAll("^", "**"))}, locals={'x':x,'e':s.E,'pi':s.pi,'abs':s.Abs})\nprint(json.dumps({'d1':s.latex(s.diff(f,x)), 'd2':s.latex(s.diff(f,x,2)), 'integral':s.latex(s.integrate(f,x))}))`;
    try {
      const result = await invoke("tools.python", { code });
      if (token !== request.current) return;
      if (result.timedOut || result.truncated || result.stderr)
        throw new Error("symbolic");
      const value = JSON.parse(result.stdout.trim());
      if (
        ![value.d1, value.d2, value.integral].every(
          (v) => typeof v === "string" && v.length < 2000,
        )
      )
        throw new Error("symbolic");
      setSymbolic({ source: parsed, ...value });
    } catch {
      if (token === request.current) setNotice(t("graph.symbolicFailed"));
    } finally {
      if (token === request.current) setSymbolicBusy(false);
    }
  }
  async function artifact(attach: boolean) {
    if (!plots.current || !parsed || !data) return;
    setBusy(true);
    setNotice(null);
    try {
      const color = getComputedStyle(document.documentElement)
        .getPropertyValue("--surface")
        .trim();
      const dataUrl = await toPng(plots.current, {
        pixelRatio: 2,
        backgroundColor: color,
      });
      if (attach) {
        const staged = await invoke("tools.stagePng", { dataUrl });
        sessionStorage.setItem("pyxis-board-file", staged.path);
        sessionStorage.setItem(
          "pyxis-draft",
          [sessionStorage.getItem("pyxis-draft") ?? "", `$f(x) = ${latex}$`]
            .filter(Boolean)
            .join("\n\n"),
        );
        navigate("/ask");
      } else {
        const saved = await window.pyxis.saveArtifact({
          filename: "graph.png",
          base64: dataUrl.split(",")[1]!,
        });
        if (saved === "saved") setNotice(t("graph.saved"));
      }
    } catch {
      setNotice(t("graph.exportFailed"));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!analysis || !parsed) return;
    let cancelled = false;
    void invoke("tools.runtime", {})
      .then((status) => {
        if (!cancelled && status.phase === "ready") void findSymbolic();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [analysis, parsed]);
  const panel = (
    id: string,
    title: string,
    expression: string,
    points: GraphPoint[][],
    color: string,
    extra?: React.ReactNode,
  ) => (
    <section className="px-graph-panel" key={id} aria-label={title}>
      <header>
        <h2 className="title-3">{title}</h2>
        <MathFormula expression={expression} />
      </header>
      {extra}
      <GraphCurve
        name={title}
        points={points}
        range={range}
        color={color}
        onRange={setRange}
        reset={() => setRange(extent)}
        help={t("graph.plotHelp")}
        height={analysis ? 240 : Math.max(300, window.innerHeight - 240)}
      />
    </section>
  );
  return (
    <CanvasLayout title={t("graph.title")} closeTo="/ask">
      <div className="px-graph">
        <aside className="px-graph-controls">
          <label className="small" htmlFor="graph-function">
            {t("graph.function")}
          </label>
          <Input
            id="graph-function"
            aria-label={t("graph.title")}
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setSymbolicBusy(false);
            }}
            maxLength={500}
          />
        <div className="px-graph-preview" role="region" aria-label={t("graph.preview")}>
            <MathFormula expression={`f(x) = ${latex}`} />
          </div>
          {!parsed ? (
            <p role="alert" className="small px-graph-error">
              {t("graph.invalid")}
            </p>
          ) : null}
          <div className="px-graph-bounds">
            <label className="small">
              {t("graph.xMin")}
              <InputNumber
                aria-label={t("graph.xMin")}
                value={extent[0]}
                onChange={(v) => v != null && setExtent([v, extent[1]])}
              />
            </label>
            <label className="small">
              {t("graph.xMax")}
              <InputNumber
                aria-label={t("graph.xMax")}
                value={extent[1]}
                onChange={(v) => v != null && setExtent([extent[0], v])}
              />
            </label>
          </div>
          <Button
            shape="round"
            onClick={() => setRange(extent)}
            disabled={!parsed || extent[0] >= extent[1]}
          >
            {t("graph.plot")}
          </Button>
          {!data && parsed ? (
            <p className="small px-graph-error" role="alert">
              {t("graph.rangeError")}
            </p>
          ) : null}
          <label className="px-graph-switch small">
            <span>{t("graph.analysis")}</span>
            <Switch
              aria-label={t("graph.analysis")}
              checked={analysis}
              onChange={setAnalysis}
            />
          </label>
          {analysis ? (
            <>
              <Button
                shape="round"
                onClick={() => void findSymbolic()}
                loading={symbolicBusy}
                disabled={!parsed}
              >
                {t("graph.symbolic")}
              </Button>
              <p className="small ink-muted">{t("graph.symbolicHint")}</p>
            </>
          ) : null}
          <p className="small ink-muted">{t("graph.plotHelp")}</p>
          <div className="px-graph-actions">
            <Button shape="round" onClick={() => setRange(extent)}>
              {t("graph.reset")}
            </Button>
            <Button
              shape="round"
              disabled={!parsed}
              onClick={() =>
                void navigator.clipboard
                  .writeText(source)
                  .then(() => setNotice(t("graph.copied")))
                  .catch(() => setNotice(t("graph.copyFailed")))
              }
            >
              {t("graph.copy")}
            </Button>
            <Button
              shape="round"
              loading={busy}
              disabled={!data}
              onClick={() => void artifact(false)}
            >
              {t("graph.download")}
            </Button>
            <Button
              type="primary"
              shape="round"
              loading={busy}
              disabled={!data}
              onClick={() => void artifact(true)}
            >
              {t("graph.attach")}
            </Button>
          </div>
          {notice ? (
            <p role="status" className="small">
              {notice}
            </p>
          ) : null}
          {notice === t("graph.runtimeNeeded") ? (
            <Button shape="round" onClick={() => navigate("/tools/python")}>
              {t("graph.preparePython")}
            </Button>
          ) : null}
        </aside>
        <div
          ref={plots}
          className={`px-graph-plots ${analysis ? "px-graph-analysis" : ""}`}
        >
          {panel("f", "f", `f(x) = ${latex}`, data?.f ?? [], "--primary")}
          {analysis ? (
            <>
              {panel(
                "d1",
                "f′",
                `f'(x) = ${currentSymbolic?.d1 ?? `\\frac{d}{dx}\\left(${latex}\\right)`}`,
                data?.d1 ?? [],
                "--ink-muted",
              )}
              {panel(
                "d2",
                "f″",
                `f''(x) = ${currentSymbolic?.d2 ?? `\\frac{d^2}{dx^2}\\left(${latex}\\right)`}`,
                data?.d2 ?? [],
                "--ink-muted",
              )}
              {panel(
                "integral",
                t("graph.integralTitle"),
                `F(x) = \\int_{${lower}}^x f(t)\\,dt`,
                data?.integral ?? [],
                "--mastery",
                <div className="px-graph-integral">
                  <label className="small">
                    {t("graph.lower")}
                    <InputNumber
                      aria-label={t("graph.lower")}
                      value={lower}
                      onChange={(v) => v != null && setLower(v)}
                    />
                  </label>
                  {currentSymbolic ? (
                    <MathFormula
                      expression={`\\int f(x)\\,dx = ${currentSymbolic.integral} + C`}
                    />
                  ) : null}
                  {!data?.integral.length ? (
                    <p className="small ink-muted">
                      {t("graph.integralUnavailable")}
                    </p>
                  ) : null}
                </div>,
              )}
            </>
          ) : null}
        </div>
      </div>
    </CanvasLayout>
  );
}
function MathFormula({ expression }: { expression: string }) {
  const html = useMemo(
    () =>
      katex.renderToString(expression, {
        throwOnError: false,
        trust: false,
        strict: "ignore",
      }),
    [expression],
  );
  return (
    <div
      className="px-graph-formula"
      tabIndex={0}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
function GraphCurve({
  name,
  points,
  range,
  color,
  onRange,
  reset,
  help,
  height,
}: {
  name: string;
  points: GraphPoint[][];
  range: GraphRange;
  color: string;
  onRange: (range: GraphRange) => void;
  reset: () => void;
  help: string;
  height: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const clipId = useId().replaceAll(":", "");
  const [plotWidth, setPlotWidth] = useState(560);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setPlotWidth(Math.max(240, Math.round(entries[0]!.contentRect.width))),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const drag = useRef<{ x: number; range: GraphRange } | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const zoom = (factor: number) => {
    const [a, b] = rangeRef.current,
      mid = (a + b) / 2,
      half = ((b - a) * factor) / 2;
    if (
      half > 1e-6 &&
      Math.max(Math.abs(mid - half), Math.abs(mid + half)) < 1e6
    )
      onRange([mid - half, mid + half]);
  };
  useEffect(() => {
    const el = ref.current;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(event.deltaY > 0 ? 1.2 : 1 / 1.2);
    };
    el?.addEventListener("wheel", wheel, { passive: false });
    return () => el?.removeEventListener("wheel", wheel);
  }, []);
  const values = points
    .flat()
    .map((p) => p.y)
    .sort((a, b) => a - b);
  // Keep a pole's extreme samples from flattening the rest of the curve.
  const low = Math.min(0, values[Math.floor(values.length * 0.02)] ?? -1),
    high = Math.max(0, values[Math.floor(values.length * 0.98)] ?? 1);
  const span = high - low || 2,
    yMin = low - span * 0.1,
    yMax = high + span * 0.1;
  const w = plotWidth,
    h = height,
    pad = 36;
  const X = (x: number) =>
    pad + ((x - range[0]) / (range[1] - range[0])) * (w - 2 * pad);
  const Y = (y: number) =>
    h - pad - ((y - yMin) / (yMax - yMin)) * (h - 2 * pad);
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${w} ${h}`}
      tabIndex={0}
      role="img"
      aria-label={name}
      aria-description={help}
      onKeyDown={(e) => {
        if (
          ["ArrowLeft", "ArrowRight", "+", "=", "-", "Home"].includes(e.key)
        ) {
          e.preventDefault();
          const width = range[1] - range[0];
          if (e.key.startsWith("Arrow")) {
            const delta = width * 0.1 * (e.key === "ArrowLeft" ? -1 : 1);
            onRange([range[0] + delta, range[1] + delta]);
          } else if (e.key === "Home") reset();
          else zoom(e.key === "-" ? 1.2 : 1 / 1.2);
        }
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, range };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const start = drag.current;
        const width = e.currentTarget.getBoundingClientRect().width;
        const delta =
          ((e.clientX - start.x) / width) * (start.range[1] - start.range[0]);
        onRange([start.range[0] - delta, start.range[1] - delta]);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={pad} y={pad} width={w - pad * 2} height={h - pad * 2} />
        </clipPath>
      </defs>
      {Array.from({ length: 5 }, (_, i) => {
        const x = range[0] + ((range[1] - range[0]) * i) / 4,
          y = yMin + ((yMax - yMin) * i) / 4;
        return (
          <g key={i}>
            <line
              x1={X(x)}
              y1={pad}
              x2={X(x)}
              y2={h - pad}
              className="px-graph-grid"
            />
            <line
              x1={pad}
              y1={Y(y)}
              x2={w - pad}
              y2={Y(y)}
              className="px-graph-grid"
            />
            <text x={X(x)} y={h - 12} textAnchor="middle">
              {Number(x.toPrecision(3))}
            </text>
            <text x={pad - 5} y={Y(y) + 4} textAnchor="end">
              {Number(y.toPrecision(3))}
            </text>
          </g>
        );
      })}
      <g clipPath={`url(#${clipId})`}>
        <line
          x1={pad}
          y1={Y(0)}
          x2={w - pad}
          y2={Y(0)}
          className="px-graph-axis"
        />
        <line
          x1={X(0)}
          y1={pad}
          x2={X(0)}
          y2={h - pad}
          className="px-graph-axis"
        />
        {points.map((part, i) => (
          <polyline
            key={i}
            fill="none"
            stroke={`var(${color})`}
            strokeWidth={2}
            points={part.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")}
          />
        ))}
      </g>
    </svg>
  );
}
