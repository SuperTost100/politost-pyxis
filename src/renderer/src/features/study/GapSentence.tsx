import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import "./GapSentence.css";

type Gap = RequestOutput<"plans.openGaps">["gaps"][number];

/** The gap's sentence in its soft box; a gap whose sentence is not written yet says how many wrong answers it has. */
export function GapSentence({ gap }: { gap: Pick<Gap, "sentence" | "wrongAnswers"> }) {
  const { t } = useTranslation();
  return gap.sentence ? (
    <p className="px-gap-sentence">{gap.sentence}</p>
  ) : (
    <p className="px-gap-sentence is-unwritten">{t("gaps.unwritten", { count: gap.wrongAnswers })}</p>
  );
}
