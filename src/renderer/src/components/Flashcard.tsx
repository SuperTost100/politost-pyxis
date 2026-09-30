import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CitationChip } from "./CitationChip";
import { Tag } from "./Tag";
import "./Flashcard.css";

export function Flashcard({
  front,
  back,
  source,
  flipped: initialFlipped,
  counters,
  onRate,
}: {
  front: string;
  back: string;
  source?: string;
  flipped?: boolean;
  counters?: { nuove: number; apprendimento: number; padroneggiate: number };
  onRate?: (rating: number) => void;
}) {
  const { t } = useTranslation();
  const [flipped, setFlipped] = useState(!!initialFlipped);
  const c = counters ?? { nuove: 12, apprendimento: 4, padroneggiate: 20 };
  const rates = [
    { label: t("components.flashcard.rate1"), key: "1" },
    { label: t("components.flashcard.rate2"), key: "2" },
    { label: t("components.flashcard.rate3"), key: "3" },
    { label: t("components.flashcard.rate4"), key: "4" },
  ];
  return (
    <div className="px-fc">
      <div className="px-fc-counters">
        <Tag tone="smartbook" icon="layers">
          {t("components.flashcard.new", { count: c.nuove })}
        </Tag>
        <Tag tone="general" icon="repeat">
          {t("components.flashcard.learning", { count: c.apprendimento })}
        </Tag>
        <Tag tone="mastered">
          {t("components.flashcard.mastered", { count: c.padroneggiate })}
        </Tag>
      </div>
      <div
        className="px-card px-fc-face"
        role="button"
        tabIndex={0}
        aria-label={
          flipped
            ? t("components.flashcard.answer")
            : t("components.flashcard.flipHint")
        }
        onClick={() => setFlipped((f) => !f)}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            setFlipped((f) => !f);
          }
        }}
      >
        <p className="px-fc-q">{front}</p>
        {flipped ? (
          <p className="px-fc-a">{back}</p>
        ) : (
          <span className="px-fc-hint">{t("components.flashcard.flipHint")}</span>
        )}
        {flipped && source ? <CitationChip>{source}</CitationChip> : null}
      </div>
      {flipped ? (
        <div className="px-fc-rates">
          {rates.map((r, i) => (
            <button
              key={r.key}
              type="button"
              className="px-fc-rate"
              onClick={() => onRate?.(i + 1)}
            >
              {r.label}
              <kbd>{r.key}</kbd>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
