import { MarkdownView } from "./MarkdownView";
import "./FormulaPreview.css";

/** A face with a formula in it, `$…$` with something between the dollars. */
const HAS_FORMULA = /\$(?=[^$]*\S)[^$]+\$/;

/**
 * Under a flashcard face being written or checked: the face as the flashcard shows it, when it holds a formula, so the
 * student sees the maths and not its TeX. Nothing when the face has no formula. `label` names it ("Anteprima").
 */
export function FormulaPreview({ label, value }: { label: string; value: string }) {
  if (!HAS_FORMULA.test(value)) return null;
  return (
    <div className="px-formula-preview">
      <span>{label}</span>
      <div className="px-formula-preview-face">
        <MarkdownView variant="body">{value}</MarkdownView>
      </div>
    </div>
  );
}
