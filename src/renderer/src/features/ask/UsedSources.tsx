import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/Icon";
import { openSourceViewer } from "../../components/SourceViewer";
import { usedLine } from "./usedLine";
import "./UsedSources.css";

type Cited = {
  index: number;
  label: string;
  passageId: string;
  sourceId: string;
  sourceTitle?: string;
  subject?: string | null;
  attached?: boolean;
};

/**
 * The line above an answer that says what it used: "Ho usato 3 fonti di Fisica 2", which opens the numbered list of the
 * passages, each opening its source at that place. An answer from general knowledge says so instead, with no list.
 */
export function UsedSources({
  grounding,
  citations,
}: {
  grounding: "sources" | "wider" | "general" | null;
  citations: readonly Cited[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const list = useId();
  const line = usedLine({ grounding, citations });
  if (!line) return null;
  if (line.key === "ask.used.general")
    return (
      <p className="ask-used ask-used-general">
        <Icon name="info" size={15} />
        <span>{t(line.key)}</span>
      </p>
    );
  const sorted = [...citations].sort((a, b) => a.index - b.index);
  return (
    <div className={open ? "ask-used is-open" : "ask-used"}>
      <button
        type="button"
        className="ask-used-line"
        aria-expanded={open}
        aria-controls={list}
        onClick={() => setOpen((now) => !now)}
      >
        <Icon name="check" size={15} />
        <span>{t(line.key, line.values)}</span>
        <Icon name="chevron-right" size={15} className="ask-used-chevron" />
      </button>
      {/* The list opens out of the line, sliding down from it. */}
      <div className="ask-used-fold" id={list} hidden={!open}>
        <ol className="ask-used-list" aria-label={t("ask.used.list")}>
          {sorted.map((cite) => (
            <li key={cite.passageId}>
              <button
                type="button"
                className="ask-used-item"
                onClick={() => openSourceViewer({ passageId: cite.passageId, sourceId: cite.sourceId })}
              >
                <span className="ask-used-num" aria-hidden>
                  {cite.index}
                </span>
                <span>{[cite.sourceTitle, cite.label].filter(Boolean).join(" · ")}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
