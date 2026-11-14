import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { MAP_INSTRUCTION_MAX } from "@shared/concept-map";
import { QUIZ_MAX_QUESTIONS } from "@shared/quiz";
import {
  PreviewTiles,
  RadioRows,
  Segmented,
  Stepper,
  ToggleChips,
} from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { Icon, type IconName } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { errorProvider, useEngineError } from "../../lib/engineError";
import { invoke } from "../../lib/ipc";
import { pastPapersQuery } from "../../lib/queries";
import type { MadeActivity } from "./making";
import "./ExamCreateDialog.css";

type Plan = NonNullable<RequestOutput<"plans.read">>;
type Guide = NonNullable<RequestOutput<"plans.recommend">>;

const QUIZ_KINDS = ["mcq", "completion", "matching", "tf", "open"] as const;
type QuizKind = (typeof QUIZ_KINDS)[number];
export const ACTIVITY_KINDS = [
  "lesson",
  "quiz",
  "cards",
  "practice",
  "map",
  "simulation",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
const KIND_ICONS: Record<ActivityKind, IconName> = {
  lesson: "book-open",
  quiz: "list-checks",
  cards: "layers",
  practice: "pencil-line",
  map: "network",
  simulation: "clock",
};
const DURATIONS = ["30", "60", "90", "120"] as const;
type Duration = (typeof DURATIONS)[number];
/** What a simulation is drawn from: new questions shaped like the past papers, the book's exam exercises or all of its
 * exercises, or the past papers' own questions (a quiz without a clock). */
type Material = "styled" | "exam" | "mixed" | "past";

/**
 * "Crea un'attività": one step. What to make (six kinds as small tiles), the topic, and the chosen kind's options in place
 * under them, with Annulla and Crea together at the bottom right. Opened from the exam page's Altro menu, on the topic the
 * path is on, and from a topic's "+" on the path, on that topic. It grows out of what opened it and gives the focus back
 * there. Crea opens a lesson, flashcards, exercises or a map at once, since their pages show their own work; a quiz and a
 * simulation being prepared go to `onMade`, which shows the work on the exam page and then opens it.
 */
export function ExamCreateDialog({
  planId,
  plan,
  guide,
  open,
  initialTopic,
  origin,
  onClose,
  onMade,
}: {
  planId: string;
  plan: Plan | undefined;
  guide: Guide | undefined;
  open: boolean;
  /** The topic the dialog opens on; the topic the path is on when not given. */
  initialTopic: string | undefined;
  /** What opened it: it grows out of this and the focus goes back there. */
  origin: () => HTMLElement | null;
  onClose: () => void;
  onMade: (made: MadeActivity) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const describeEngineError = useEngineError(navigate);
  const ids = useId();
  const form = useRef<HTMLFormElement>(null);
  const options = useRef<HTMLDivElement>(null);
  // What the dialog grows out of and gives the focus back to, asked each time it opens or closes.
  const originNow = useRef(origin);
  originNow.current = origin;
  const grownFrom = useMemo(
    () => ({
      get current() {
        return originNow.current();
      },
    }),
    [],
  );
  // The focus goes to the first control: the kind that is chosen.
  const firstControl = useMemo(
    () => ({
      get current() {
        return form.current?.querySelector<HTMLElement>('[role="radiogroup"] [aria-checked="true"]') ?? null;
      },
    }),
    [],
  );
  const papers = useQuery({
    ...pastPapersQuery(planId),
    enabled: Boolean(planId) && open,
  });
  const readyPapers =
    (papers.data?.papers ?? []).filter((paper) => paper.status === "ready")
      .length > 0;
  const topics = plan?.topics ?? [];
  const startTopic =
    initialTopic ?? guide?.next?.topicId ?? topics[0]?.id ?? "";

  const [kind, setKind] = useState<ActivityKind>("quiz");
  const [topicId, setTopicId] = useState(startTopic);
  const [quizKinds, setQuizKinds] = useState<QuizKind[]>([...QUIZ_KINDS]);
  const [count, setCount] = useState(8);
  const [duration, setDuration] = useState<Duration>("60");
  const [material, setMaterial] = useState<Material | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    text: string;
    action?: { label: string; onClick: () => void };
  } | null>(null);
  // Each opening of the dialog has a number, and a request acts only while its opening is still the current one: closing
  // the dialog, or leaving it for a page, moves the number on, so a reply that comes after cannot touch the next opening.
  const opening = useRef(0);
  useEffect(() => {
    opening.current += 1;
  }, [open]);
  const shownMaterial: Material =
    material ?? (readyPapers ? "styled" : "mixed");

  // Each opening starts again from a quiz on the topic it was opened for.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setKind("quiz");
      setTopicId(startTopic);
      setQuizKinds([...QUIZ_KINDS]);
      setCount(8);
      setDuration("60");
      setMaterial(null);
      setInstruction("");
      setError(null);
      setBusy(false);
    }
  }

  function close() {
    opening.current += 1;
    onClose();
  }
  /** Leaves for the page of what was made: the page changes under the dialog. */
  function leave(to: string, state?: unknown) {
    opening.current += 1;
    onClose();
    navigate(to, state ? { state } : undefined);
  }

  // The options of the kind grow or shrink in place from the height they had.
  const lastHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const box = options.current;
    if (!box) return;
    const before = lastHeight.current;
    const after = box.offsetHeight;
    lastHeight.current = after;
    if (
      before == null ||
      before === after ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    box.animate([{ height: `${before}px` }, { height: `${after}px` }], {
      duration: 200,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
    box.firstElementChild?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 180,
      delay: 40,
      easing: "ease-out",
      fill: "backwards",
    });
  }, [kind, shownMaterial]);
  useEffect(() => {
    if (!open) lastHeight.current = null;
  }, [open]);

  const topic = topics.find((item) => item.id === topicId);
  const noMaterial =
    kind !== "simulation" && topic != null && !topic.firstPassageId;
  const blocked =
    (kind === "practice" && noMaterial) || (kind !== "simulation" && !topic);

  function failed(err: unknown) {
    const code = String(
      (err as { code?: string; message?: string })?.code ??
        (err as Error)?.message ??
        err,
    );
    const key =
      err && typeof err === "object" && "messageKey" in err
        ? String((err as { messageKey: unknown }).messageKey)
        : code.includes("simulation-empty")
          ? "examPage.createDialog.simulationEmpty"
          : code.includes("past-empty")
            ? "examPage.createDialog.pastEmpty"
            : "planOverview.failed";
    setError(describeEngineError(key, errorProvider(err)));
  }

  async function create() {
    if (busy || blocked) return;
    const base = `/plans/${planId}`;
    if (kind === "lesson" || kind === "cards" || kind === "practice")
      return leave(`${base}/${kind}/${topicId}`);
    if (kind === "map")
      return leave(`${base}/map/${topicId}`, {
        build: true,
        instruction: instruction.trim(),
      });
    const mine = opening.current;
    setBusy(true);
    setError(null);
    try {
      if (kind === "quiz") {
        const started = await invoke("study.quizStart", {
          planId,
          topicId,
          count,
          types: quizKinds,
        });
        // The student closed the dialog while it was written: what was started stays in "Da finire".
        if (opening.current !== mine) return;
        onMade({
          kind: "quiz",
          planId,
          attemptId: started.attemptId,
          topicId,
          topicTitle: topic?.title ?? "",
        });
        close();
      } else if (shownMaterial === "past") {
        const started = await invoke("study.pastPracticeStart", { planId });
        if (opening.current !== mine) return;
        leave(`${base}/past?attempt=${encodeURIComponent(started.attemptId)}`);
      } else {
        const prepared = await invoke("study.simulationPrepare", {
          planId,
          minutes: Number(duration),
          source: shownMaterial === "exam" ? "exam" : "mixed",
          matchPast: shownMaterial === "styled",
        });
        if (opening.current !== mine) return;
        if (prepared.attemptId) leave(`${base}/exam/${prepared.attemptId}`);
        else if (prepared.jobId) {
          onMade({ kind: "simulation", planId, jobId: prepared.jobId });
          close();
        } else leave(`${base}/simulation`);
      }
    } catch (err) {
      if (opening.current === mine) failed(err);
    } finally {
      if (opening.current === mine) setBusy(false);
    }
  }

  const hours = (minutes: number) =>
    minutes < 60
      ? t("examPage.createDialog.minutesShort", { count: minutes })
      : minutes % 60
        ? t("examPage.createDialog.hoursHalf", {
            count: Math.floor(minutes / 60),
          })
        : t("examPage.createDialog.hours", { count: minutes / 60 });
  const label = (id: string) => `${ids}-${id}`;

  return (
    <Dialog
      open={open}
      width="md"
      className="px-acd"
      title={t("examPage.create")}
      origin={grownFrom}
      initialFocus={firstControl}
      onClose={close}
      // Closing it while the work runs is allowed: what was started stays in "Da finire".
      actions={[
        {
          label: busy ? t("examPage.createDialog.creating") : t("examPage.createDialog.create"),
          working: busy,
          disabled: blocked,
          onClick: () => void create(),
        },
      ]}
    >
      <form
        ref={form}
        className="px-acd-body"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
            <div className="px-acd-block">
              <span className="label" id={label("kind")}>
                {t("examPage.createDialog.what")}
              </span>
              <PreviewTiles
                variant="icons"
                label={label("kind")}
                value={kind}
                onChange={(next) => {
                  setKind(next);
                  setError(null);
                }}
                options={ACTIVITY_KINDS.map((value) => ({
                  value,
                  label: t(`examPage.createDialog.kinds.${value}`),
                  preview: <Icon name={KIND_ICONS[value]} size={20} />,
                }))}
              />
            </div>
            <div className="px-acd-block">
              <label className="label" htmlFor={label("topic")}>
                {t("planOverview.topic")}
              </label>
              {kind === "simulation" ? (
                // A simulation covers the whole exam: core has no simulation of one topic.
                <p className="px-acd-field is-static" id={label("topic")}>
                  {t("examPage.createDialog.wholeExam")}
                </p>
              ) : (
                <span className="px-acd-select">
                  <select
                    id={label("topic")}
                    className="px-acd-field"
                    value={topicId}
                    disabled={busy}
                    aria-describedby={
                      noMaterial ? label("nomaterial") : undefined
                    }
                    onChange={(event) => setTopicId(event.target.value)}
                  >
                    {topics.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevron-down" size={16} />
                </span>
              )}
              {noMaterial ? (
                <p className="small px-acd-note" id={label("nomaterial")}>
                  {t(
                    kind === "practice"
                      ? "examPage.createDialog.noMaterialPractice"
                      : "examPage.createDialog.noMaterial",
                  )}
                </p>
              ) : null}
            </div>
            <div className="px-acd-options" ref={options}>
              <div>
                {kind === "quiz" ? (
                  <>
                    <div className="px-acd-block">
                      <span className="label" id={label("types")}>
                        {t("examPage.createDialog.questions")}
                      </span>
                      <ToggleChips
                        label={label("types")}
                        value={quizKinds}
                        disabled={busy}
                        keepHint={t("examPage.createDialog.keepOne")}
                        onChange={setQuizKinds}
                        options={QUIZ_KINDS.map((value) => ({
                          value,
                          label: t(`quiz.kinds.${value}`),
                        }))}
                      />
                    </div>
                    <div className="px-acd-numrow">
                      <span id={label("count")}>
                        <b>{t("examPage.createDialog.count")}</b>
                        <span className="small">
                          {t("examPage.createDialog.countHint", {
                            max: QUIZ_MAX_QUESTIONS,
                          })}
                        </span>
                      </span>
                      <Stepper
                        label={label("count")}
                        value={count}
                        min={1}
                        max={QUIZ_MAX_QUESTIONS}
                        disabled={busy}
                        decreaseLabel={t("examPage.createDialog.fewer")}
                        increaseLabel={t("examPage.createDialog.more")}
                        onChange={setCount}
                      />
                    </div>
                  </>
                ) : kind === "simulation" ? (
                  <>
                    <div className="px-acd-block">
                      <span className="label" id={label("duration")}>
                        {t("examPage.createDialog.duration")}
                      </span>
                      <Segmented
                        label={label("duration")}
                        value={duration}
                        // The past papers' own questions have no clock: the length stays in sight, not in use.
                        disabled={busy || shownMaterial === "past"}
                        onChange={setDuration}
                        options={DURATIONS.map((value) => ({
                          value,
                          label: hours(Number(value)),
                        }))}
                      />
                    </div>
                    <div className="px-acd-block">
                      <span className="label" id={label("material")}>
                        {t("examPage.createDialog.material")}
                      </span>
                      <RadioRows
                        label={label("material")}
                        value={shownMaterial}
                        onChange={(next) => setMaterial(next)}
                        options={[
                          ...(readyPapers
                            ? [
                                {
                                  value: "styled" as const,
                                  title: t("simulation.formatPast"),
                                  description: t(
                                    "examPage.createDialog.materialStyled",
                                  ),
                                },
                              ]
                            : []),
                          {
                            value: "exam" as const,
                            title: t("simulation.exam"),
                            description: t(
                              "examPage.createDialog.materialExam",
                            ),
                          },
                          {
                            value: "mixed" as const,
                            title: t("simulation.mixed"),
                            description: t(
                              "examPage.createDialog.materialMixed",
                            ),
                          },
                          ...(readyPapers
                            ? [
                                {
                                  value: "past" as const,
                                  title: t("pastPapers.practiceTitle"),
                                  description: t(
                                    "examPage.createDialog.materialPast",
                                  ),
                                },
                              ]
                            : []),
                        ]}
                      />
                    </div>
                  </>
                ) : kind === "map" ? (
                  <div className="px-acd-block">
                    <label className="label" htmlFor={label("how")}>
                      {t("maps.instruction")}{" "}
                      <span className="px-acd-optional">
                        {t("maps.optional")}
                      </span>
                    </label>
                    <input
                      id={label("how")}
                      className="px-acd-field"
                      value={instruction}
                      maxLength={MAP_INSTRUCTION_MAX}
                      placeholder={t("examPage.createDialog.mapPlaceholder")}
                      onChange={(event) => setInstruction(event.target.value)}
                    />
                  </div>
                ) : (
                  <p className="small px-acd-lead">
                    {t(`examPage.createDialog.about.${kind}`)}
                  </p>
                )}
              </div>
            </div>
            {error ? (
              <div className="px-acd-error">
                <Notice tone="danger" action={error.action}>
                  {error.text}
                </Notice>
              </div>
            ) : null}
        <p className="visually-hidden" role="status">
          {busy ? t("examPage.createDialog.creating") : ""}
        </p>
      </form>
    </Dialog>
  );
}
