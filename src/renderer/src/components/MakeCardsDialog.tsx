import { useQueryClient } from "@tanstack/react-query";
import { App, Select } from "antd";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import { errorProvider, useEngineError } from "../lib/engineError";
import { invoke } from "../lib/ipc";
import { Dialog, type DialogAction } from "./Dialog";
import { Notice } from "./Notice";
import { ProposedCards, type ProposedRow } from "./ProposedCards";
import "./MakeCardsDialog.css";
import { Working } from "./Working";

// The dialog mounts with the window, so KaTeX loads the first time it opens rather than at startup.
const MathText = lazy(() =>
  import("./math/MathText").then((module) => ({ default: module.MathText })),
);

/** The text to make flashcards from, and what is known about where they belong. */
export type CardSource = {
  text: string;
  origin: "reply" | "selection" | "map";
  /** The lesson's plan and topic, or the chat's plan. */
  planId?: string;
  topicId?: string;
  /** The chat's subject name. */
  subject?: string;
  /** A map's subject: the cards go under it, and only its exams are offered. */
  subjectId?: string;
  /** Passages the text cites or comes from; they pick the topic and become the cards' source links. */
  passageIds?: string[];
};

const eventName = "pyxis:make-cards";
export function openMakeCards(source: CardSource): void {
  window.dispatchEvent(new CustomEvent(eventName, { detail: source }));
}

type Places = RequestOutput<"study.cardsPlaces">;
type Proposal = RequestOutput<"study.cardsPropose">;
type Row = ProposedRow;

/** The key of an engine error the student can act on; the generic one gets this dialog's own sentence. */
function failureKey(err: unknown): string {
  const key =
    err && typeof err === "object" && "messageKey" in err
      ? String((err as { messageKey: unknown }).messageKey)
      : "";
  return !key || key === "errors.internal" ? "makeCards.failed" : key;
}

export function MakeCardsDialog() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const describeEngineError = useEngineError();
  const client = useQueryClient();
  const [source, setSource] = useState<CardSource | null>(null);
  // The source stays while the dialog shrinks away, when `source` is already null.
  const lastSource = useRef(source);
  if (source) lastSource.current = source;
  const shown = lastSource.current;
  const [places, setPlaces] = useState<Places | null>(null);
  // The cards belong to a subject; an exam and one of its topics are optional.
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [step, setStep] = useState<"pick" | "working" | "review">("pick");
  const [rows, setRows] = useState<Row[]>([]);
  const [made, setMade] = useState<Pick<Proposal, "provider" | "model"> | null>(
    null,
  );
  // The engine a failed call ran on, so a refused sign-in can name it and offer its sign-in.
  const [error, setError] = useState<{
    key: string;
    save: boolean;
    provider?: string;
  } | null>(null);
  const failure = error
    ? describeEngineError(error.key, error.provider)
    : undefined;
  const [saving, setSaving] = useState(false);
  const cancel = useRef<(() => void) | null>(null);
  const run = useRef(0);

  function stop() {
    run.current += 1;
    cancel.current?.();
    cancel.current = null;
  }
  function close() {
    stop();
    setSource(null);
  }

  useEffect(() => {
    const open = (event: Event) => {
      stop();
      const next = (event as CustomEvent<CardSource>).detail;
      setSource(next);
      setPlaces(null);
      setSubjectId(null);
      setPlanId(null);
      setTopicId(null);
      setRows([]);
      setStep("pick");
      setError(null);
      setSaving(false);
      const id = run.current;
      invoke("study.cardsPlaces", {
        planId: next.planId,
        topicId: next.topicId,
        subject: next.subject,
        subjectId: next.subjectId,
        passageIds: next.passageIds,
      }).then(
        (found) => {
          if (id !== run.current) return;
          setPlaces(found);
          setSubjectId(found.subjectId);
          setPlanId(found.planId);
          setTopicId(found.topicId);
        },
        () => {
          if (id === run.current)
            setError({ key: "makeCards.failed", save: false });
        },
      );
    };
    window.addEventListener(eventName, open);
    return () => {
      window.removeEventListener(eventName, open);
      stop();
    };
  }, []);

  const plan = places?.plans.find((item) => item.id === planId);
  const topic = plan?.topics.find((item) => item.id === topicId);
  const subject = places?.subjects.find((item) => item.id === subjectId);
  // A map's subject is fixed; elsewhere the student picks it. Without one, every exam is offered.
  const subjectFixed = Boolean(shown?.subjectId);
  const exams = (places?.plans ?? []).filter((item) => !subjectId || item.subjectId === subjectId);
  // Somewhere to file the cards: an exam's topic, or the subject alone.
  const placed = planId ? Boolean(topicId) : Boolean(subjectId);
  const nowhere = places !== null && places.subjects.length === 0 && places.plans.length === 0;

  async function make() {
    if (!source || !placed) return;
    stop();
    const id = run.current;
    setError(null);
    setStep("working");
    const handle = window.pyxis.stream(
      "study.cardsPropose",
      {
        planId: planId ?? undefined,
        topicId: planId ? (topicId ?? undefined) : undefined,
        text: source.text,
        passageIds: source.passageIds ?? [],
      },
      () => {},
    );
    cancel.current = handle.cancel;
    try {
      const result = (await handle.result) as Proposal;
      if (id !== run.current) return;
      setMade({ provider: result.provider, model: result.model });
      setRows(result.cards.map((card, key) => ({ key, ...card })));
      setStep("review");
    } catch (err) {
      if (id !== run.current) return;
      setError({ key: failureKey(err), save: false, provider: errorProvider(err) });
      setStep("pick");
    } finally {
      if (cancel.current === handle.cancel) cancel.current = null;
    }
  }

  const update = (key: number, patch: Partial<Row>) =>
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  const incomplete = rows.some((row) => !row.front.trim() || !row.back.trim());

  async function save() {
    if (!placed || !made || !rows.length || incomplete || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await invoke("study.cardsSaveProposed", {
        ...(planId ? { planId, topicId: topicId ?? undefined } : { subjectId: subjectId ?? undefined }),
        cards: rows.map(({ front, back, passageId }) => ({
          front,
          back,
          passageId,
        })),
        ...made,
      });
      // The browser and the daily review list cards from everywhere; the other lists belong to this plan alone.
      await Promise.all([
        client.invalidateQueries({ queryKey: ["card-browse"] }),
        client.invalidateQueries({ queryKey: ["cards-everywhere"] }),
        client.invalidateQueries({ queryKey: ["subject-cards"] }),
        client.invalidateQueries({ queryKey: ["plans", "today"] }),
        ...(planId
          ? ["cards", "card-queue", "review-session", "plan"].map((key) =>
              client.invalidateQueries({ queryKey: [key, planId] }),
            )
          : []),
      ]);
      const saved = t("makeCards.saved", {
        count: result.saved,
        topic: (planId ? topic?.title : subject?.name) ?? "",
      });
      void message.success(
        result.skipped
          ? `${saved} ${t("makeCards.skipped", { count: result.skipped })}`
          : saved,
      );
      close();
    } catch {
      setError({ key: "makeCards.saveFailed", save: true });
      setSaving(false);
    }
  }

  const working = step === "working";
  const actions: DialogAction[] =
    step === "review"
      ? [
          {
            label: t("makeCards.again"),
            tone: "secondary",
            side: "start",
            focusKey: "mc-again",
            disabled: saving || !placed,
            onClick: () => void make(),
          },
          {
            label: t("makeCards.save", { count: rows.length }),
            working: saving,
            disabled: !rows.length || incomplete || !placed,
            onClick: () => void save(),
          },
        ]
      : [{ label: t("makeCards.make"), working, disabled: !placed, onClick: () => void make() }];

  return (
    <Dialog
      open={source !== null}
      width="lg"
      title={t("makeCards.title")}
      busy={saving}
      // A stray click would stop the answer being written.
      outside={working ? "none" : "auto"}
      onClose={close}
      actions={actions}
    >
      {shown ? (
        <div className="px-mc-body">
          <figure className="px-mc-source">
            <figcaption className="label">
              {t(
                shown.origin === "reply"
                  ? "makeCards.fromReply"
                  : shown.origin === "map"
                    ? "makeCards.fromMap"
                    : "makeCards.fromSelection",
              )}
            </figcaption>
            <p>
              <Suspense fallback={shown.text}>
                <MathText text={shown.text} />
              </Suspense>
            </p>
          </figure>
          {subjectFixed ? (
            <p className="body px-mc-lead">
              <Trans
                i18nKey={exams.length ? "makeCards.goesTo" : "makeCards.goesToNoExam"}
                values={{ subject: subject?.name ?? shown.subject ?? "" }}
                components={{ b: <b /> }}
              />
            </p>
          ) : null}
          <div className="px-mc-where">
            {subjectFixed ? null : (
              <div className="px-mc-field">
                <label className="label" htmlFor="mc-subject">
                  {t("makeCards.subject")}
                </label>
                <Select
                  id="mc-subject"
                  showSearch={{ optionFilterProp: "label" }}
                  loading={places === null && !error}
                  disabled={working || saving || nowhere}
                  value={subjectId}
                  placeholder={t("makeCards.subjectPlaceholder")}
                  options={places?.subjects.map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                  onChange={(value: string) => {
                    setSubjectId(value);
                    // An exam of another subject cannot hold them any more.
                    if (plan && plan.subjectId !== value) {
                      setPlanId(null);
                      setTopicId(null);
                    }
                  }}
                />
              </div>
            )}
            {exams.length ? (
              <div className="px-mc-field">
                <label className="label" htmlFor="mc-plan">
                  {t("makeCards.plan")}{" "}
                  <span className="px-mc-optional">{t("makeCards.optional")}</span>
                </label>
                <Select
                  id="mc-plan"
                  showSearch={{ optionFilterProp: "label" }}
                  disabled={working || saving}
                  value={planId ?? ""}
                  options={[
                    { value: "", label: t("makeCards.noExam") },
                    ...exams.map((item) => ({ value: item.id, label: item.title })),
                  ]}
                  onChange={(value: string) => {
                    const next = places?.plans.find((item) => item.id === value);
                    setPlanId(next?.id ?? null);
                    setTopicId(null);
                    if (next?.subjectId) setSubjectId(next.subjectId);
                  }}
                />
              </div>
            ) : null}
            {plan ? (
              <div className="px-mc-field">
                <label className="label" htmlFor="mc-topic">
                  {t("makeCards.topic")}
                </label>
                <Select
                  id="mc-topic"
                  showSearch={{ optionFilterProp: "label" }}
                  disabled={working || saving}
                  value={topicId}
                  placeholder={t("makeCards.topicPlaceholder")}
                  options={plan.topics.map((item) => ({
                    value: item.id,
                    label: item.title,
                  }))}
                  onChange={setTopicId}
                />
              </div>
            ) : null}
          </div>
          {exams.length ? <p className="small px-mc-hint">{t("makeCards.examHint")}</p> : null}
          {nowhere ? <Notice tone="info">{t("makeCards.noSubjects")}</Notice> : null}
          {error ? (
            <Notice
              tone="danger"
              action={
                failure?.action
                  ? {
                      label: failure.action.label,
                      onClick: () => {
                        close();
                        failure.action!.onClick();
                      },
                    }
                  : undefined
              }
            >
              {failure?.action
                ? failure.text
                : t(error.key, { defaultValue: t("makeCards.failed") })}
            </Notice>
          ) : null}
          {step === "pick" && !nowhere && !error ? (
            <p className="small px-mc-hint">{t("makeCards.hint")}</p>
          ) : null}
          {working ? (
            <Working slot className="px-mc-working" line={t("makeCards.working")} />
          ) : null}
          {step === "review" ? (
            <>
              <ProposedCards
                rows={rows}
                idPrefix="mc"
                disabled={saving}
                onChange={update}
                onDrop={(key) => setRows((current) => current.filter((item) => item.key !== key))}
                // With no card left, "Make again" is the way on, and it is enabled; the focus goes there.
                onEmptied={() => document.querySelector<HTMLElement>('[data-focus-key="mc-again"]')?.focus()}
              />
              {rows.length ? null : <p className="small px-mc-hint">{t("makeCards.allDropped")}</p>}
            </>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
