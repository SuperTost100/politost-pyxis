import { MathText } from "../../components/math/MathText";
import type { AnswerSource } from "./quizText";
import "./TypedAnswer.css";

/** What a student wrote, as they wrote it: the math editor's text with its formulas drawn, or a plain input's text untouched. */
export function TypedAnswer({ text, source }: { text: string; source: AnswerSource }) {
  return source === "math" ? <MathText text={text} /> : <span className="px-plain-answer">{text}</span>;
}
