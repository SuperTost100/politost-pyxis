import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Button } from "../../components/Button";
import { gapStateQuery, openGapsQuery } from "../../lib/queries";
import { gapEnd } from "../plans/gapList";
import "./GapEnd.css";

/**
 * The end of a drill on a gap, in the results' summary: "Lacuna colmata" when the gap is closed, or what closes it. Wrong answers are told by the
 * results' own "what changes" block, so this says something only for a drill answered right.
 */
export function GapEnd({ planId, gapId, rightAnswers }: { planId: string; gapId: string; rightAnswers: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const gaps = useQuery({ ...openGapsQuery(planId), enabled: Boolean(planId) });
  const state = useQuery({ ...gapStateQuery(gapId), enabled: Boolean(gapId) });
  // Both are read again as this opens, so what is said is not from before the answers: until they are in, nothing is said.
  if (gaps.isError || state.isError) return null;
  if (!gaps.isSuccess || !state.isSuccess || gaps.isFetching || state.isFetching)
    return (
      <div className="px-skeleton px-gap-end-wait" role="status">
        <span className="visually-hidden">{t("components.loading")}</span>
        <i className="px-skeleton-bar" aria-hidden />
        <i className="px-skeleton-bar" aria-hidden />
      </div>
    );
  const end = gapEnd(state.data, gaps.data);
  if (end.closed)
    return (
      <section className="px-gap-end is-closed" aria-labelledby="gap-end-title">
        <h3 id="gap-end-title" className="px-gap-end-title">
          <Check size={16} strokeWidth={2} aria-hidden />
          {t("gaps.closed")}
        </h3>
        <p>{t("gaps.closedBody")}</p>
        {end.next ? (
          <Button size="sm" block onClick={() => navigate(`/plans/${planId}/gap/${end.next!.gapId}`)}>
            {t("gaps.next", { topic: end.next.topicTitle })}
          </Button>
        ) : null}
      </section>
    );
  return rightAnswers ? <p className="px-gap-end is-open">{t("gaps.rightAnswers")}</p> : null;
}
