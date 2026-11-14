import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { GAP_DRILL_QUESTIONS } from "@shared/gap-drill";
import { usePlace } from "../../app/usePlace";
import { Logo } from "../../components/Logo";
import { Notice } from "../../components/Notice";
import { openGapsQuery, usePlan } from "../../lib/queries";
import { readGapStart } from "../plans/gapDrillRequest";
import { useGapDrill } from "../plans/useGapDrill";
import { GapSentence } from "./GapSentence";
import "./GapPage.css";
import { StudyLayout } from "./StudyBar";

type Gap = RequestOutput<"plans.openGaps">["gaps"][number];

/**
 * Colma una lacuna, at `/plans/:planId/gap/:gapId`: the page the exam's "Colma" opens at once. It says what the gap is,
 * starts the drill of that gap and shows it being written in place; when it is ready the page opens the drill's quiz in
 * its own history entry, so the bar does not move and Back leads where this page's Back would have.
 */
export function GapPage() {
  const { t } = useTranslation();
  const { planId = "", gapId = "" } = useParams();
  const plan = usePlan(planId);
  const gaps = useQuery({ ...openGapsQuery(planId), enabled: Boolean(planId) });
  const found = gaps.data?.gaps.find((gap) => gap.gapId === gapId);
  // A gap that merged into another while its drill is written leaves the list, but the page still shows what it was.
  const seen = useRef<Gap | undefined>(undefined);
  if (found) seen.current = found;
  const gap = found ?? (seen.current?.gapId === gapId ? seen.current : undefined);
  const back = usePlace({
    name: gap ? { text: gap.topicTitle } : null,
    parent: plan.data ? { name: { text: plan.data.title } } : undefined,
  });
  const drill = useGapDrill(planId, { replace: true });
  // The drill is asked for once for each gap this page shows: the page can draw again at once, and the hook keeps going.
  const started = useRef<string | null>(null);
  useEffect(() => {
    const request = readGapStart(gap?.gapId ?? null, started.current);
    started.current = request.started;
    if (request.begin && gap) void drill.start(gap.topicId, gap.gapId);
  }, [gap?.gapId]);

  const title = gap?.topicTitle ?? "";
  const missing = !gap && gaps.isSuccess;
  return (
    <StudyLayout back={back} title={title} subtitle={t("gaps.barLine")} heading={false}>
      <section className="px-gp-sheet" aria-labelledby="gap-title">
        <div className="px-gp-head">
          <p className="px-gp-label">{t("gaps.label")}</p>
          <h1 id="gap-title" className="px-gp-title">
            {title}
          </h1>
        </div>
        {gap ? <GapSentence gap={gap} /> : null}
        {gaps.isError && !gap ? (
          <Notice tone="danger" action={{ label: t("components.notice.retry"), onClick: () => void gaps.refetch() }}>
            {t("gaps.readGapFailed")}
          </Notice>
        ) : missing ? (
          <Notice tone="info">{t("gaps.gone")}</Notice>
        ) : drill.stopped != null ? (
          <Notice tone="danger" action={{ label: t("components.notice.retry"), onClick: drill.retry }}>
            {t(drill.readFailed ? "gaps.readFailed" : "gaps.failed")}
          </Notice>
        ) : (
          <>
            <div className="px-gp-working" role="status">
              <Logo working decorative size={44} />
              <p className="px-gp-working-text">
                <span className="px-gp-working-line">{t("gaps.preparing", { count: GAP_DRILL_QUESTIONS })}</span>
                {gap ? <span className="px-gp-working-detail">{t("gaps.from", { count: gap.wrongAnswers })}</span> : null}
              </p>
            </div>
            <div className="px-gp-shape" aria-hidden>
              <span />
              <span className="is-mid" />
              <span className="is-short" />
              <span className="is-box" />
              <span className="is-short" />
            </div>
          </>
        )}
      </section>
    </StudyLayout>
  );
}
