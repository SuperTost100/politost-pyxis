import { Button } from "antd";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { clozeAnswer, isCloze } from "../../../../core/study/cloze";
import { daysBetween } from "../../../../shared/local-day";
import { MarkdownView } from "../../components/MarkdownView";
import "./SessionEnd.css";
import {
  RATINGS,
  SHOWN_PER_ANSWER,
  barShare,
  countdownText,
  groupSeen,
  minutesLeft,
  rateCounts,
  type RatingName,
  type SeenCard,
} from "./sessionEnd";

/** When the reviewed cards that are not due yet come back (`study.dueLater`), or what is known of it. */
export type Upcoming =
  | { status: "loading" | "failed" }
  | {
      status: "ready";
      later: Array<{ at: number; subject: string | null; count: number }>;
      next: { at: number; count: number } | null;
    };

/** A card of this session waiting for its next learning step, and when it is due. */
export type WaitingCard = { cardId: string; dueAt: number };

/** The card as a line of text: a cloze card shows its answer filled in, as the card browser does. */
const frontText = (front: string) => (isCloze(front) ? clozeAnswer(front) : front);

/**
 * The end of a flashcard session, in two columns like the results of a quiz. On the left, what the session is doing
 * (a card of it still counting down, or finished), the four answers as bars and, while a card is due back, the way to
 * stop for today. On the right, the cards seen under the answer the student gave, and what comes back later.
 *
 * It stays on screen while the card counts down. When the card is due the page shows it and this goes.
 */
export function SessionEnd({
  seen,
  waiting,
  upcoming,
  onStop,
  stopBusy,
}: {
  seen: SeenCard[];
  waiting: WaitingCard[];
  upcoming: Upcoming;
  /** "Per oggi basta": leaves the way the bar's back control does. */
  onStop: () => void;
  stopBusy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const counts = useMemo(() => rateCounts(seen), [seen]);
  const [unfolded, setUnfolded] = useState<ReadonlySet<RatingName>>(new Set());
  const soonest = waiting.length ? Math.min(...waiting.map((card) => card.dueAt)) : null;
  const waitingIds = useMemo(() => new Set(waiting.map((card) => card.cardId)), [waiting]);
  const groups = useMemo(() => groupSeen(seen, waitingIds), [seen, waitingIds]);

  // The countdown is the only thing that moves each second, and a screen reader is told nothing of it: it hears the
  // state once, below, and the card itself when it arrives.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (soonest == null) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [soonest != null]);

  const clock = new Intl.DateTimeFormat(i18n.language, { hour: "numeric", minute: "2-digit" });
  const dayName = new Intl.DateTimeFormat(i18n.language, { weekday: "long", day: "numeric", month: "long" });
  const later = upcoming.status === "ready" ? upcoming.later : [];
  const next = upcoming.status === "ready" ? upcoming.next : null;
  const laterTotal = later.reduce((sum, row) => sum + row.count, 0);
  const phase = soonest != null ? "waiting" : later.length > 0 ? "later" : "done";
  // A card still to come needs no read; a finished session waits for what comes back later before it words its ending.
  const ready = phase === "waiting" || upcoming.status !== "loading";

  const title = phase === "later" ? t("cards.endLaterTitle") : t("cards.endDone");
  const text =
    phase === "waiting"
      ? t("cards.endWaitingText", { count: waiting.length })
      : [
          t("cards.endGave", { count: seen.length }),
          phase === "later"
            ? t("cards.endLater", { count: laterTotal, time: clock.format(later[0]!.at) })
            : next
              ? t("cards.endNext", {
                  count: next.count,
                  when:
                    daysBetween(now, next.at) === 1
                      ? t("cards.endTomorrow")
                      : t("cards.endOnDay", { day: dayName.format(next.at) }),
                })
              : "",
        ]
          .filter(Boolean)
          .join(" ");

  // Said once when the state changes, in a region that was already there: the headline, or for a card still to come the
  // wait as the page has always put it.
  const announcement = !ready
    ? ""
    : phase === "waiting"
      ? t("cards.learningWait", { count: minutesLeft(soonest! - now) })
      : `${title}. ${text}`;
  const [said, setSaid] = useState("");
  const sayWhen = ready ? phase : "";
  useEffect(() => setSaid(announcement), [sayWhen]);

  const toggle = (rating: RatingName) =>
    setUnfolded((current) => {
      const copy = new Set(current);
      if (!copy.delete(rating)) copy.add(rating);
      return copy;
    });

  return (
    <div className="px-end">
      <section className="px-end-summary" aria-labelledby={titleId}>
        <p className="small px-end-kicker">
          {phase === "waiting" ? t("cards.endWaiting", { count: waiting.length }) : t("cards.endKicker")}
        </p>
        {phase === "waiting" ? (
          <p id={titleId} className="px-end-clock" role="timer" aria-live="off">
            {countdownText(soonest! - now)}
          </p>
        ) : (
          <h2 id={titleId} className="px-end-title" data-ready={ready}>
            {title}
          </h2>
        )}
        <p className="px-end-text" data-ready={ready}>
          {text}
        </p>
        <ul className="px-end-bars" aria-label={t("cards.endAnswers")}>
          {RATINGS.map((rating, index) => (
            <li key={rating} data-rate={rating} style={{ "--i": index } as React.CSSProperties}>
              <span className="px-end-label">{t(`cards.${rating}`)}</span>
              <span className="px-end-bar" aria-hidden>
                <i style={{ width: `${100 * barShare(counts[rating], counts)}%` }} />
              </span>
              <b>{counts[rating]}</b>
            </li>
          ))}
        </ul>
        {phase === "waiting" ? (
          <div className="px-end-stop">
            <Button shape="round" disabled={stopBusy} onClick={onStop}>
              {t("cards.endStop")}
            </Button>
            <p className="px-end-fine">{t("cards.endStopHint", { count: waiting.length })}</p>
          </div>
        ) : null}
        <div className="visually-hidden" role="status">
          {said}
        </div>
      </section>
      <section className="px-end-seen" aria-label={t("cards.endSeen")}>
        {phase === "waiting" ? (
          <Group title={t("cards.endSoon")} count={waiting.length}>
            {[...waiting]
              .sort((a, b) => a.dueAt - b.dueAt)
              .map((card) => {
                const item = seen.findLast((entry) => entry.cardId === card.cardId);
                return item ? <Row key={card.cardId} item={item} aside={countdownText(card.dueAt - now)} /> : null;
              })}
          </Group>
        ) : null}
        {phase === "later" ? (
          <Group title={t("cards.endToday")} count={laterTotal}>
            {later.map((row) => (
              <li key={row.subject ?? ""} className="px-end-row">
                <span className="px-end-front">
                  {row.subject
                    ? t("cards.endLaterIn", { count: row.count, subject: row.subject })
                    : t("cards.endLaterNoSubject", { count: row.count })}
                </span>
                <span className="px-end-aside">{clock.format(row.at)}</span>
              </li>
            ))}
          </Group>
        ) : null}
        {groups.map(({ rating, cards }) => {
          const open = unfolded.has(rating);
          const shown = open ? cards : cards.slice(0, SHOWN_PER_ANSWER);
          const listId = `${titleId}-${rating}`;
          return (
            <Group key={rating} rate={rating} title={t(`cards.${rating}`)} count={cards.length} listId={listId}>
              {shown.map((item) => (
                <Row key={item.reviewId} item={item} />
              ))}
              {cards.length > SHOWN_PER_ANSWER ? (
                <li className="px-end-more">
                  <button type="button" aria-expanded={open} aria-controls={listId} onClick={() => toggle(rating)}>
                    {open ? t("cards.endFewer") : t("cards.endMore", { count: cards.length - SHOWN_PER_ANSWER })}
                    <ChevronDown size={14} strokeWidth={1.75} aria-hidden className={open ? "is-open" : undefined} />
                  </button>
                </li>
              ) : null}
            </Group>
          );
        })}
      </section>
    </div>
  );
}

function Group({
  title,
  count,
  rate,
  listId,
  children,
}: {
  title: string;
  count: number;
  rate?: RatingName;
  listId?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section className="px-end-group" data-rate={rate} aria-labelledby={id}>
      <h2 id={id}>
        <span className="px-end-chip">{title}</span>
        <span className="px-end-count">{count}</span>
      </h2>
      <ul id={listId} className="px-end-list">
        {children}
      </ul>
    </section>
  );
}

function Row({ item, aside }: { item: SeenCard; aside?: string }) {
  return (
    <li className="px-end-row">
      <span className="px-end-front">
        <MarkdownView variant="body">{frontText(item.front)}</MarkdownView>
      </span>
      {item.subject ? <span className="px-end-subject">{item.subject}</span> : null}
      {aside ? <span className="px-end-aside">{aside}</span> : null}
    </li>
  );
}

