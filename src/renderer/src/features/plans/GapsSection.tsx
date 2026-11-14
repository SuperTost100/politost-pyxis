import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { Button } from "../../components/Button";
import { Logo } from "../../components/Logo";
import { openGapsQuery } from "../../lib/queries";
import { useJobs } from "../jobs/queries";
import { insightRunning } from "./gapList";
import "./GapsSection.css";

type Gap = RequestOutput<"plans.openGaps">["gaps"][number];

/** How many gaps show before the rest fold behind "Altre N lacune". */
const SHOWN = 3;

/**
 * The gap each exam's list was last left from, by "Colma". The list is the component's own state and folds when the page
 * is left, but a student who goes back from a row after the third expects that row where they left it, with the focus on
 * its button, which a folded row cannot take. So the list comes back unfolded when it was left from a folded row.
 */
const leftFrom = new Map<string, string>();

function GapRow({ planId, gap, reading }: { planId: string; gap: Gap; reading: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <li className="px-gap">
      {gap.sentence ? (
        <p className="px-gap-text">{gap.sentence}</p>
      ) : (
        <p className="px-gap-text is-unwritten">
          {reading ? (
            <span className="px-gap-reading" role="status">
              <Logo working decorative size={16} />
              <span className="visually-hidden">{t("gaps.reading")}</span>
            </span>
          ) : null}
          <span>{t("gaps.unwritten", { count: gap.wrongAnswers })}</span>
        </p>
      )}
      <p className="px-gap-meta">
        <b>{t(`gaps.level.${gap.level}`)}</b> · {gap.topicTitle}
      </p>
      <div className="px-exam-arow">
        <Button
          variant="secondary"
          size="sm"
          focusKey={`exam:gap:${gap.gapId}`}
          aria-label={
            gap.sentence
              ? t("gaps.fillLabel", { sentence: gap.sentence })
              : t("gaps.fillTopicLabel", { topic: gap.topicTitle })
          }
          onClick={() => {
            leftFrom.set(planId, gap.gapId);
            navigate(`/plans/${planId}/gap/${gap.gapId}`);
          }}
        >
          {t("gaps.fill")}
        </Button>
      </div>
    </li>
  );
}

/**
 * The open gaps in the exam page's side column, most serious first: the first three, and the rest behind a button that
 * unfolds them where they belong. The rest sit in a grid row whose height grows from 0 (`grid-template-rows`), so a
 * student sees the list lengthen from its end. The state is the component's own, so the list folds again when the page
 * is left. `Pending` draws the loading and failed states, so this takes the query's result and its title wrapper.
 */
export function GapsList({ planId, exam, gaps }: { planId: string; exam: string; gaps: Gap[] }) {
  const { t } = useTranslation();
  const first = gaps.slice(0, SHOWN);
  const rest = gaps.slice(SHOWN);
  const [open, setOpen] = useState(() => rest.some((gap) => gap.gapId === leftFrom.get(planId)));
  const regionId = useId();
  const jobs = useJobs();
  const reading = (gap: Gap) => insightRunning(jobs.data ?? [], exam, gap.topicTitle);
  const row = (gap: Gap) => <GapRow key={gap.gapId} planId={planId} gap={gap} reading={!gap.sentence && reading(gap)} />;
  return (
    <>
      <ul className="px-gaps">{first.map(row)}</ul>
      {rest.length ? (
        <>
          <div className={open ? "px-gaps-more is-open" : "px-gaps-more"}>
            {/* The folded rows are out of the reading order and the tab order, not only out of sight. */}
            <ul id={regionId} className="px-gaps px-gaps-rest">
              {rest.map(row)}
            </ul>
          </div>
          <div className="px-exam-arow">
            <Button variant="ghost" size="sm" expanded={open} controls={regionId} onClick={() => {
                // Folded on purpose: the list is not left unfolded by a gap that was opened before.
                if (open) leftFrom.delete(planId);
                setOpen((value) => !value);
              }}>
              {open ? t("gaps.less") : t("gaps.more", { count: rest.length })}
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
}

/** What the section shows for the gaps read: the three states `Pending` does not draw. */
export function useOpenGaps(planId: string) {
  return useQuery({ ...openGapsQuery(planId), enabled: Boolean(planId) });
}
