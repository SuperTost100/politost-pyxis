import { useTranslation } from "react-i18next";
import { MarkdownView } from "../MarkdownView";
import { hasMath } from "./insertAtCaret";
import "./MathPreview.css";

/** A compact rendering of a draft, shown only while the draft holds a formula. */
export function MathPreview({ text }: { text: string }) {
  const { t } = useTranslation();
  if (!hasMath(text)) return null;
  return (
    <div className="px-math-preview" role="group" aria-label={t("math.preview")}>
      <span className="meta">{t("math.preview")}</span>
      <MarkdownView variant="body">{text}</MarkdownView>
    </div>
  );
}
