import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { FlashcardsResultView, MapResultView, QuizResultView, ToolResultView } from "@shared/ipc";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { ActivityNote, elapsedText } from "../../components/ActivityNote";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { invoke } from "../../lib/ipc";
import { useEngineError } from "../../lib/engineError";
import { jobErrorEngine, jobErrorKey } from "../jobs/jobErrors";
import { MapThumb } from "../maps/MapThumb";
import { mapPath } from "../maps/mapPath";
import "../maps/MapThumb.css";
import { Proposal } from "./Proposal";
import "./ToolResult.css";

type Request = "chats.undoTool" | "chats.restoreTool" | "chats.retryTool";

/**
 * What a Pyxis tool did, in the reply where the model called it. `line` is the body of the reply's ```pyxis-tool block:
 * `pending:<tool>` while the tool runs, else the result's id, which `view` describes. A result the reply does not carry
 * shows nothing. A state reached while the card is on screen grows out of the one before it: the working shape becomes
 * the card, and «Annulla» folds the card into its one line.
 *
 * A map or a quiz is made by a background job after the tool call returned, so its card reads the result again whenever
 * that job moves (`chats.toolView`, refreshed by `staleFamilies`), and stays at work until the job ends, after the reply
 * has ended and after a restart too.
 */
export function ToolResult({
  chatId,
  line,
  view,
  onView,
  onWaiting,
  onAsk,
  fresh = false,
}: {
  chatId: string;
  line: string;
  view?: ToolResultView;
  /** Hears the result's new state after «Annulla» or «Ripristina», for a reply still being written. */
  onView?: (view: ToolResultView) => void;
  /** A proposal tells the chat whether it waits for the student (`Proposal`). */
  onWaiting?: (id: string, waiting: boolean) => void;
  /** Sends a message in the chat, for a proposal's «Chiedi di nuovo». */
  onAsk?: (text: string) => void;
  /** The reply was just written: a proposal it holds takes the focus to its safe choice. */
  fresh?: boolean;
}) {
  const client = useQueryClient();
  const pending = line.startsWith("pending:");
  // The state the card was first drawn in: a later one is a change the student sees happen, so it animates.
  const [state, setState] = useState<ToolResultView | undefined>(view);
  useEffect(() => setState(view), [view]);
  // A new exam created from a proposal follows its build as a map follows its job.
  const followsJob =
    !pending && !!chatId && (view?.tool === "create_map" || view?.tool === "create_quiz" || view?.tool === "propose_exam");
  const key = ["tool-result", chatId, line];
  const live = useQuery({
    queryKey: key,
    queryFn: () => invoke("chats.toolView", { chatId, resultId: line }),
    enabled: followsJob,
    // A job's updates come with its steps, not with each model call: while it works the card looks again every few
    // seconds, so its note says what the call is doing.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.tool === "propose_exam") return data.created?.job === "working" ? 3000 : false;
      return data && "job" in data && data.job === "working" && !data.undone ? 3000 : false;
    },
  });
  // A proposal's card read again with the chat (it lapsed, or the student decided elsewhere) replaces what the query
  // held, so the card never keeps buttons the chat no longer offers. The build of a created exam keeps polling.
  useEffect(() => {
    if (view?.tool === "propose_exam" && followsJob) client.setQueryData(key, view);
  }, [view]);
  const shown = followsJob && live.data ? live.data : state;
  const first = useRef(pending ? "pending" : stateKey(view));
  if (pending) return <Working tool={line.slice("pending:".length)} />;
  // A sub-call to the stronger model leaves nothing where it ran: the reply is what came of it, and the tag names the model.
  if (!shown || shown.tool === "ask_stronger_model") return null;
  const arriving = first.current !== stateKey(shown);
  const onChange = (next: ToolResultView) => {
    setState(next);
    if (followsJob) client.setQueryData(key, next);
    onView?.(next);
  };
  if (shown.tool === "create_flashcards")
    return <Flashcards chatId={chatId} view={shown} arriving={arriving} onChange={onChange} />;
  if (shown.tool === "propose_path_change" || shown.tool === "propose_exam" || shown.tool === "propose_delete")
    return <Proposal chatId={chatId} view={shown} arriving={arriving} onChange={onChange} onWaiting={onWaiting} onAsk={onAsk} fresh={fresh} />;
  return <Made chatId={chatId} view={shown} arriving={arriving} onChange={onChange} />;
}

function stateKey(view: ToolResultView | undefined): string {
  if (!view) return "none";
  if (view.tool === "propose_exam") return `${view.state}${view.created ? `-${view.created.job}` : ""}`;
  if (view.tool === "propose_path_change" || view.tool === "propose_delete") return view.state;
  if (view.tool === "ask_stronger_model") return "done";
  if (view.tool === "create_flashcards") return view.undone === null ? "done" : "undone";
  return view.undone ? "undone" : view.gone ? "gone" : view.job;
}

/** «Annulla», «Ripristina» or «Riprova» on a result, with the keyboard kept in the card and the lists it changed refreshed. */
function useResultAction(chatId: string, view: ToolResultView, onChange: (view: ToolResultView) => void) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // After «Annulla» the focus goes to «Ripristina», and back to «Annulla» after it, so the keyboard stays in the card.
  const after = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const shape = stateKey(view);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    after.current?.querySelector<HTMLButtonElement>("button.px-toolres-act")?.focus();
  }, [shape]);

  async function act(request: Request) {
    if (!chatId || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const next = await invoke(request, { chatId, resultId: view.id });
      moved.current = true;
      onChange(next);
      // The chat as read shows the change, and so does every page that lists what the tool made.
      void client.invalidateQueries({ queryKey: ["chat", chatId] });
      const families =
        view.tool === "create_flashcards"
          ? ["card-browse"]
          : view.tool === "create_map"
            ? ["maps-all", "maps", "map", "map-build", "jobs", "jobs-finished"]
            : ["unfinished", "plans", "plan", "quiz-session", "jobs", "jobs-finished"];
      for (const family of families) void client.invalidateQueries({ queryKey: [family] });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const failure = failed ? (
    <p className="small px-toolres-failed" role="alert">
      {t("components.toolResult.failed")}
    </p>
  ) : null;
  return { act, busy, failure, after };
}

/**
 * The tool at work: one quiet line and a grey shape where the card will be. A map or a quiz can be stopped there.
 */
function Working({
  tool,
  onStop,
  busy,
  failure,
  activity,
  rootRef,
}: {
  tool: string;
  onStop?: () => void;
  busy?: boolean;
  failure?: ReactNode;
  /** What the job's model call is doing and since when, said as the app's other wait states say it. */
  activity?: MapResultView["activity"];
  /** The card's own ref, so the focus moves to «Ferma» when «Ripristina» or «Riprova» brings the card back to work. */
  rootRef?: Ref<HTMLDivElement>;
}) {
  const { t } = useTranslation();
  if (tool === "ask_stronger_model") return <Solving />;
  // A tool that only reads, such as `read_progress`, leaves no card, so its line stands alone and goes when the call ends.
  if (tool === "read_progress")
    return (
      <div className="px-toolres is-working" role="status">
        <span className="small px-toolres-working-line">{t("components.toolResult.reading")}</span>
      </div>
    );
  const map = tool === "create_map";
  const wide = map || tool === "create_quiz";
  return (
    <div ref={rootRef} className={`px-toolres is-working${wide ? " is-wide" : ""}`}>
      <div className="px-toolres-working-head">
        <span className="small px-toolres-working-line" role="status">
          {t(map ? "components.toolResult.workingMap" : tool === "create_quiz" ? "components.toolResult.workingQuiz" : "components.toolResult.working")}
        </span>
        <ActivityNote activity={activity} className="px-toolres-activity" />
        {onStop ? (
          <Button variant="ghost" size="sm" icon="square" disabled={busy} onClick={onStop} className="px-toolres-act">
            {t("components.toolResult.stop")}
          </Button>
        ) : null}
      </div>
      <div className="px-toolres-ghost" aria-hidden>
        {map ? <i className="px-toolres-ghost-preview" /> : null}
        <div className="px-toolres-ghost-bars">
          <i className="px-toolres-ghost-bar is-title" />
          <i className="px-toolres-ghost-bar" />
          <i className="px-toolres-ghost-bar is-short" />
        </div>
      </div>
      {failure}
    </div>
  );
}

/**
 * The stronger model at work: one quiet line, as a tool that only reads has, with the time since it started, since the
 * call can take a minute or two. The time counts from when the line appeared: the reply does not stream meanwhile, so the
 * line stays in place. The seconds are not a live region, as in `ActivityNote`.
 */
function Solving() {
  const { t } = useTranslation();
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="px-toolres is-working">
      <div className="px-toolres-working-head">
        <span className="small px-toolres-working-line" role="status">
          {t("components.toolResult.solving")}
        </span>
        <span className="px-activity-note px-toolres-activity">{elapsedText(now - since)}</span>
      </div>
    </div>
  );
}

/** One line in the card's place: undone, failed, stopped or gone, with the one action that fits. */
function Line({
  text,
  detail,
  action,
  arriving,
  failure,
  lineRef,
  wide = false,
}: {
  /** A map's or a quiz's line, as wide as its card. */
  wide?: boolean;
  text: string;
  detail?: ReactNode;
  action?: ReactNode;
  arriving: boolean;
  failure?: ReactNode;
  lineRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={lineRef} className={`px-toolres is-undone${wide ? " is-wide" : ""}${arriving ? " is-arriving" : ""}`}>
      <p className="small px-toolres-undone-line" role="status">
        {text}
        {detail ? <span className="px-toolres-detail"> {detail}</span> : null}
      </p>
      {action}
      {failure}
    </div>
  );
}

function Flashcards({
  chatId,
  view,
  arriving,
  onChange,
}: {
  chatId: string;
  view: FlashcardsResultView;
  arriving: boolean;
  onChange: (view: ToolResultView) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { act, busy, failure, after } = useResultAction(chatId, view, onChange);

  if (view.undone !== null)
    return (
      <Line
        lineRef={after}
        arriving={arriving}
        text={t("components.toolResult.undone", { count: view.undone })}
        action={
          <Button variant="ghost" size="sm" icon="rotate-ccw" disabled={busy || !chatId} onClick={() => void act("chats.restoreTool")} className="px-toolres-act">
            {t("components.toolResult.restore")}
          </Button>
        }
        failure={failure}
      />
    );

  const more = view.count - view.fronts.length;
  return (
    <section
      ref={after}
      className={arriving ? "px-toolres is-done is-arriving" : "px-toolres is-done"}
      aria-label={t("components.toolResult.title")}
    >
      <p className="label px-toolres-title">
        <Icon name="layers" size={16} />
        {t("components.toolResult.title")}
      </p>
      <p className="body-strong px-toolres-line">
        {view.title
          ? t("components.toolResult.titled", { count: view.count, title: view.title })
          : t("components.toolResult.inDeck", { count: view.count, deck: view.deck })}
      </p>
      <ul className="px-toolres-fronts">
        {view.fronts.map((front, index) => (
          <li key={index} className="body px-toolres-front">
            <InlineMarkdown>{front}</InlineMarkdown>
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="small px-toolres-more">{t("components.toolResult.more", { count: more })}</p> : null}
      {view.duplicates > 0 ? (
        <p className="small px-toolres-more">{t("components.toolResult.duplicates", { count: view.duplicates })}</p>
      ) : null}
      <div className="px-toolres-actions">
        <Button variant="secondary" size="sm" onClick={() => navigate(`/flashcards/all?made=${encodeURIComponent(view.id)}`)}>
          {t("components.toolResult.open")}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy || !chatId} onClick={() => void act("chats.undoTool")} className="px-toolres-act">
          {t("components.toolResult.undo")}
        </Button>
      </div>
      {failure}
    </section>
  );
}

/** A map or a quiz made by a background job: at work, done, failed or stopped, undone, or deleted since. */
function Made({
  chatId,
  view,
  arriving,
  onChange,
}: {
  chatId: string;
  view: MapResultView | QuizResultView;
  arriving: boolean;
  onChange: (view: ToolResultView) => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const describeEngineError = useEngineError(navigate);
  const { act, busy, failure, after } = useResultAction(chatId, view, onChange);
  const map = view.tool === "create_map";
  const own = (key: string) => `components.toolResult.${map ? "map" : "quiz"}.${key}`;
  const button = (label: string, request: Request, icon?: "rotate-ccw" | "refresh-cw") => (
    <Button variant="ghost" size="sm" icon={icon} disabled={busy || !chatId} onClick={() => void act(request)} className="px-toolres-act">
      {label}
    </Button>
  );

  // What the result went into was deleted while it was undone: nothing can bring it back, so the line says so, alone.
  if (view.undone && !view.restorable) return <Line wide arriving={arriving} text={t(own("unrestorable"))} />;
  if (view.undone)
    return (
      <Line
        wide
        lineRef={after}
        arriving={arriving}
        text={t(own("undone"))}
        action={button(t("components.toolResult.restore"), "chats.restoreTool", "rotate-ccw")}
        failure={failure}
      />
    );
  if (view.gone) return <Line wide arriving={arriving} text={t(own("gone"))} />;
  if (view.job === "working")
    return (
      <Working
        tool={view.tool}
        onStop={() => void act("chats.undoTool")}
        busy={busy}
        failure={failure}
        activity={view.activity}
        rootRef={after}
      />
    );
  if (view.job === "failed") {
    const reason = view.error ? describeEngineError(jobErrorKey(view.error), jobErrorEngine(view.error)).text : t("jobs.failedGeneral");
    // A map whose words found nothing in the material reads nothing new on a retry: the student asks again in other words.
    const retry = view.error !== "map-nothing-matched";
    return (
      <Line
        wide
        lineRef={after}
        arriving={arriving}
        text={t(own("failed"))}
        detail={reason}
        action={retry ? button(t("components.toolResult.retry"), "chats.retryTool", "refresh-cw") : undefined}
        failure={failure}
      />
    );
  }
  if (view.job === "cancelled" || view.job === "interrupted")
    return (
      <Line
        wide
        lineRef={after}
        arriving={arriving}
        text={t(own("stopped"))}
        detail={t(view.job === "interrupted" ? "jobs.problem.interrupted_one" : "jobs.problem.cancelled_one")}
        action={button(t("components.toolResult.resume"), "chats.retryTool")}
        failure={failure}
      />
    );

  const className = `px-toolres is-done is-made${map ? " is-map" : ""}${arriving ? " is-arriving" : ""}`;
  const open = () =>
    navigate(
      view.tool === "create_map"
        ? mapPath({ subjectId: view.subjectId, id: view.mapId })
        : `/plans/${view.planId}/quiz/${view.routeTopicId ?? ""}?attempt=${encodeURIComponent(view.attemptId)}`,
    );
  const link = (to: string) => (
    <a
      href={`#${to}`}
      className="px-toolres-link"
      onClick={(event) => {
        event.preventDefault();
        navigate(to);
      }}
    />
  );
  let heading: string;
  let details: ReactNode;
  if (view.tool === "create_map") {
    heading = view.topic;
    details = (
      <>
        {`${t("components.toolResult.map.concepts", { count: view.concepts })} ${t("components.toolResult.map.branches", { count: view.branches })}. `}
        <Trans i18nKey="components.toolResult.map.where" values={{ subject: view.subject }} components={{ place: link("/maps") }} />
      </>
    );
  } else {
    const kinds = (["mcq", "tf", "completion", "matching", "open"] as const).flatMap((kind) =>
      view.kinds[kind] ? [t(`components.toolResult.quiz.kind.${kind}`, { count: view.kinds[kind] })] : [],
    );
    const list = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(kinds);
    heading = t("components.toolResult.quiz.line", { topic: view.topic, count: view.count });
    details = (
      <>
        {kinds.length ? `${list}, ${t("components.toolResult.quiz.minutes", { count: view.minutes })}. ` : null}
        <Trans
          i18nKey={view.handedIn ? "components.toolResult.quiz.whereHandedIn" : "components.toolResult.quiz.where"}
          values={{ exam: view.exam }}
          components={{ place: link(`/plans/${view.planId}`) }}
        />
      </>
    );
  }
  return (
    <section ref={after} className={className} aria-label={t(own("title"))}>
      {view.tool === "create_map" ? (
        <div className="px-toolres-preview" aria-hidden>
          <MapThumb shape={view.shape} />
        </div>
      ) : null}
      <div className="px-toolres-body">
        <p className="label px-toolres-title">
          <Icon name={map ? "network" : "list-checks"} size={16} />
          {t(own("title"))}
        </p>
        <p className="title-2 px-toolres-heading">{heading}</p>
        <p className="small px-toolres-where">{details}</p>
        <div className="px-toolres-actions">
          <Button variant="secondary" size="sm" onClick={open}>
            {t("components.toolResult.open")}
          </Button>
          {view.tool === "create_quiz" && view.handedIn ? (
            <p className="small px-toolres-more px-toolres-kept">{t("components.toolResult.quiz.handedIn")}</p>
          ) : (
            <Button variant="ghost" size="sm" icon="undo-2" disabled={busy || !chatId} onClick={() => void act("chats.undoTool")} className="px-toolres-act">
              {t("components.toolResult.undo")}
            </Button>
          )}
        </div>
        {failure}
      </div>
    </section>
  );
}
