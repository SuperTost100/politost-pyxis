import { useTranslation } from "react-i18next";
import { Icon } from "../../components/Icon";
import { noteLine } from "./usedLine";
import "./UsedSources.css";

/**
 * The line above an answer that warns before it is read: the answer comes from general knowledge, or the chat's subject
 * had nothing on the question. The sources themselves are named by the row under the answer (`SourcesRow`).
 */
export function UsedSources({
  grounding,
  citations,
  searched,
}: {
  grounding: "sources" | "wider" | "general" | null;
  citations: ReadonlyArray<{ sourceId: string; subject?: string | null; attached?: boolean }>;
  searched?: { found: boolean; where: "library" | "files" };
}) {
  const { t } = useTranslation();
  const line = noteLine({ grounding, citations, searched });
  if (!line) return null;
  return (
    <p className="ask-used ask-used-general">
      <Icon name="info" size={15} />
      <span>{t(line.key, line.values)}</span>
    </p>
  );
}
