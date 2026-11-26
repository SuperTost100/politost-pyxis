import { useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { DeleteProposalView, ExamProposalView, PathProposalView, ProposalView, ToolResultView } from "@shared/ipc";
import { ActivityNote } from "../../components/ActivityNote";
import { Button } from "../../components/Button";
import { Icon, type IconName } from "../../components/Icon";
import { invoke } from "../../lib/ipc";
import { useEngineError } from "../../lib/engineError";
import { jobErrorEngine, jobErrorKey } from "../jobs/jobErrors";
import { emptyDraft } from "../plans/examSessions";
import type { WizardSeed } from "../plans/wizardSeed";
import "./Proposal.css";

type Action = "apply" | "decline" | "reopen" | "undo";


/**
 * A proposal of an "ask first" tool in the reply where the model called it (`propose_*`, core `tools/proposals.ts`):
 * a card that says what would change, with the confirming button as the screen's one primary, or once decided the one
 * line that says what happened. Only these buttons decide: the model cannot. While the reply is still written the
 * buttons wait. A card that just became actionable takes the focus to its safe choice when nothing else holds it.
 */
export function Proposal({
  chatId,
  view,
  arriving,
  onChange,
  onWaiting,
  onAsk,
  fresh,
}: {
  chatId: string;
  view: ProposalView;
  arriving: boolean;
  onChange: (view: ToolResultView) => void;
  /** Tells the chat whether this card waits for the student, so «Invia» is drawn quiet meanwhile. */
  onWaiting?: (id: string, waiting: boolean) => void;
  /** Sends a message in the chat, for «Chiedi di nuovo»; absent while an answer is written. */
  onAsk?: (text: string) => void;
  /** Its reply was just written, so a card that waits takes the focus as it appears. */
  fresh: boolean;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLElement & HTMLDivElement>(null);
  const moved = useRef(false);
  const waiting = view.state === "pending" && view.ready;

  useEffect(() => {
    onWaiting?.(view.id, waiting);
    return () => onWaiting?.(view.id, false);
  }, [onWaiting, view.id, waiting]);

  // The card became one the student can answer while on screen, in the reply just written or after «Rivedi la
  // proposta»: the focus goes to the safe choice, unless the student is already somewhere else, such as typing.
  const wasWaiting = useRef(waiting && !fresh);
  useEffect(() => {
    const became = waiting && !wasWaiting.current;
    wasWaiting.current = waiting;
    if (!became) return;
    // The focus is free when nothing holds it, or when it is in an empty field, such as the composer after sending.
    const active = document.activeElement;
    const typed =
      active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
        ? active.value
        : active instanceof HTMLElement && active.isContentEditable
          ? (active.textContent ?? "")
          : null;
    const free = !active || active === document.body || (typed !== null && !typed.trim());
    if (free) root.current?.querySelector<HTMLButtonElement>("button.px-ask-safe")?.focus();
  }, [waiting]);

  // After a decision the focus goes to the line's button, or to the line itself, so the keyboard stays in the card.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    // A card reopened waits again, and its safe choice takes the focus, as when it first arrived.
    const target =
      (view.state === "pending" ? root.current?.querySelector<HTMLButtonElement>("button.px-ask-safe") : null) ??
      root.current?.querySelector<HTMLButtonElement>("button") ??
      root.current;
    target?.focus();
  }, [view.state]);

  async function decide(action: Action) {
    if (!chatId || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const next = await invoke("chats.decideTool", { chatId, resultId: view.id, action, seen: view.seen });
      moved.current = true;
      onChange(next);
      void client.invalidateQueries({ queryKey: ["chat", chatId] });
      // Every page that shows what the change touched reads it again.
      const families =
        view.tool === "propose_path_change"
          ? ["plans", "plan", "planner", "plan-schedule", "unfinished", "rings", "today"]
          : view.tool === "propose_exam"
            ? ["plans", "plan", "jobs", "subjects"]
            : ["card-browse", "card-sections", "maps", "maps-all", "map", "unfinished", "plans", "plan", "jobs"];
      for (const family of families) void client.invalidateQueries({ queryKey: [family] });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  // The exam's build stopped (from Attività, or cut off by a restart): it starts again as the build screen's own button
  // does, and the card follows it.
  async function resumeBuild(jobId: string, interrupted: boolean) {
    if (!chatId || busy) return;
    setBusy(true);
    setFailed(false);
    let started = false;
    try {
      await invoke(interrupted ? "jobs.resume" : "jobs.retry", { jobId });
      started = true;
      moved.current = true;
      // The build is going again: the card's own query reads it from here, whatever happens to the read below, and
      // polls while it works (`ToolResult`).
      void client.invalidateQueries({ queryKey: ["tool-result", chatId, view.id] });
      for (const family of ["plans", "plan", "jobs"]) void client.invalidateQueries({ queryKey: [family] });
      const next = await invoke("chats.toolView", { chatId, resultId: view.id });
      if (next) onChange(next);
    } catch {
      // Only a build that did not start again is a failure to show; a read that failed after it is made good above.
      if (!started) setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const failure = failed ? (
    <p className="small px-toolres-failed" role="alert">
      {t("components.toolResult.proposal.failed")}
    </p>
  ) : null;
  const props = { view, arriving, busy, failure, decide, resumeBuild, onAsk, rootRef: root, chatId };
  if (view.tool === "propose_path_change") return <PathCard {...props} view={view} />;
  if (view.tool === "propose_exam") return <ExamCard {...props} view={view} />;
  return <DeleteCard {...props} view={view} />;
}

type CardProps<V> = {
  view: V;
  arriving: boolean;
  busy: boolean;
  failure: ReactNode;
  decide: (action: Action) => Promise<void>;
  resumeBuild: (jobId: string, interrupted: boolean) => Promise<void>;
  onAsk?: (text: string) => void;
  rootRef: Ref<HTMLElement & HTMLDivElement>;
  chatId: string;
};

/** A day as the exam pages write it: "venerdì 15 gennaio", with the year when it is not this year's. */
function useDay(weekday = true) {
  const { i18n } = useTranslation();
  return (at: number) =>
    new Intl.DateTimeFormat(i18n.language, {
      ...(weekday ? { weekday: "long" as const } : {}),
      day: "numeric",
      month: "long",
      ...(new Date(at).getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
    }).format(at);
}

/** The card while it waits: the kicker, the question, what it holds and the buttons. */
function AskCard({
  title,
  arriving,
  rootRef,
  children,
  actions,
  failure,
  ready,
}: {
  title: string;
  arriving: boolean;
  rootRef: Ref<HTMLElement & HTMLDivElement>;
  children: ReactNode;
  actions: ReactNode;
  failure: ReactNode;
  ready: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section
      ref={rootRef}
      className={`px-toolres is-done is-ask${arriving ? " is-arriving" : ""}`}
      aria-label={`${t("components.toolResult.proposal.kicker")}: ${title}`}
    >
      <p className="label px-toolres-title">{t("components.toolResult.proposal.kicker")}</p>
      <p className="title-2 px-toolres-heading">{title}</p>
      {children}
      <div className="px-toolres-actions px-ask-actions">{actions}</div>
      {ready ? null : <p className="small px-toolres-more">{t("components.toolResult.proposal.waiting")}</p>}
      {failure}
    </section>
  );
}

/** One line where the card was, once decided or no longer answerable, with the one action that fits. */
function Outcome({
  icon,
  text,
  detail,
  action,
  arriving,
  rootRef,
  failure,
  done = false,
}: {
  icon: IconName;
  text: string;
  detail?: ReactNode;
  action?: ReactNode;
  arriving: boolean;
  rootRef: Ref<HTMLElement & HTMLDivElement>;
  failure?: ReactNode;
  /** The change was made: the icon says so in the colour of a thing done. */
  done?: boolean;
}) {
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={`px-toolres is-wide px-ask-outcome${done ? " is-made-change" : ""}${arriving ? " is-arriving" : ""}`}
    >
      <Icon name={icon} size={18} className="px-ask-outcome-icon" />
      <p className="small px-ask-outcome-line" role="status">
        {text}
        {detail ? <span className="px-toolres-detail"> {detail}</span> : null}
      </p>
      {action}
      {failure}
    </div>
  );
}

const expired = (props: CardProps<ProposalView>, text: string) => (
  <Outcome icon="circle-dashed" text={text} arriving={props.arriving} rootRef={props.rootRef} />
);

function PathCard(props: CardProps<PathProposalView>) {
  const { view, busy, decide, arriving, rootRef, failure, onAsk } = props;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const day = useDay();
  const shortDay = useDay(false);
  const own = (key: string, values?: Record<string, unknown>) => t(`components.toolResult.proposal.path.${key}`, values);
  if (view.gone) return <Outcome icon="x" text={own("gone")} arriving={arriving} rootRef={rootRef} />;
  if (view.state === "expired") return expired(props, t("components.toolResult.proposal.expired"));
  if (view.state === "applied") {
    const what = [
      view.date ? own("appliedDate", { date: shortDay(view.appliedDate ?? view.date.to) }) : "",
      view.hours ? own("hoursValue", { count: view.hours.to }) : "",
      view.changed ? own("appliedTopics", { count: view.changed }) : "",
    ].filter(Boolean);
    return (
      <Outcome
        done
        icon="circle-check"
        text={own("applied", { what: what.join(", ") })}
        arriving={arriving}
        rootRef={rootRef}
        action={
          <Button variant="secondary" size="sm" onClick={() => navigate(`/plans/${view.planId}`)}>
            {own("open")}
          </Button>
        }
      />
    );
  }
  if (view.state === "declined")
    return (
      <Outcome
        icon="x"
        text={own("declined")}
        arriving={arriving}
        rootRef={rootRef}
        failure={failure}
        action={
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decide("reopen")}>
            {t("components.toolResult.proposal.reopen")}
          </Button>
        }
      />
    );
  if (view.state === "stale")
    return (
      <Outcome
        icon="circle-alert"
        text={view.datePast && view.date ? own("datePast", { date: day(view.date.to) }) : own("stale")}
        arriving={arriving}
        rootRef={rootRef}
        action={
          onAsk ? (
            <Button variant="ghost" size="sm" onClick={() => onAsk(own("askMessage"))}>
              {t("components.toolResult.proposal.askAgain")}
            </Button>
          ) : undefined
        }
      />
    );
  const removed = view.before.some((topic) => topic.removed);
  const general = view.after.some((topic) => topic.added && !topic.restored);
  return (
    <AskCard
      title={own("title", { exam: view.exam })}
      arriving={arriving}
      rootRef={rootRef}
      failure={failure}
      ready={view.ready}
      actions={
        <>
          <Button variant="primary" size="sm" disabled={busy || !view.ready} onClick={() => void decide("apply")}>
            {own("apply")}
          </Button>
          <Button variant="ghost" size="sm" className="px-ask-safe" disabled={busy || !view.ready} onClick={() => void decide("decline")}>
            {own("decline")}
          </Button>
        </>
      }
    >
      {view.date || view.hours ? (
        <dl className="px-ask-facts">
          {view.date ? (
            <>
              <dt>{view.date.label ? own("dateLabelled", { label: view.date.label }) : own("date")}</dt>
              <dd>
                <Change from={view.date.from === null ? own("noDate") : day(view.date.from)} to={day(view.date.to)} />
                {view.date.next ? (
                  <small>
                    {own(view.date.next.label ? "nextLabelled" : "next", { date: day(view.date.next.date), label: view.date.next.label })}
                  </small>
                ) : null}
              </dd>
            </>
          ) : null}
          {view.hours ? (
            <>
              <dt>{own("hours")}</dt>
              <dd>
                <Change
                  from={view.hours.from === null ? own("hoursNone") : own("hoursValue", { count: view.hours.from })}
                  to={own("hoursValue", { count: view.hours.to })}
                />
                <small>{own("hoursAll")}</small>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {view.after.length ? (
        <div className="px-ask-diff">
          <div>
            <p className="label px-ask-diff-head">{own("now")}</p>
            <ol>
              {view.before.map((topic, index) => (
                <li key={index} className={topic.removed ? "is-removed" : undefined}>
                  <span className="px-ask-diff-title">{topic.title}</span>
                  {topic.removed ? <em>{own("removed")}</em> : null}
                </li>
              ))}
            </ol>
          </div>
          <div>
            <p className="label px-ask-diff-head">{own("after")}</p>
            <ol>
              {view.after.map((topic, index) => (
                <li key={index} className={topic.added ? "is-added" : topic.movedFrom !== null ? "is-moved" : undefined}>
                  <span className="px-ask-diff-title">{topic.title}</span>
                  {topic.added ? (
                    <em>{own(topic.restored ? "restored" : "added")}</em>
                  ) : topic.movedFrom !== null ? (
                    <em>{own("moved", { n: topic.movedFrom })}</em>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        </div>
      ) : null}
      <p className="small px-ask-note">
        {own("kept")}
        {removed ? ` ${own("keptRemoved")}` : ""}
        {general ? ` ${own("general")}` : ""}
      </p>
    </AskCard>
  );
}

/** An old value struck through and the new one after an arrow. */
function Change({ from, to }: { from: string; to: string }) {
  return (
    <>
      <del>{from}</del>
      <span className="px-ask-to">
        <Icon name="arrow-right" size={14} />
        {to}
      </span>
    </>
  );
}

function ExamCard(props: CardProps<ExamProposalView>) {
  const { view, busy, decide, resumeBuild, arriving, rootRef, failure, onAsk } = props;
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const describeEngineError = useEngineError(navigate);
  const day = useDay();
  const own = (key: string, values?: Record<string, unknown>) => t(`components.toolResult.proposal.exam.${key}`, values);
  if (view.state === "expired") return expired(props, t("components.toolResult.proposal.expired"));
  if (view.state === "applied" && view.created) {
    const made = view.created;
    if (made.gone) return <Outcome icon="x" text={own("createdGone")} arriving={arriving} rootRef={rootRef} />;
    // A build that stopped made no path: the line says the creation stopped and offers to start it again.
    if (made.job === "cancelled" || made.job === "interrupted")
      return (
        <Outcome
          icon="circle-alert"
          text={own("buildStopped", { title: view.title })}
          arriving={arriving}
          rootRef={rootRef}
          failure={failure}
          action={
            <Button variant="ghost" size="sm" icon="rotate-ccw" disabled={busy} onClick={() => void resumeBuild(made.jobId, made.job === "interrupted")}>
              {t("components.toolResult.resume")}
            </Button>
          }
        />
      );
    const line = view.date === null ? own("created", { title: view.title }) : own("createdDated", { title: view.title, date: day(view.date) });
    const open = (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => navigate(made.job === "working" ? `/plans/new?build=${made.planId}` : `/plans/${made.planId}`)}
      >
        {own("open")}
      </Button>
    );
    const detail =
      made.job === "working" ? (
        <>
          {own("building")} <ActivityNote activity={made.activity} className="px-toolres-activity" />
        </>
      ) : made.job === "failed" ? (
        <>
          {own("buildFailed")}{" "}
          {made.error ? describeEngineError(jobErrorKey(made.error), jobErrorEngine(made.error)).text : t("jobs.failedGeneral")}
        </>
      ) : undefined;
    return <Outcome done icon="circle-check" text={line} detail={detail} action={open} arriving={arriving} rootRef={rootRef} />;
  }
  if (view.state === "declined")
    return (
      <Outcome
        icon="x"
        text={own("declined")}
        arriving={arriving}
        rootRef={rootRef}
        failure={failure}
        action={
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decide("reopen")}>
            {t("components.toolResult.proposal.reopen")}
          </Button>
        }
      />
    );
  if (view.state === "stale")
    return view.existing ? (
      <Outcome
        icon="circle-alert"
        text={own("existing", { title: view.title })}
        arriving={arriving}
        rootRef={rootRef}
        action={
          <Button variant="secondary" size="sm" onClick={() => navigate(`/plans/${view.existing}`)}>
            {own("open")}
          </Button>
        }
      />
    ) : (
      <Outcome
        icon="circle-alert"
        text={view.datePast && view.date !== null ? own("datePast", { date: day(view.date) }) : own("stale", { subject: view.subject ?? view.title })}
        arriving={arriving}
        rootRef={rootRef}
        action={
          onAsk ? (
            <Button variant="ghost" size="sm" onClick={() => onAsk(own("askMessage", { title: view.title }))}>
              {t("components.toolResult.proposal.askAgain")}
            </Button>
          ) : undefined
        }
      />
    );
  const material = view.sources.length > 0;
  // «Modifica prima» opens the app's own exam form on its first step, filled in with this draft.
  const edit = () => {
    const seed: WizardSeed = {
      title: view.title,
      subject: view.subject ?? "",
      examChoice: "",
      sessions: [emptyDraft(view.date === null ? {} : { date: dayjs(view.date).format("YYYY-MM-DD") })],
      target: 0.75,
      language: i18n.language.startsWith("en") ? "en" : "it",
      picked: view.sources.map((source) => source.id),
    };
    navigate("/plans/new", { state: { wizard: seed, step: 0 } });
  };
  const list = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(view.sources.map((source) => source.title));
  return (
    <AskCard
      title={own("title", { title: view.title })}
      arriving={arriving}
      rootRef={rootRef}
      failure={failure}
      ready={view.ready}
      actions={
        <>
          {material ? (
            <Button variant="primary" size="sm" disabled={busy || !view.ready} onClick={() => void decide("apply")}>
              {own("create")}
            </Button>
          ) : null}
          <Button variant={material ? "secondary" : "primary"} size="sm" disabled={busy || !view.ready} onClick={edit}>
            {own("edit")}
          </Button>
          <Button variant="ghost" size="sm" className="px-ask-safe" disabled={busy || !view.ready} onClick={() => void decide("decline")}>
            {own("decline")}
          </Button>
        </>
      }
    >
      <dl className="px-ask-facts">
        <dt>{own("date")}</dt>
        <dd>{view.date === null ? own("noDate") : day(view.date)}</dd>
        {view.subject && view.subject !== view.title ? (
          <>
            <dt>{own("subject")}</dt>
            <dd>{view.subject}</dd>
          </>
        ) : null}
        <dt>{own("sources")}</dt>
        <dd>{material ? own("sourcesList", { list }) : own("noSources", { subject: view.subject ?? view.title })}</dd>
      </dl>
      {material ? null : <p className="small px-ask-note">{own("noSourcesHint")}</p>}
    </AskCard>
  );
}

function DeleteCard(props: CardProps<DeleteProposalView>) {
  const { view, busy, decide, arriving, rootRef, failure, onAsk } = props;
  const { t } = useTranslation();
  const own = (key: string, values?: Record<string, unknown>) => t(`components.toolResult.proposal.delete.${key}`, values);
  if (view.state === "expired") return expired(props, t("components.toolResult.proposal.expired"));
  const kindKey = view.kind === "flashcards" ? "Cards" : view.kind === "map" ? "Map" : "Quiz";
  if (view.state === "applied")
    return (
      <Outcome
        icon="trash-2"
        text={
          view.kind === "flashcards"
            ? view.name
              ? own("doneCards", { count: view.count, name: view.name })
              : own("doneChatCards", { count: view.count })
            : view.kind === "map"
              ? own("doneMap", { name: view.name })
              : own("doneQuiz", { place: view.place })
        }
        detail={view.restorable ? undefined : own("unrestorable")}
        arriving={arriving}
        rootRef={rootRef}
        failure={failure}
        action={
          view.restorable ? (
            <Button variant="ghost" size="sm" icon="undo-2" disabled={busy} onClick={() => void decide("undo")}>
              {own("undo")}
            </Button>
          ) : undefined
        }
      />
    );
  if (view.state === "restored")
    return (
      <Outcome
        icon="rotate-ccw"
        text={
          view.kind === "flashcards" && view.back !== null && view.back < view.count
            ? own("restoredCardsSome", { count: view.back, other: view.count - view.back })
            : own(`restored${kindKey}`)
        }
        arriving={arriving}
        rootRef={rootRef}
      />
    );
  if (view.state === "declined")
    return (
      <Outcome
        icon="x"
        text={own("declined")}
        arriving={arriving}
        rootRef={rootRef}
        failure={failure}
        action={
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decide("reopen")}>
            {t("components.toolResult.proposal.reopen")}
          </Button>
        }
      />
    );
  if (view.state === "stale")
    return (
      <Outcome
        icon="circle-alert"
        text={own("stale")}
        arriving={arriving}
        rootRef={rootRef}
        action={
          onAsk ? (
            <Button variant="ghost" size="sm" onClick={() => onAsk(own("askMessage"))}>
              {t("components.toolResult.proposal.askAgain")}
            </Button>
          ) : undefined
        }
      />
    );
  const title =
    view.kind === "flashcards"
      ? view.name
        ? own("cardsTitle", { count: view.count, name: view.name })
        : own("chatCardsTitle", { count: view.count })
      : view.kind === "map"
        ? own("mapTitle", { name: view.name })
        : view.name
          ? own("quizTitle", { name: view.name })
          : own("quizExamTitle");
  const body =
    view.kind === "flashcards"
      ? [
          view.reviewed ? own("reviewed", { count: view.reviewed }) : "",
          view.handMade ? own("handMade", { count: view.handMade }) : "",
          view.others ? own("others", { count: view.others, place: view.place }) : "",
          own("cardsUndo"),
        ]
      : view.kind === "map"
        ? [own("map", { count: view.count, place: view.place })]
        : [own("quiz", { count: view.count, answered: view.answered })];
  return (
    <AskCard
      title={title}
      arriving={arriving}
      rootRef={rootRef}
      failure={failure}
      ready={view.ready}
      actions={
        <>
          <Button variant="secondary" size="sm" className="px-ask-safe" disabled={busy || !view.ready} onClick={() => void decide("decline")}>
            {own("keep")}
          </Button>
          <Button variant="danger-solid" size="sm" disabled={busy || !view.ready} onClick={() => void decide("apply")}>
            {view.kind === "flashcards" ? own("confirmCards", { count: view.count }) : own(`confirm${kindKey}`)}
          </Button>
        </>
      }
    >
      <p className="body px-ask-body">{body.filter(Boolean).join(" ")}</p>
    </AskCard>
  );
}
