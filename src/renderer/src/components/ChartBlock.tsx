import type { MenuProps } from "antd";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatChartValue, parseChart, type ChartData } from "@shared/chat-blocks";
import { copyImage, saveImage } from "../lib/imageActions";
import { imageFileName } from "../lib/imageName";
import { chartDomain, chartRows } from "./chartScale";
import { Icon } from "./Icon";
import { ImageViewer } from "./ImageViewer";
import { MenuButton, useItemMenu } from "./ItemMenu";
import { Working } from "./Working";
import figtree from "../design-system/fonts/Figtree-Variable.woff2?url";
import "./ChartBlock.css";

/**
 * A ```pyxis-chart block of a chat answer: a bar or line chart the app draws from the block's numbers, in the theme's
 * own colours, with the same data as a table. While the answer is still written and the block is not whole yet
 * (`drawing`), its place is held by a placeholder the chart then grows out of. A block that does not validate is one
 * quiet line, never its JSON. `still` draws it for print: no menu, no hover.
 */
export function ChartBlock({ body, drawing = false, still = false }: { body: string; drawing?: boolean; still?: boolean }) {
  const { t } = useTranslation();
  const chart = useMemo(() => parseChart(body), [body]);
  const waited = useRef(false);
  if (!chart) {
    if (drawing) {
      waited.current = true;
      return <ChartPending />;
    }
    return <p className="small px-chart-failed">{t("components.chart.failed")}</p>;
  }
  return <Chart chart={chart} arriving={waited.current} still={still} />;
}

/** The chart's place while the answer writes it: the working mark, what is being made, and grey bars at its size. */
function ChartPending() {
  const { t } = useTranslation();
  return (
    <div className="px-chart is-pending">
      <Working line={t("components.chart.drawing")} />
      <div className="px-chart-ghost" aria-hidden>
        {[
          [60, 86],
          [52, 70],
          [88, 80],
          [66, 56],
          [74, 30],
        ].map(([label, bar], index) => (
          <div key={index} className="px-chart-ghost-row">
            <i style={{ width: `${label}%` }} />
            <i style={{ width: `${bar}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

type Size = { width: number; font: number; family: string };
type Action = "zoom" | "table" | "download" | "copy";

/** Text width in the chart's font, measured once per text. */
function measurer(size: Size) {
  const context = document.createElement("canvas").getContext("2d");
  const cache = new Map<string, number>();
  return (text: string, weight = 400) => {
    const key = `${weight}\n${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      if (context) context.font = `${weight} ${size.font}px ${size.family}`;
      width = context ? context.measureText(text).width : text.length * size.font * 0.55;
      cache.set(key, width);
    }
    return width;
  };
}

/** `text` cut with an ellipsis to fit `room` pixels; the whole text stays in the tooltip and the table. */
function fit(text: string, room: number, measure: (text: string) => number): string {
  if (measure(text) <= room) return text;
  let cut = text.length;
  while (cut > 1 && measure(`${text.slice(0, cut).trimEnd()}…`) > room) cut--;
  return `${text.slice(0, cut).trimEnd()}…`;
}

/** A bar from `from` to `to` along x, `height` tall, with its data end rounded and its base square. */
function barPath(from: number, to: number, y: number, height: number): string {
  const r = Math.min(4, Math.abs(to - from), height / 2);
  const dir = to >= from ? 1 : -1;
  const end = to - dir * r;
  return `M${from},${y}H${end}Q${to},${y} ${to},${y + r}V${y + height - r}Q${to},${y + height} ${end},${y + height}H${from}Z`;
}

function Chart({ chart, arriving, still }: { chart: ChartData; arriving: boolean; still: boolean }) {
  const { t, i18n } = useTranslation();
  const wrap = useRef<HTMLDivElement>(null);
  const plot = useRef<SVGSVGElement>(null);
  const dots = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [active, setActive] = useState<{ index: number; focus: boolean } | null>(null);
  const [table, setTable] = useState(false);
  const [said, setSaid] = useState<"copied" | "saved" | "failed" | null>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const locale = i18n.language;

  useLayoutEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const read = () => {
      const style = getComputedStyle(element);
      const next = { width: element.clientWidth, font: parseFloat(style.fontSize) || 13.5, family: style.fontFamily };
      setSize((last) => (last && last.width === next.width && last.font === next.font ? last : next));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [table]);
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(null), 1800);
    return () => clearTimeout(timer);
  }, [said]);

  const rows = useMemo(() => chartRows(chart), [chart]);
  const value = (number: number) => formatChartValue(number, chart.unit, locale);
  const missing = (note: string | undefined) => note || t("components.chart.missing");
  const fileName = imageFileName(chart.title, t("components.chart.fileName"));

  async function act(action: Action) {
    if (action === "table") return setTable((shown) => !shown);
    const element = plot.current;
    if (!element || !size) return;
    try {
      const png = await chartPng(element, chart, size);
      if (action === "zoom") return setZoomed(png);
      if (action === "download") {
        if (await saveImage(png, fileName)) setSaid("saved");
      } else {
        await copyImage(png);
        setSaid("copied");
      }
    } catch {
      setSaid("failed");
    }
  }
  const menu: MenuProps = {
    items: [
      ...(table ? [] : [{ key: "zoom", icon: <Icon name="maximize-2" size={16} />, label: t("components.chart.zoom") }]),
      {
        key: "table",
        icon: <Icon name={table ? "chart-line" : "list-ordered"} size={16} />,
        label: table ? t("components.chart.asChart") : t("components.chart.asTable"),
      },
      ...(table
        ? []
        : [
            { key: "download", icon: <Icon name="download" size={16} />, label: t("components.chart.download") },
            { key: "copy", icon: <Icon name="copy" size={16} />, label: t("components.chart.copy") },
          ]),
    ],
    onClick: ({ key }) => void act(key as Action),
  };
  const { bind, popup } = useItemMenu({ menu, region: t("components.chart.menu"), returnTo: () => dots.current });

  const legend =
    chart.series.length > 1 ? (
      <ul className="px-chart-legend" aria-label={t("components.chart.legend")}>
        {chart.series.map((series, index) => (
          <li key={index}>
            <i className={`px-chart-key is-${chart.kind} is-s${index + 1}`} aria-hidden />
            {series.name || `${index + 1}`}
          </li>
        ))}
      </ul>
    ) : null;

  const dataTable = (
    <table className={table ? "px-chart-table" : "px-chart-table visually-hidden"} aria-label={chart.title}>
      <thead>
        <tr>
          <th scope="col">{chart.x || t("components.chart.category")}</th>
          {chart.series.map((series, index) => (
            <th scope="col" key={index}>
              {series.name || chart.y || t("components.chart.value")}
            </th>
          ))}
          {rows.some((row) => row.points.some((point) => point?.note)) && chart.series.length === 1 ? (
            <th scope="col">{t("components.chart.note")}</th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            <th scope="row">{row.label}</th>
            {row.points.map((point, column) => (
              <td key={column} className={point && point.value !== null ? "is-value" : "is-missing"}>
                {!point ? "" : point.value === null ? missing(point.note) : value(point.value)}
              </td>
            ))}
            {rows.some((item) => item.points.some((point) => point?.note)) && chart.series.length === 1 ? (
              <td>{row.points[0]?.value === null ? "" : (row.points[0]?.note ?? "")}</td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );

  let drawing: ReactNode = null;
  let tooltip: ReactNode = null;
  if (size && size.width > 0 && !table) {
    const measure = measurer(size);
    const tip = (index: number) => {
      const row = rows[index]!;
      if (chart.series.length === 1) {
        const point = row.points[0];
        const shown = !point ? "" : point.value === null ? missing(point.note) : value(point.value);
        return [`${row.label}: ${shown}${point?.value !== null && point?.note ? ` · ${point.note}` : ""}`];
      }
      return [
        row.label,
        ...chart.series.map((series, column) => {
          const point = row.points[column];
          return `${series.name}: ${!point || point.value === null ? missing(point?.note) : value(point.value)}`;
        }),
      ];
    };
    const hover = still
      ? () => ({})
      : (index: number) => ({
          tabIndex: 0,
          role: "img" as const,
          "aria-label": tip(index).join(", "),
          onMouseEnter: () => setActive({ index, focus: false }),
          onMouseLeave: () => setActive(null),
          onFocus: (event: React.FocusEvent<SVGElement>) =>
            setActive({ index, focus: event.currentTarget.matches(":focus-visible") }),
          onBlur: () => setActive(null),
        });
    const geometry =
      chart.kind === "bar"
        ? barChart(chart, rows, size, measure, value, missing, active?.index ?? null)
        : lineChart(chart, rows, size, measure, locale);
    drawing = (
      <svg
        ref={plot}
        className={arriving ? "px-chart-plot is-arriving" : "px-chart-plot"}
        width={size.width}
        height={geometry.height}
        viewBox={`0 0 ${size.width} ${geometry.height}`}
        role="group"
        aria-label={chart.title}
        fontSize={size.font}
      >
        {geometry.marks}
        {geometry.hits.map((hit, index) => (
          <g key={index} className="px-chart-hit" {...hover(index)}>
            <rect x={hit.x} y={hit.y} width={hit.width} height={hit.height} fill="transparent" />
            {active?.index === index && active.focus ? (
              <rect
                className="px-chart-focus"
                x={hit.x + 1}
                y={hit.y + 1}
                width={Math.max(0, hit.width - 2)}
                height={Math.max(0, hit.height - 2)}
                rx={6}
              />
            ) : null}
          </g>
        ))}
        {active && geometry.cross ? geometry.cross(active.index) : null}
      </svg>
    );
    if (active && !still) {
      const at = geometry.tip(active.index);
      tooltip = (
        <div
          className="px-chart-tip"
          aria-hidden
          style={{ left: Math.min(Math.max(at.x, 4), size.width - 4), top: at.y }}
          data-side={at.x > size.width * 0.6 ? "end" : "start"}
        >
          {tip(active.index).map((line, index) => (
            <span key={index}>{line}</span>
          ))}
        </div>
      );
    }
  }

  return (
    <>
      <figure className={table ? "px-chart is-table" : "px-chart"} {...(still ? {} : bind)}>
        <figcaption className="px-chart-head">
          <span className="px-chart-title">{chart.title}</span>
          {chart.subtitle ? <span className="px-chart-sub">{chart.subtitle}</span> : null}
        </figcaption>
        {still ? null : (
          <MenuButton menu={menu} label={t("components.chart.menu")} size="sm" className="px-chart-dots" />
        )}
        {legend}
        <div ref={wrap} className="px-chart-frame">
          {drawing}
          {tooltip}
        </div>
        {dataTable}
        {said ? (
          <span className="px-chart-said" role="status">
            {t(`components.figure.${said}`)}
          </span>
        ) : null}
        {popup}
      </figure>
      {zoomed ? (
        <ImageViewer
          src={zoomed}
          label={t("components.chart.viewer")}
          caption={chart.title}
          filename={fileName}
          ground={document.documentElement.dataset.theme === "dark" ? "dark" : "white"}
          origin={dots.current}
          onClose={() => setZoomed(null)}
        />
      ) : null}
    </>
  );
}

type Rows = ReturnType<typeof chartRows>;
type Hit = { x: number; y: number; width: number; height: number };
type Geometry = {
  height: number;
  marks: ReactNode;
  /** One target per category, for the pointer and the keyboard. */
  hits: Hit[];
  /** Where the tooltip of a category points. */
  tip: (index: number) => { x: number; y: number };
  cross?: (index: number) => ReactNode;
};

/** Horizontal bars: the label, the bar from zero, the value at the end; a missing value says so in its track. */
function barChart(
  chart: ChartData,
  rows: Rows,
  size: Size,
  measure: (text: string, weight?: number) => number,
  value: (number: number) => string,
  missing: (note: string | undefined) => string,
  /** The row under the pointer or the focus, whose bars darken. */
  active: number | null,
): Geometry {
  const { lo, hi } = chartDomain(chart);
  const f = size.font;
  const many = chart.series.length > 1;
  const gap = 12;
  const labelRoom = Math.min(Math.max(...rows.map((row) => measure(row.label))), size.width * 0.38, f * 14);
  const valueRoom = many
    ? 0
    : Math.max(0, ...rows.map((row) => (row.points[0]?.value == null ? 0 : measure(value(row.points[0].value), 650))));
  const trackX = labelRoom + gap;
  const trackWidth = Math.max(40, size.width - trackX - (valueRoom ? valueRoom + gap : 0));
  const bar = Math.round(f * (many ? 0.74 : 1.04));
  const inner = many ? chart.series.length * bar + (chart.series.length - 1) * 2 : bar;
  const rowHeight = Math.max(Math.ceil(f * 1.6), inner);
  const rowGap = 10;
  const top = chart.reference ? 8 : 2;
  const bottom = chart.reference ? Math.ceil(f * 1.5) : 2;
  const height = top + rows.length * rowHeight + (rows.length - 1) * rowGap + bottom;
  const x = (number: number) => trackX + ((Math.min(hi, Math.max(lo, number)) - lo) / (hi - lo)) * trackWidth;
  const base = x(0);
  const rowY = (index: number) => top + index * (rowHeight + rowGap);
  const marks = (
    <>
      {rows.map((row, index) => {
        const y = rowY(index);
        const middle = y + rowHeight / 2;
        return (
          <g key={index}>
            <text className="px-chart-label" x={0} y={middle} dominantBaseline="central">
              {fit(row.label, labelRoom, measure)}
            </text>
            {row.points.every((point) => !point || point.value === null) ? (
              <text className="px-chart-missing" x={trackX} y={middle} dominantBaseline="central" fontSize={f * 0.93}>
                {fit(missing(row.points.find((point) => point)?.note), trackWidth, measure)}
              </text>
            ) : (
              row.points.map((point, column) =>
                point && point.value !== null ? (
                  <path
                    key={column}
                    className={`px-chart-bar is-s${column + 1}${active === index ? " is-active" : ""}`}
                    d={barPath(base, x(point.value), middle - inner / 2 + column * (bar + 2), bar)}
                  />
                ) : null,
              )
            )}
            {!many && row.points[0]?.value != null ? (
              <text className="px-chart-value" x={size.width} y={middle} dominantBaseline="central" textAnchor="end">
                {value(row.points[0].value)}
              </text>
            ) : null}
          </g>
        );
      })}
      {chart.reference ? (
        <g className="px-chart-ref">
          <line x1={x(chart.reference.value)} x2={x(chart.reference.value)} y1={2} y2={height - bottom + 2} />
          <text
            x={Math.min(Math.max(x(chart.reference.value), measure(chart.reference.label) / 2), size.width - measure(chart.reference.label) / 2)}
            y={height - 2}
            textAnchor="middle"
            fontSize={f * 0.9}
          >
            {chart.reference.label}
          </text>
        </g>
      ) : null}
    </>
  );
  return {
    height,
    marks,
    hits: rows.map((_, index) => ({ x: -4, y: rowY(index) - 4, width: size.width + 8, height: rowHeight + 8 })),
    tip: (index) => ({ x: trackX, y: rowY(index) }),
  };
}

/** Lines over the categories in order, with a marker at each value and a gap where one is missing. */
function lineChart(
  chart: ChartData,
  rows: Rows,
  size: Size,
  measure: (text: string, weight?: number) => number,
  locale: string,
): Geometry {
  const { lo, hi, ticks } = chartDomain(chart);
  const f = size.font;
  const tick = (number: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(number);
  const left = Math.max(...ticks.map((item) => measure(tick(item)))) + 10;
  const right = 10;
  const top = chart.y ? Math.ceil(f * 1.8) : Math.ceil(f * 0.7);
  const plotHeight = Math.round(Math.min(260, Math.max(160, size.width * 0.38)));
  const bottom = Math.ceil(f * 1.9) + (chart.x ? Math.ceil(f * 1.5) : 0);
  const height = top + plotHeight + bottom;
  const step = (size.width - left - right) / rows.length;
  const cx = (index: number) => left + step * (index + 0.5);
  const y = (number: number) => top + ((hi - number) / (hi - lo)) * plotHeight;
  const widest = Math.max(...rows.map((row) => measure(row.label)));
  const every = Math.max(1, Math.ceil((Math.min(widest, f * 9) + 10) / step));
  const lines = chart.series.map((series, column) => {
    // A missing value breaks the line, so no slope is drawn through a value that does not exist.
    let d = "";
    let open = false;
    rows.forEach((row, index) => {
      const point = row.points[column];
      if (!point || point.value === null) {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${cx(index)},${y(point.value)}`;
      open = true;
    });
    return { d, column, series };
  });
  const marks = (
    <>
      {ticks.map((item) => (
        <g key={item} className="px-chart-grid">
          <line x1={left} x2={size.width - right} y1={y(item)} y2={y(item)} />
          <text x={left - 8} y={y(item)} textAnchor="end" dominantBaseline="central">
            {tick(item)}
          </text>
        </g>
      ))}
      {chart.y ? (
        <text className="px-chart-axis" x={0} y={f * 0.8} dominantBaseline="central">
          {fit(chart.y, size.width, measure)}
        </text>
      ) : null}
      {rows.map((row, index) =>
        index % every === 0 ? (
          <text key={index} className="px-chart-axis" x={cx(index)} y={top + plotHeight + f * 1.1} textAnchor="middle" dominantBaseline="central">
            {fit(row.label, step * every - 6, measure)}
          </text>
        ) : null,
      )}
      {chart.x ? (
        <text className="px-chart-axis" x={left + (size.width - left - right) / 2} y={height - f * 0.6} textAnchor="middle" dominantBaseline="central">
          {fit(chart.x, size.width - left, measure)}
        </text>
      ) : null}
      {chart.reference ? (
        <g className="px-chart-ref">
          <line x1={left} x2={size.width - right} y1={y(chart.reference.value)} y2={y(chart.reference.value)} />
          <text x={size.width - right} y={y(chart.reference.value) - f * 0.6} textAnchor="end" fontSize={f * 0.9}>
            {chart.reference.label}
          </text>
        </g>
      ) : null}
      {lines.map((line) => (
        <path key={line.column} className={`px-chart-line is-s${line.column + 1}`} d={line.d} />
      ))}
      {lines.map((line) =>
        rows.map((row, index) => {
          const point = row.points[line.column];
          return point && point.value !== null ? (
            <circle key={`${line.column}-${index}`} className={`px-chart-marker is-s${line.column + 1}`} cx={cx(index)} cy={y(point.value)} r={4} />
          ) : null;
        }),
      )}
    </>
  );
  const highest = (index: number) =>
    Math.min(...rows[index]!.points.flatMap((point) => (point && point.value !== null ? [y(point.value)] : [top + plotHeight / 2])));
  return {
    height,
    marks,
    hits: rows.map((_, index) => ({ x: cx(index) - step / 2, y: top - 4, width: step, height: plotHeight + 8 })),
    tip: (index) => ({ x: cx(index), y: highest(index) - 10 }),
    cross: (index) => <line className="px-chart-cross" x1={cx(index)} x2={cx(index)} y1={top} y2={top + plotHeight} />,
  };
}

let fontCache: Promise<string | null> | undefined;

/** The app's sans font as a data URL, read once; null when it cannot be read, and the picture falls back to a system font. */
function fontData(): Promise<string | null> {
  fontCache ??= fetch(figtree)
    .then((response) => (response.ok ? response.blob() : null))
    .then(
      (blob) =>
        blob &&
        new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result.replace(/^data:[^;,]*/, "data:font/woff2") : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        }),
    )
    .catch(() => null);
  return fontCache;
}

/** The styles a chart's marks take from the theme, copied onto a clone so the picture keeps them outside the page. */
const PAINT = ["fill", "stroke", "stroke-width", "stroke-dasharray", "font-family", "font-size", "font-weight", "opacity"];

/**
 * The chart as a PNG data URL at twice its size, as the student sees it now: title, subtitle, legend and the drawing on
 * the theme's surface, with the theme's colours written into the picture.
 */
async function chartPng(element: SVGSVGElement, chart: ChartData, size: Size): Promise<string> {
  const clone = element.cloneNode(true) as SVGSVGElement;
  const from = [element, ...element.querySelectorAll("*")];
  const to = [clone, ...clone.querySelectorAll("*")];
  from.forEach((node, index) => {
    const target = to[index] as SVGElement;
    if (node.closest(".px-chart-hit") && !node.matches(".px-chart-hit, .px-chart-hit > rect:first-child")) target.remove();
    const style = getComputedStyle(node);
    target.setAttribute("style", PAINT.map((name) => `${name}:${style.getPropertyValue(name)}`).join(";"));
  });
  clone.querySelectorAll(".px-chart-cross").forEach((node) => node.remove());
  const page = getComputedStyle(element.closest(".px-chart") ?? element);
  const surface = page.getPropertyValue("--surface").trim() || "#ffffff";
  const ink = page.getPropertyValue("--ink").trim() || "#15181e";
  const muted = page.getPropertyValue("--ink-muted").trim() || "#50576a";
  const family = size.family.replace(/"/g, "'");
  const pad = 24;
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const lines: string[] = [];
  let y = pad + 16;
  lines.push(`<text x="${pad}" y="${y}" fill="${ink}" font-family="${family}" font-size="16" font-weight="650">${escape(chart.title)}</text>`);
  if (chart.subtitle) {
    y += 20;
    lines.push(`<text x="${pad}" y="${y}" fill="${muted}" font-family="${family}" font-size="13">${escape(chart.subtitle)}</text>`);
  }
  if (chart.series.length > 1) {
    y += 24;
    let x = pad;
    chart.series.forEach((series, index) => {
      const color = page.getPropertyValue(`--chart-${index + 1}`).trim();
      lines.push(`<rect x="${x}" y="${y - 9}" width="14" height="8" rx="2" fill="${color}"/>`);
      lines.push(`<text x="${x + 20}" y="${y}" fill="${ink}" font-family="${family}" font-size="13">${escape(series.name)}</text>`);
      x += 20 + series.name.length * 7.5 + 18;
    });
  }
  y += 16;
  const width = size.width + pad * 2;
  const height = y + Number(element.getAttribute("height")) + pad;
  clone.setAttribute("x", String(pad));
  clone.setAttribute("y", String(y));
  clone.setAttribute("font-family", family);
  // A picture drawn from SVG cannot reach the page's fonts, so the app's own is written into it: the text then has the
  // widths the chart was laid out with.
  const font = await fontData();
  const style = font ? `<style>@font-face{font-family:Figtree;font-weight:100 900;src:url(${font}) format("woff2")}</style>` : "";
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${style}<rect width="100%" height="100%" fill="${surface}"/>${lines.join("")}${new XMLSerializer().serializeToString(clone)}</svg>`;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("image-unavailable");
  context.scale(2, 2);
  context.drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}
