import {
  Atom,
  Brain,
  Building2,
  ChartLine,
  Clapperboard,
  CodeXml,
  Cog,
  Cpu,
  Dices,
  Dna,
  DraftingCompass,
  Feather,
  FlaskConical,
  Globe,
  HeartPulse,
  Landmark,
  Languages,
  Music,
  Network,
  Palette,
  PencilRuler,
  Scale,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { FileKind } from "@shared/file-kind";
import { subjectSymbol, type SubjectSymbol } from "@shared/subject-symbol";
import "./FileCover.css";

/** The drawn symbols of a book's subject: the app's own icons, and two drawn here that the set lacks. */
const SYMBOL_ICONS: Record<Exclude<SubjectSymbol, "integral" | "matrix">, LucideIcon> = {
  clapperboard: Clapperboard,
  music: Music,
  palette: Palette,
  chip: Cpu,
  code: CodeXml,
  network: Network,
  bolt: Zap,
  wave: Waves,
  atom: Atom,
  flask: FlaskConical,
  dna: Dna,
  pulse: HeartPulse,
  brain: Brain,
  dice: Dices,
  compass: DraftingCompass,
  pencil: PencilRuler,
  gear: Cog,
  building: Building2,
  chart: ChartLine,
  scales: Scale,
  globe: Globe,
  column: Landmark,
  quill: Feather,
  speech: Languages,
};

/** The two symbols drawn on the icons' 24-unit grid, with their stroke. */
const DRAWN: Record<"integral" | "matrix", ReactNode> = {
  integral: <path d="M16.8 3.4c-1.3-1.7-4.6-1.6-5.1 2.1L9.9 18.6c-.5 3.6-3.7 3.7-5 2" />,
  matrix: (
    <>
      <path d="M7 3H4v18h3M17 3h3v18h-3" />
      <circle className="px-fc-dot" cx="9.5" cy="8.5" r=".6" />
      <circle className="px-fc-dot" cx="14.5" cy="8.5" r=".6" />
      <circle className="px-fc-dot" cx="9.5" cy="15.5" r=".6" />
      <circle className="px-fc-dot" cx="14.5" cy="15.5" r=".6" />
    </>
  ),
};

/** A book's symbol, or its subject's initials, centred on (cx, cy). */
function SubjectMark({ name, cx, cy }: { name: string; cx: number; cy: number }) {
  const found = subjectSymbol(name);
  if ("initials" in found)
    return (
      <text className="px-fc-initials" x={cx} y={cy + 4} textAnchor="middle">
        {found.initials}
      </text>
    );
  const size = 26;
  const at = { x: cx - size / 2, y: cy - size / 2, width: size, height: size };
  if (found.symbol === "integral" || found.symbol === "matrix")
    return (
      <svg {...at} viewBox="0 0 24 24" className="px-fc-symbol" data-symbol={found.symbol}>
        {DRAWN[found.symbol]}
      </svg>
    );
  const Icon = SYMBOL_ICONS[found.symbol];
  return <Icon {...at} className="px-fc-symbol" data-symbol={found.symbol} strokeWidth={1.6} />;
}

/** The sizes each drawing has at scale 1, in CSS pixels. */
const SIZES: Record<FileKind, [number, number]> = {
  book: [56, 78],
  slides: [72, 54],
  exam: [58, 76],
  notes: [56, 76],
  exercises: [58, 74],
  photo: [66, 58],
  handout: [56, 76],
};

const range = (count: number) => Array.from({ length: count }, (_, index) => index);

/** The drawing of each kind, on its own grid (`SIZES`). */
function art(kind: FileKind, symbolName: string): ReactNode {
  switch (kind) {
    case "book":
      return (
        <>
          <path className="sc" d="M2 1h49a4 4 0 0 1 4 4v68a4 4 0 0 1-4 4H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" />
          <rect className="shade" x="1" y="1" width="6" height="76" />
          <rect className="hl" x="7" y="1" width="1" height="76" />
          {symbolName ? <SubjectMark name={symbolName} cx={31} cy={31} /> : null}
          <rect className="ink o7" x="15" y="58" width="32" height="2.4" rx="1.2" />
          <rect className="ink o5" x="21" y="63.5" width="20" height="2" rx="1" />
        </>
      );
    case "slides":
      return (
        <>
          <rect className="kc o42" x="7" y="1" width="64" height="42" rx="3" />
          <rect className="kc" x="1" y="9" width="64" height="44" rx="3" />
          <rect className="ink" x="8" y="16" width="28" height="4" rx="2" />
          {[27, 33, 39].map((y) => (
            <g key={y} className="ink o7">
              <circle cx="10" cy={y + 1} r="1.3" />
              <rect x="14" y={y} width={y === 33 ? 14 : 19} height="2" rx="1" />
            </g>
          ))}
          <rect className="ink o7" x="44" y="36" width="4" height="10" rx="1" />
          <rect className="ink o7" x="50" y="31" width="4" height="15" rx="1" />
          <rect className="ink o7" x="56" y="25" width="4" height="21" rx="1" />
        </>
      );
    case "exam":
      return (
        <>
          <rect className="paper" x="6.5" y=".5" width="50" height="70" rx="2" />
          <rect className="paper" x="1" y="5" width="50" height="70" rx="2" />
          <path className="kc" d="M.5 7a2.5 2.5 0 0 1 2.5-2.5h46A2.5 2.5 0 0 1 51.5 7v10H.5z" />
          <rect className="ink" x="6" y="8.5" width="22" height="2.6" rx="1.3" />
          <rect className="ink o7" x="6" y="13" width="12" height="1.8" rx=".9" />
          {range(4).map((i) => (
            <g key={i}>
              <circle className="kc" cx="8" cy={27 + i * 12} r="2.5" />
              <rect className="line" x="13" y={25.4 + i * 12} width="32" height="1.8" rx=".9" />
              <rect className="line" x="13" y={29.6 + i * 12} width={i % 2 ? 18 : 25} height="1.8" rx=".9" />
            </g>
          ))}
          <rect className="staple" x="2" y="3" width="9" height="1.8" rx=".9" transform="rotate(-32 6.5 3.9)" />
        </>
      );
    case "notes":
      return (
        <>
          <rect className="kc" x="5" y="1" width="50" height="74" rx="3" />
          <rect className="shade" x="45" y="1" width="3.5" height="74" />
          <rect className="paper" x="14" y="20" width="27" height="17" rx="2" />
          <rect className="line" x="18" y="25" width="19" height="1.8" rx=".9" />
          <rect className="line" x="18" y="30" width="12" height="1.8" rx=".9" />
          {range(9).map((i) => (
            <rect key={i} className="spiral" x="1.5" y={5 + i * 8} width="8" height="3.2" rx="1.6" />
          ))}
        </>
      );
    case "exercises":
      return (
        <>
          <path className="paper" d="M3 1h38l14 14v56a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" />
          <path className="fold" d="M41 1v11a3 3 0 0 0 3 3h11z" />
          <rect className="kc" x="7" y="7" width="22" height="3.4" rx="1.7" />
          {range(5).map((i) => {
            const y = 20 + i * 10;
            return (
              <g key={i}>
                <rect className="box" x="7" y={y} width="5.6" height="5.6" rx="1.3" />
                {i < 2 ? <path className="tick" d={`M8.3 ${y + 2.9}l1.4 1.4 2.6-3`} /> : null}
                <rect className="line" x="16" y={y + 1.9} width={i % 2 ? 24 : 33} height="1.8" rx=".9" />
              </g>
            );
          })}
        </>
      );
    case "photo":
      return (
        <g transform="rotate(-4 33 29)">
          <rect className="paper" x="4" y="4" width="58" height="50" rx="2" />
          <rect className="board" x="8" y="8" width="50" height="34" rx="1" />
          <path className="chalk" d="M13 17c2.5-4 5.5-4 7.5 0s5 4 7.5 0" />
          <path className="chalk" d="M13 26h11M27.5 26h6" />
          <path className="chalk" d="M13 34h8" />
          <path className="chalk" d="M39 35c2.5-11 6.5-17 13-18" />
          <path className="chalk o55" d="M37 36h17M39 14v22" />
        </g>
      );
    case "handout":
      return (
        <>
          <rect className="paper" x="5" y="4" width="50" height="71" rx="2" />
          <rect className="tint" x="1" y="1" width="50" height="72" rx="2" />
          <rect className="sc" x="9" y="9" width="36" height="17" rx="1.5" />
          <rect className="ink" x="13" y="14" width="22" height="2.6" rx="1.3" />
          <rect className="ink o7" x="13" y="19" width="14" height="1.8" rx=".9" />
          {range(5).map((i) => (
            <rect key={i} className="tint-line" x="9" y={35 + i * 6} width={i % 2 ? 28 : 36} height="1.8" rx=".9" />
          ))}
          <rect className="staple" x="3.2" y="13" width="1.7" height="7" rx=".85" />
          <rect className="staple" x="3.2" y="53" width="1.7" height="7" rx=".85" />
        </>
      );
  }
}

/**
 * The cover of a file, drawn by its kind: a book in its subject's colour with the subject's symbol, slides, an exam
 * paper, a notebook, an exercise sheet, a photo of a blackboard or a handout in its subject's tint. Decorative: the
 * file's title, kind and state are said by the element around it.
 */
export function FileCover({
  kind,
  colour,
  symbol = "",
  scale = 1,
  className,
}: {
  kind: FileKind;
  /** The subject's cover colour, 1 to 6 (`--cover-N`); none draws a book or handout in `--cover-none`. */
  colour?: number | null;
  /** The name a book's symbol is chosen from: its subject's, or its own title when it has no subject. */
  symbol?: string;
  scale?: number;
  className?: string;
}) {
  const [width, height] = SIZES[kind];
  const style = { "--sc": colour ? `var(--cover-${colour})` : "var(--cover-none)" } as CSSProperties;
  return (
    <svg
      className={["px-fc", `is-${kind}`, className].filter(Boolean).join(" ")}
      width={Number((width * scale).toFixed(1))}
      height={Number((height * scale).toFixed(1))}
      viewBox={`0 0 ${width} ${height}`}
      style={style}
      data-kind={kind}
      aria-hidden
      focusable={false}
    >
      {art(kind, symbol)}
    </svg>
  );
}
