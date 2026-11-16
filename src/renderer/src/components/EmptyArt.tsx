import type { ReactNode } from "react";
import "./EmptyArt.css";

/**
 * The drawing above an empty page's line: the app's own objects at rest, in neutral greys, with the primary tint on the
 * one part that matters (EmptyArt.css). It is still, decorative and hidden from screen readers, because the line under
 * it carries the meaning. Each drawing sits in a 140 × 120 box.
 */
export type EmptyArtKind = "exams" | "maps" | "flashcards" | "library";

const drawings: Record<EmptyArtKind, ReactNode> = {
  // The path's step markers beside the card of the step now open: one step done, one open, one to come.
  exams: (
    <>
      <path className="ea-ln" d="M30 18v84" />
      <circle className="ea-dk" cx="30" cy="20" r="10" />
      <path className="ea-wt" d="M25.5 20l3 3 6-6" />
      <rect className="ea-card ea-tn" x="16" y="42" width="116" height="36" rx="9" />
      <circle className="ea-mk" cx="30" cy="60" r="10" />
      <rect className="ea-bar" x="48" y="53" width="62" height="6" rx="3" />
      <rect className="ea-bar2" x="48" y="64" width="40" height="5" rx="2.5" />
      <circle className="ea-card" cx="30" cy="100" r="10" />
      <rect className="ea-bar2" x="48" y="14" width="52" height="6" rx="3" />
      <rect className="ea-bar2" x="48" y="96" width="58" height="6" rx="3" />
    </>
  ),
  // A map's boxes and links, as the tree layout draws them.
  maps: (
    <>
      <path className="ea-ln" d="M46 60C65 60 65 26 84 26M46 60h38M46 60C65 60 65 94 84 94" />
      <rect className="ea-tn" x="8" y="48" width="38" height="24" rx="7" />
      <rect className="ea-bar" x="16" y="58" width="22" height="4" rx="2" />
      {[26, 60, 94].map((y, index) => (
        <g key={y}>
          <rect className="ea-card" x="84" y={y - 12} width="48" height="24" rx="7" />
          <rect className="ea-bar" x="92" y={y - 2} width={[28, 22, 26][index]} height="4" rx="2" />
        </g>
      ))}
    </>
  ),
  // A flashcard on its stack, with the button that turns it under it.
  flashcards: (
    <>
      <rect className="ea-card" x="30" y="10" width="84" height="64" rx="9" transform="rotate(-3 72 42)" />
      <rect className="ea-card ea-tn" x="26" y="16" width="88" height="66" rx="9" />
      <rect className="ea-bar2" x="58" y="26" width="24" height="4" rx="2" />
      <rect className="ea-bar" x="44" y="44" width="52" height="6" rx="3" />
      <rect className="ea-bar" x="54" y="55" width="32" height="6" rx="3" />
      <rect className="ea-bar" x="52" y="92" width="36" height="16" rx="5" />
    </>
  ),
  // The Library's covers by kind on a shelf: a book, slides, an exam paper and a notebook.
  library: (
    <>
      <path className="ea-ln" d="M8 102h124" />
      <rect className="ea-tn" x="14" y="44" width="28" height="58" rx="3" />
      <rect className="ea-bar2" x="14" y="44" width="4" height="58" rx="1" />
      <path className="ea-tl" d="M23 66h12" />
      <rect className="ea-card" x="52" y="76" width="34" height="24" rx="3" transform="translate(3 -3)" />
      <rect className="ea-card" x="50" y="78" width="34" height="24" rx="3" />
      <rect className="ea-bar" x="55" y="83" width="16" height="3" rx="1.5" />
      <rect className="ea-bar2" x="55" y="90" width="24" height="7" rx="1" />
      <rect className="ea-card" x="95" y="59" width="28" height="40" rx="2" />
      <rect className="ea-card" x="92" y="62" width="28" height="40" rx="2" />
      <path className="ea-ln" d="M97 73h18M97 79h18M97 85h18M97 91h12" />
    </>
  ),
};

export function EmptyArt({ kind }: { kind: EmptyArtKind }) {
  return (
    <svg className="ea" viewBox="0 0 140 120" aria-hidden focusable="false">
      {drawings[kind]}
    </svg>
  );
}
