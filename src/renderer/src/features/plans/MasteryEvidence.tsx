import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";

export type TopicBreakdown = RequestOutput<"plans.masteryBreakdown">[number];

const KINDS = ["quiz", "simulation", "card", "check", "self"] as const;

/** What one topic's mastery is made of, from the same evidence as the number beside it. */
export function MasteryEvidence({
  id,
  breakdown,
}: {
  id: string;
  breakdown: TopicBreakdown | undefined;
}) {
  const { t, i18n } = useTranslation();
  if (!breakdown)
    return (
      <div id={id} className="px-evidence" role="status">
        <p className="small">{t("progress.evidence.loading")}</p>
      </div>
    );
  const percent = new Intl.NumberFormat(i18n.language, {
    style: "percent",
    maximumFractionDigits: 0,
  });
  const points = Math.round(breakdown.decay * 100);
  const rows = KINDS.filter((kind) => breakdown.parts[kind].count > 0);
  return (
    <div id={id} className="px-evidence">
      {rows.length === 0 ? (
        <p className="small">{t("progress.evidence.none")}</p>
      ) : (
        <dl className="px-evidence-list">
          {rows.map((kind) => {
            const part = breakdown.parts[kind];
            return (
              <div key={kind}>
                <dt>{t(`progress.evidence.${kind}`)}</dt>
                <dd>
                  {t(`progress.evidence.${kind}Count`, { count: part.count })}
                  {" · "}
                  {t(kind === "card" ? "progress.evidence.recall" : "progress.evidence.average", {
                    value: percent.format(part.mean),
                  })}
                </dd>
              </div>
            );
          })}
          {points !== 0 ? (
            <div>
              <dt>{t("progress.evidence.decay")}</dt>
              <dd>
                {t("progress.evidence.decayValue", {
                  value: new Intl.NumberFormat(i18n.language, {
                    signDisplay: "exceptZero",
                  }).format(points),
                  count: Math.abs(points),
                })}
              </dd>
            </div>
          ) : null}
        </dl>
      )}
      <p className="meta">{t("progress.evidence.note", { count: breakdown.priorWeight })}</p>
    </div>
  );
}
