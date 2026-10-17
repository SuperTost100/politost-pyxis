import { Button, Input, InputNumber, Switch } from "antd";
import { Plus } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toPng } from "html-to-image";
import katex from "katex";
import { CanvasLayout } from "../../app/layouts/TaskLayouts";
import { IconButton } from "../../components/IconButton";
import { invoke } from "../../lib/ipc";
import { draftKey, lastAskChat } from "../ask/attachments";
import {
  analyzeGraph,
  graphExpression,
  graphIntersections,
  graphLatex,
  type GraphPoint,
  type GraphRange,
} from "../../../../core/math/graph-analysis";
import "./GraphPage.css";

/** Up to four curves. Each has a name, a color and a dash pattern, so curves are told apart without color too. */
const STYLES = [
  { name: "f", color: "--primary" },
  { name: "g", color: "--mastery", dash: "7 4" },
  { name: "h", color: "--star", dash: "2 4" },
  { name: "k", color: "--ink-muted", dash: "10 4 2 4" },
] as const;
type CurveStyle = (typeof STYLES)[number];
type Series = { points: GraphPoint[][]; style: CurveStyle };
type Meeting = GraphPoint & { a: string; b: string };
type Symbolic = { d1: string; d2: string; integral: string };

function parse(source: string): string | null {
  try {
    return graphExpression(source);
  } catch {
    return null;
  }
}
const coordinate = (value: number) => String(Number(value.toPrecision(4)));

export function GraphPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const nextKey = useRef(1);
  const [curves, setCurves] = useState([{ key: 0, source: "sin(x)/x" }]);
  const [extent, setExtent] = useState<GraphRange>([-8, 8]);
  const [range, setRange] = useState<GraphRange>([-8, 8]);
  const [lower, setLower] = useState(0);
  const [analysis, setAnalysis] = useState(false);
  // Exact expressions by the parsed formula they belong to.
  const [symbolic, setSymbolic] = useState<Record<string, Symbolic>>({});
  const [symbolicBusy, setSymbolicBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const plots = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const parsed = useMemo(
    () => curves.map((curve) => parse(curve.source)),
    [curves],
  );
  const plotted = useMemo(
    () =>
      curves.flatMap((curve, index) => {
        const formula = parsed[index];
        if (!formula) return [];
        try {
          const data = analyzeGraph(formula, range, lower);
          return [
            { key: curve.key, formula, style: STYLES[index]!, data, latex: graphLatex(formula) },
          ];
        } catch {
          return [];
        }
      }),
    [curves, parsed, range, lower],
  );
  const formulas = parsed.filter((item): item is string => item != null);
  const formulasKey = formulas.join("\n");
  const meetings = useMemo(() => {
    const found: Meeting[] = [];
    plotted.forEach((first, i) =>
      plotted.slice(i + 1).forEach((second) => {
        for (const point of graphIntersections(first.data.at, second.data.at, range))
          found.push({ ...point, a: first.style.name, b: second.style.name });
      }),
    );
    return found;
  }, [plotted, range]);
  useEffect(() => {
    request.current++;
    return () => {
      request.current++;
    };
  }, [formulasKey]);

  function edit(key: number, source: string) {
    setCurves((current) =>
      current.map((curve) => (curve.key === key ? { ...curve, source } : curve)),
    );
    setSymbolicBusy(false);
  }
  async function findSymbolic() {
    const missing = [...new Set(formulas)].filter((formula) => !symbolic[formula]);
    if (!missing.length) return;
    const token = ++request.current;
    setSymbolicBusy(true);
    setNotice(null);
    const runtime = await invoke("tools.runtime", {}).catch(() => null);
    if (runtime?.phase !== "ready") {
      setSymbolicBusy(false);
      setNotice(t("graph.runtimeNeeded"));
      return;
    }
    // Every expression has already passed the closed local grammar. JSON string quoting keeps its text separate from
    // the Python program, and one curve that SymPy cannot handle leaves the others' results.
    const sources = JSON.stringify(missing.map((formula) => formula.replaceAll("^", "**")));
    const code = `import json, sympy as s\nx = s.Symbol('x', real=True)\nout = []\nfor source in ${sources}:\n    try:\n        f = s.sympify(source, locals={'x':x,'e':s.E,'pi':s.pi,'abs':s.Abs})\n        out.append({'d1':s.latex(s.diff(f,x)), 'd2':s.latex(s.diff(f,x,2)), 'integral':s.latex(s.integrate(f,x))})\n    except Exception:\n        out.append(None)\nprint(json.dumps(out))`;
    try {
      const result = await invoke("tools.python", { code });
      if (token !== request.current) return;
      if (result.timedOut || result.truncated || result.stderr)
        throw new Error("symbolic");
      const values: unknown = JSON.parse(result.stdout.trim());
      if (!Array.isArray(values) || values.length !== missing.length)
        throw new Error("symbolic");
      const found: Record<string, Symbolic> = {};
      values.forEach((value: Partial<Symbolic> | null, index) => {
        if (
          value &&
          [value.d1, value.d2, value.integral].every(
            (v) => typeof v === "string" && v.length < 2000,
          )
        )
          found[missing[index]!] = value as Symbolic;
      });
      setSymbolic((current) => ({ ...current, ...found }));
      if (Object.keys(found).length < missing.length)
        setNotice(t("graph.symbolicFailed"));
    } catch {
      if (token === request.current) setNotice(t("graph.symbolicFailed"));
    } finally {
      if (token === request.current) setSymbolicBusy(false);
    }
  }
  async function artifact(attach: boolean) {
    if (!plots.current || !plotted.length) return;
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
        // Back to the chat the student came from, with the formulas added to that chat's draft.
        const chat = lastAskChat(sessionStorage);
        sessionStorage.setItem(
          draftKey(chat),
          [
            sessionStorage.getItem(draftKey(chat)) ?? "",
            plotted
              .map((curve) => `$${curve.style.name}(x) = ${curve.latex}$`)
              .join("\n"),
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        navigate(chat ? `/ask/${chat}` : "/ask");
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
    if (!analysis || !formulas.length) return;
    let cancelled = false;
    void invoke("tools.runtime", {})
      .then((status) => {
        if (!cancelled && status.phase === "ready") void findSymbolic();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [analysis, formulasKey]);
  const panel = (
    id: string,
    title: string,
    rows: Array<{ key: number; style: CurveStyle; expression: string }>,
    series: Series[],
    extra?: React.ReactNode,
    markers?: Meeting[],
  ) => (
    <section className="px-graph-panel" key={id} aria-label={title}>
      <header>
        <h2 className="title-3">{title}</h2>
        {rows.map((row) => (
          <div className="px-graph-formula-row" key={row.key}>
            <Swatch style={row.style} />
            <MathFormula expression={row.expression} />
          </div>
        ))}
      </header>
      {extra}
      <GraphCurve
        name={title}
        series={series}
        markers={markers}
        range={range}
        onRange={setRange}
        reset={() => setRange(extent)}
        help={t("graph.plotHelp")}
        height={analysis ? 240 : Math.max(300, window.innerHeight - 240)}
      />
    </section>
  );
  const names = (suffix: string) =>
    plotted.map((curve) => `${curve.style.name}${suffix}`).join(", ") ||
    `f${suffix}`;
  const rows = (expression: (curve: (typeof plotted)[number]) => string) =>
    plotted.map((curve) => ({
      key: curve.key,
      style: curve.style,
      expression: expression(curve),
    }));
  const exact = (curve: (typeof plotted)[number]) => symbolic[curve.formula];
  return (
    <CanvasLayout title={t("graph.title")} closeTo="/ask">
      <div className="px-graph">
        <aside className="px-graph-controls">
          <p className="small" id="graph-functions">
            {t("graph.functions")}
          </p>
          <div className="px-graph-curves" role="group" aria-labelledby="graph-functions">
            {curves.map((curve, index) => {
              const style = STYLES[index]!;
              return (
                <Fragment key={curve.key}>
                  <div className="px-graph-curve">
                    <span className="meta px-graph-name" aria-hidden>
                      <Swatch style={style} />
                      {style.name}(x)
                    </span>
                    <Input
                      aria-label={t("graph.curveLabel", { name: style.name })}
                      value={curve.source}
                      onChange={(e) => edit(curve.key, e.target.value)}
                      maxLength={500}
                    />
                    {curves.length > 1 ? (
                      <IconButton
                        icon="x"
                        size="sm"
                        variant="ghost"
                        label={t("graph.removeCurve", { name: style.name })}
                        onClick={() =>
                          setCurves((current) =>
                            current.filter((item) => item.key !== curve.key),
                          )
                        }
                      />
                    ) : null}
                  </div>
                  {!parsed[index] ? (
                    <p role="alert" className="small px-graph-error">
                      {t("graph.invalid")}
                    </p>
                  ) : null}
                </Fragment>
              );
            })}
          </div>
          {curves.length < STYLES.length ? (
            <Button
              shape="round"
              icon={<Plus size={16} aria-hidden />}
              onClick={() =>
                setCurves((current) => [
                  ...current,
                  { key: nextKey.current++, source: "" },
                ])
              }
            >
              {t("graph.addCurve")}
            </Button>
          ) : null}
          <div className="px-graph-preview" role="region" aria-label={t("graph.preview")}>
            {curves.map((curve, index) =>
              parsed[index] ? (
                <MathFormula
                  key={curve.key}
                  expression={`${STYLES[index]!.name}(x) = ${graphLatex(parsed[index]!)}`}
                />
              ) : null,
            )}
          </div>
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
            disabled={!formulas.length || extent[0] >= extent[1]}
          >
            {t("graph.plot")}
          </Button>
          {!plotted.length && formulas.length ? (
            <p className="small px-graph-error" role="alert">
              {t("graph.rangeError")}
            </p>
          ) : null}
          {plotted.length > 1 ? (
            <section className="px-graph-meets" aria-labelledby="graph-meets">
              <h2 className="label" id="graph-meets">
                {t("graph.intersections")}
              </h2>
              {meetings.length ? (
                <ul tabIndex={0} aria-labelledby="graph-meets">
                  {meetings.map((point, index) => (
                    <li key={index}>
                      <span className="small">
                        {t("graph.pair", { a: point.a, b: point.b })}
                      </span>
                      <span className="meta">
                        ({coordinate(point.x)}, {coordinate(point.y)})
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small ink-muted">{t("graph.noIntersections")}</p>
              )}
            </section>
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
                disabled={!formulas.length}
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
              disabled={!formulas.length}
              onClick={() => {
                const valid = curves.filter((_, index) => parsed[index]);
                void navigator.clipboard
                  .writeText(
                    valid.length === 1
                      ? valid[0]!.source
                      : curves
                          .map((curve, index) =>
                            parsed[index]
                              ? `${STYLES[index]!.name}(x) = ${curve.source}`
                              : "",
                          )
                          .filter(Boolean)
                          .join("\n"),
                  )
                  .then(() =>
                    setNotice(t("graph.copied", { count: valid.length })),
                  )
                  .catch(() => setNotice(t("graph.copyFailed")));
              }}
            >
              {t("graph.copy", { count: Math.max(1, formulas.length) })}
            </Button>
            <Button
              shape="round"
              loading={busy}
              disabled={!plotted.length}
              onClick={() => void artifact(false)}
            >
              {t("graph.download")}
            </Button>
            <Button
              type="primary"
              shape="round"
              loading={busy}
              disabled={!plotted.length}
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
          {panel(
            "f",
            names(""),
            rows((curve) => `${curve.style.name}(x) = ${curve.latex}`),
            plotted.map((curve) => ({ points: curve.data.f, style: curve.style })),
            undefined,
            meetings,
          )}
          {analysis ? (
            <>
              {panel(
                "d1",
                names("′"),
                rows(
                  (curve) =>
                    `${curve.style.name}'(x) = ${exact(curve)?.d1 ?? `\\frac{d}{dx}\\left(${curve.latex}\\right)`}`,
                ),
                plotted.map((curve) => ({ points: curve.data.d1, style: curve.style })),
              )}
              {panel(
                "d2",
                names("″"),
                rows(
                  (curve) =>
                    `${curve.style.name}''(x) = ${exact(curve)?.d2 ?? `\\frac{d^2}{dx^2}\\left(${curve.latex}\\right)`}`,
                ),
                plotted.map((curve) => ({ points: curve.data.d2, style: curve.style })),
              )}
              {panel(
                "integral",
                t("graph.integralTitle"),
                rows(
                  (curve) =>
                    `${curve.style.name.toUpperCase()}(x) = \\int_{${lower}}^x ${curve.style.name}(t)\\,dt`,
                ),
                plotted.map((curve) => ({
                  points: curve.data.integral,
                  style: curve.style,
                })),
                <div className="px-graph-integral">
                  <label className="small">
                    {t("graph.lower")}
                    <InputNumber
                      aria-label={t("graph.lower")}
                      value={lower}
                      onChange={(v) => v != null && setLower(v)}
                    />
                  </label>
                  {plotted.map((curve) =>
                    exact(curve) ? (
                      <MathFormula
                        key={curve.key}
                        expression={`\\int ${curve.style.name}(x)\\,dx = ${exact(curve)!.integral} + C`}
                      />
                    ) : null,
                  )}
                  {plotted.some((curve) => !curve.data.integral.length) ? (
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
/** The curve's line as drawn in the plots: its color and dash pattern. */
function Swatch({ style }: { style: CurveStyle }) {
  return (
    <svg className="px-graph-swatch" viewBox="0 0 24 8" aria-hidden>
      <line
        x1="1"
        y1="4"
        x2="23"
        y2="4"
        stroke={`var(${style.color})`}
        strokeWidth={2.5}
        strokeDasharray={"dash" in style ? style.dash : undefined}
      />
    </svg>
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
  series,
  markers = [],
  range,
  onRange,
  reset,
  help,
  height,
}: {
  name: string;
  series: Series[];
  markers?: Meeting[];
  range: GraphRange;
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
  const values = series
    .flatMap((item) => item.points.flat())
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
        {series.map((item) =>
          item.points.map((part, i) => (
            <polyline
              key={`${item.style.name}-${i}`}
              fill="none"
              stroke={`var(${item.style.color})`}
              strokeWidth={2}
              strokeDasharray={"dash" in item.style ? item.style.dash : undefined}
              points={part.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")}
            />
          )),
        )}
        {markers.map((point, i) => (
          <circle
            key={i}
            className="px-graph-meet"
            cx={X(point.x)}
            cy={Y(point.y)}
            r={4.5}
          >
            <title>{`${point.a} ∩ ${point.b}: (${coordinate(point.x)}, ${coordinate(point.y)})`}</title>
          </circle>
        ))}
      </g>
    </svg>
  );
}
