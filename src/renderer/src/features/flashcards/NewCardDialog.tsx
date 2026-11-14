import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { NEW_CARDS } from "@shared/limits";
import type { RequestOutput } from "@shared/ipc";
import { Button } from "../../components/Button";
import { Dialog, useConfirm, type DialogAction } from "../../components/Dialog";
import { Segmented, Stepper } from "../../components/Controls";
import { Icon } from "../../components/Icon";
import { Logo } from "../../components/Logo";
import { FormulaPreview } from "../../components/FormulaPreview";
import { Notice } from "../../components/Notice";
import { ProposedCards, type ProposedRow } from "../../components/ProposedCards";
import { errorProvider, useEngineError } from "../../lib/engineError";
import { invoke } from "../../lib/ipc";
import { saveProposedInput, whatWouldBeLost, type Loss, type ProposalTarget } from "./newCardLogic";
import "./NewCardDialog.css";

/** Who writes the new flashcards: the student ("Scrivila tu") or Pyxis ("Falla fare a Pyxis"). */
export type NewCardSide = "hand" | "pyxis";

type Places = RequestOutput<"study.newCardPlaces">;
type Subject = Places["subjects"][number];
type Proposal = RequestOutput<"study.cardsForSubject">;

/** The value of the "Nuova materia…" option, which no subject id can be. */
const NEW_SUBJECT = "\u0000new";
/** A topic option's value: its exam and its id. The empty value is the whole subject. */
const topicValue = (planId: string, topicId: string) => `${planId}\u0000${topicId}`;

export const newCardsQuery = { queryKey: ["new-card-places"], queryFn: () => invoke("study.newCardPlaces", {}) };

/** Everything a new card changes: the Flashcard page, the daily review and the decks it can be studied in. */
async function refreshCards(client: QueryClient, planId?: string | null) {
  await Promise.all([
    ...[
      ["card-sections"],
      ["card-browse"],
      ["cards-everywhere"],
      ["subject-cards"],
      ["plans", "today"],
      ["plans", "rings"],
      ["plans", "examlessDue"],
      ["new-card-places"],
    ].map((queryKey) => client.invalidateQueries({ queryKey })),
    ...(planId
      ? ["cards", "card-queue", "review-session", "plan"].map((key) =>
          client.invalidateQueries({ queryKey: [key, planId] }),
        )
      : []),
  ]);
}

/**
 * "Nuova flashcard": one dialog with a switch between writing a card by
 * hand and having Pyxis write some from the subject's material. It grows out of the button that opened it and shrinks
 * back into it; Escape, the backdrop and Annulla ask first when something would be lost. `onSaved` tells the page which
 * subject got how many cards, so it can show them.
 */
export function NewCardDialog({
  open,
  side: openSide,
  subjectId: openSubject,
  origin,
  onClose,
  onClosed,
  onSaved,
}: {
  open: boolean;
  side: NewCardSide;
  /** The subject chosen when it opens, as another page asks for. */
  subjectId?: string;
  /** The button it grows out of; focus goes back to it on close. */
  origin: () => HTMLElement | null;
  onClose: () => void;
  /** Called once it has shrunk away and given the focus back: a page whose button went with the dialog places it then. */
  onClosed?: () => void;
  onSaved: (saved: { subjectId: string; name: string; count: number; closing: boolean }) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const describeEngineError = useEngineError(navigate);
  // Everything inside the dialog: where its fields are looked for.
  const card = useRef<HTMLDivElement>(null);
  // What it grows out of and gives the focus back to, asked each time it opens or closes.
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
  const switchId = useId();
  const places = useQuery({ ...newCardsQuery, enabled: open });
  const subjects = places.data?.subjects ?? [];

  const [side, setSide] = useState<NewCardSide>(openSide);
  const [subjectId, setSubjectId] = useState("");
  const confirm = useConfirm();
  // The question asked before something is lost, while it is open: what would be lost decides the words.
  const asking = useRef<{ loss: Loss; taken: AbortController } | null>(null);

  // Scrivila tu
  const [planId, setPlanId] = useState("");
  const [newName, setNewName] = useState("");
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [errors, setErrors] = useState<{ name?: string; front?: string; back?: string }>({});
  const [handFailed, setHandFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [added, setAdded] = useState(0);
  const [announce, setAnnounce] = useState("");

  // Falla fare a Pyxis
  const [topic, setTopic] = useState("");
  const [focusText, setFocusText] = useState("");
  const [count, setCount] = useState<number>(NEW_CARDS.start);
  const [step, setStep] = useState<"form" | "working" | "review">("form");
  const [rows, setRows] = useState<ProposedRow[]>([]);
  // What Pyxis was asked and wrote, fixed when the proposals arrive: the fields on the form can change after that, and
  // the proposals still belong to the request that wrote them.
  const [made, setMade] = useState<
    | (Pick<Proposal, "provider" | "model" | "repeats"> & {
        asked: number;
        /** How many cards Pyxis wrote, the repeats included; dropping a proposal does not change it. */
        wrote: number;
        target: ProposalTarget;
        /** The subject's name, or the topic's, and the focus, as the request had them. */
        place: string;
        subjectName: string;
        focus: string;
      })
    | null
  >(null);
  const [failure, setFailure] = useState<{ key: string; provider?: string } | null>(null);
  const [savingProposed, setSavingProposed] = useState(false);
  const cancel = useRef<(() => void) | null>(null);
  const run = useRef(0);
  // Counts the times the dialog has been opened. A reply that comes back from an earlier opening is not this one's.
  const opening = useRef(0);

  const subject = subjects.find((item) => item.id === subjectId);
  const isNew = subjectId === NEW_SUBJECT;
  const [topicPlan, topicId] = topic ? topic.split("\u0000") : ["", ""];
  const topicTitle = subject?.topics.find((group) => group.planId === topicPlan)?.topics.find((item) => item.id === topicId)
    ?.title;

  function stopWork() {
    run.current += 1;
    cancel.current?.();
    cancel.current = null;
  }

  // Everything starts again each time it opens, on the side and the subject it was asked for.
  useEffect(() => {
    if (!open) return;
    opening.current += 1;
    setSide(openSide);
    setSubjectId(openSubject ?? "");
    setPlanId("");
    setNewName("");
    setFront("");
    setBack("");
    setErrors({});
    setHandFailed(false);
    setSaving(false);
    busy.current = false;
    setAdded(0);
    setAnnounce("");
    setTopic("");
    setFocusText("");
    setCount(NEW_CARDS.start);
    setStep("form");
    setRows([]);
    setMade(null);
    setFailure(null);
    setSavingProposed(false);
    takeBack();
  }, [open]);

  // Once the subjects are known: the one asked for if it exists, else the first, else a new one to name.
  useEffect(() => {
    if (!open || !places.data) return;
    setSubjectId((current) => {
      if (current === NEW_SUBJECT && side === "hand") return current;
      if (current && places.data.subjects.some((item) => item.id === current)) return current;
      const first = places.data.subjects[0]?.id;
      return first ?? (side === "hand" ? NEW_SUBJECT : "");
    });
  }, [open, places.data, side]);

  useEffect(
    () => () => {
      stopWork();
      takeBack();
    },
    [],
  );

  // The first field of the side on show takes the focus once its choices are there.
  const focused = useRef(false);
  useEffect(() => {
    if (!open) {
      focused.current = false;
      return;
    }
    if (focused.current || !places.data || !subjectId) return;
    focused.current = true;
    requestAnimationFrame(() => {
      // A student who went to a field and started typing before the subjects arrived keeps it: the rest of what they
      // type must not land in another field.
      const active = document.activeElement;
      if (active instanceof HTMLElement && card.current?.contains(active) && active.matches("input, textarea, select"))
        return;
      firstField()?.focus();
    });
  }, [open, places.data, subjectId]);

  function firstField(): HTMLElement | null {
    const pane = card.current?.querySelector(`[data-pane="${side}"]`);
    if (!pane) return null;
    if (side === "hand" && subjectId === NEW_SUBJECT && subjects.length === 0)
      return pane.querySelector<HTMLElement>("#nc-new-name");
    return pane.querySelector<HTMLElement>("select, textarea, input");
  }

  /** Closes for good: the dialog shrinks back into the button, which gets the focus again. */
  function close() {
    stopWork();
    takeBack();
    onClose();
  }

  /**
   * Escape, the backdrop or Annulla: asks first when Pyxis's work, its proposals or typed text would be lost, whichever side
   * is showing. While a card is being saved the dialog stays: closing then would leave the student unsure what was saved.
   */
  function askClose() {
    if (busy.current || asking.current) return;
    const loss = whatWouldBeLost({
      step,
      proposals: rows.length,
      front,
      back,
      newName,
      naming: isNew,
      focus: focusText,
    });
    if (!loss) return close();
    const active = document.activeElement;
    asked.current = active instanceof HTMLElement && card.current?.contains(active) ? active : firstField();
    void ask(loss);
  }

  /**
   * The question in the one dialog over this one. Its safe answer has the focus; staying gives the focus back to where it
   * was, and the answer that throws work away closes this dialog too.
   */
  const asked = useRef<HTMLElement | null>(null);
  async function ask(loss: Loss) {
    const taken = new AbortController();
    asking.current = { loss, taken };
    const words =
      loss === "working"
        ? {
            title: t("flashcards.new.leave.stopTitle"),
            cancel: t("flashcards.new.leave.wait"),
            confirm: t("flashcards.new.leave.stop"),
          }
        : { title: t("leave.title"), cancel: t("leave.stay"), confirm: t("leave.go") };
    const answer = await confirm({
      ...words,
      body: t(`flashcards.new.leave.${loss}`),
      tone: "danger",
      origin: asked.current,
      returnFocus: asked.current,
      signal: taken.signal,
    });
    if (asking.current?.taken !== taken) return;
    asking.current = null;
    if (answer === "confirm") close();
  }

  /** The question goes away unanswered: the dialog closed, or what it asked about is over. */
  function takeBack() {
    const open = asking.current;
    asking.current = null;
    open?.taken.abort();
  }

  // Pyxis may finish while the student is asked about stopping it: the question becomes the one about its proposals.
  useEffect(() => {
    if (asking.current?.loss !== "working" || step === "working") return;
    takeBack();
    if (step === "review" && rows.length) void ask("review");
  }, [step]);

  function switchSide(next: NewCardSide) {
    setSide(next);
    // Pyxis writes for a subject that exists, so a new one being named gives way to the first subject.
    if (next === "pyxis" && subjectId === NEW_SUBJECT) setSubjectId(subjects[0]?.id ?? "");
    if (next === "hand" && !subjectId) setSubjectId(subjects[0]?.id ?? NEW_SUBJECT);
    const pane = card.current?.querySelector(`[data-pane="${next}"]`);
    if (pane && !window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      pane.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "ease-out" });
  }

  function chooseSubject(value: string) {
    setSubjectId(value);
    setPlanId("");
    setTopic("");
    setErrors((current) => ({ ...current, name: undefined }));
    setFailure(null);
  }

  // ---------- Scrivila tu ----------

  async function saveByHand(more: boolean) {
    if (busy.current) return;
    const name = newName.trim();
    const found = {
      name: isNew && !name ? t("flashcards.new.newSubjectEmpty") : undefined,
      front: front.trim() ? undefined : t("flashcards.new.frontEmpty"),
      back: back.trim() ? undefined : t("flashcards.new.backEmpty"),
    };
    setErrors(found);
    setHandFailed(false);
    const wrong = (["name", "front", "back"] as const).find((key) => found[key]);
    if (wrong) {
      document.getElementById(wrong === "name" ? "nc-new-name" : `nc-${wrong}`)?.focus();
      return;
    }
    busy.current = true;
    setSaving(true);
    const mine = opening.current;
    let shutting = false;
    try {
      let target = subjectId;
      let targetName = subject?.name ?? name;
      if (isNew) {
        const made = await invoke("subjects.add", { name });
        target = made.id;
        targetName = made.name;
        void client.invalidateQueries({ queryKey: ["subjects"] });
        await client.invalidateQueries({ queryKey: ["new-card-places"] });
        if (mine === opening.current) {
          setSubjectId(made.id);
          setNewName("");
        }
      }
      await invoke("study.cardCreate", { subjectId: target, planId: planId || null, front, back });
      await refreshCards(client, planId);
      // The card is saved: the page hears of it even when the dialog is not this save's any more.
      onSaved({ subjectId: target, name: targetName, count: 1, closing: !more });
      if (mine !== opening.current) return;
      if (!more) {
        // The dialog stays locked until it is gone: Salva is not enabled again for a second click during the closing.
        shutting = true;
        return close();
      }
      setFront("");
      setBack("");
      setAdded((n) => n + 1);
      setAnnounce(t("flashcards.new.addedTo", { subject: targetName }));
      refocus.current = true;
    } catch {
      if (mine === opening.current) setHandFailed(true);
    } finally {
      if (mine === opening.current && !shutting) {
        busy.current = false;
        setSaving(false);
      }
    }
  }

  // The faces are enabled again once the save is over: then Fronte takes the focus for the next card.
  const refocus = useRef(false);
  useEffect(() => {
    if (saving || !refocus.current) return;
    refocus.current = false;
    document.getElementById("nc-front")?.focus();
  }, [saving]);

  // "Aggiunta" stays on the button for a moment, then its label comes back.
  useEffect(() => {
    if (!added) return;
    const timer = window.setTimeout(() => setAdded(0), 1800);
    return () => window.clearTimeout(timer);
  }, [added]);

  // ---------- Falla fare a Pyxis ----------

  const engine = places.data?.engine ?? true;
  const noMaterial = Boolean(subject) && subject!.sources === 0;
  const canMake = Boolean(subject) && engine && !noMaterial && step !== "working";

  async function make() {
    if (!subject || !canMake) return;
    stopWork();
    const id = run.current;
    setFailure(null);
    setStep("working");
    setRows([]);
    const asked = count;
    // The request as it is now: the proposals that come back are kept with it.
    const request = {
      target: {
        subjectId: subject.id,
        ...(topicId ? { planId: topicPlan, topicId } : {}),
      },
      place: topicTitle ?? subject.name,
      subjectName: subject.name,
      focus: focusText.trim(),
    };
    const handle = window.pyxis.stream(
      "study.cardsForSubject",
      {
        subjectId: subject.id,
        ...(topicId ? { planId: topicPlan, topicId } : {}),
        ...(request.focus ? { focus: request.focus } : {}),
        count: asked,
      },
      () => {},
    );
    cancel.current = handle.cancel;
    try {
      const result = (await handle.result) as Proposal;
      if (id !== run.current) return;
      setMade({
        provider: result.provider,
        model: result.model,
        repeats: result.repeats,
        asked,
        wrote: result.cards.length + result.repeats,
        ...request,
      });
      setRows(result.cards.map((card, key) => ({ key, ...card })));
      setStep("review");
    } catch (err) {
      if (id !== run.current) return;
      const key =
        err && typeof err === "object" && "messageKey" in err ? String((err as { messageKey: unknown }).messageKey) : "";
      setFailure({ key: !key || key === "errors.internal" ? "flashcards.new.failed" : key, provider: errorProvider(err) });
      setStep("form");
    } finally {
      if (cancel.current === handle.cancel) cancel.current = null;
    }
  }

  const incomplete = rows.some((row) => !row.front.trim() || !row.back.trim());

  async function saveProposed() {
    if (!made || !rows.length || incomplete || busy.current) return;
    busy.current = true;
    setSavingProposed(true);
    setFailure(null);
    const mine = opening.current;
    let shutting = false;
    try {
      const result = await invoke("study.cardsSaveProposed", saveProposedInput(made, rows));
      await refreshCards(client, made.target.topicId ? made.target.planId : null);
      onSaved({ subjectId: made.target.subjectId, name: made.subjectName, count: result.saved, closing: true });
      if (mine !== opening.current) return;
      shutting = true;
      close();
    } catch {
      if (mine === opening.current) setFailure({ key: "flashcards.new.saveProposedFailed" });
    } finally {
      if (mine === opening.current && !shutting) {
        busy.current = false;
        setSavingProposed(false);
      }
    }
  }

  const failureView = failure ? describeEngineError(failure.key, failure.provider) : null;
  const retry = { label: t("flashcards.new.retry"), onClick: () => void (step === "review" ? saveProposed() : make()) };

  // ---------- Layout ----------

  const working = side === "pyxis" && step === "working";
  const reviewing = side === "pyxis" && step === "review";
  const askedLabel = t("flashcards.new.asked", { count });

  // Annulla is the dialog's own and asks first when something would be lost. The extra action sits on the left.
  let actions: DialogAction[];
  if (side === "hand")
    actions = [
      {
        label: (
          <span className="px-nc-swap">
            <span data-off={added ? "" : undefined}>{t("flashcards.new.saveMore")}</span>
            <span data-off={added ? undefined : ""}>
              <Icon name="check" size={16} />
              {t("flashcards.new.added")}
            </span>
          </span>
        ),
        tone: "secondary",
        disabled: !places.data,
        onClick: () => void saveByHand(true),
      },
      { label: t("flashcards.new.save"), disabled: !places.data, onClick: () => void saveByHand(false) },
    ];
  else
    actions = [
      ...(reviewing
        ? [
            {
              label: t("flashcards.new.again"),
              tone: "secondary" as const,
              side: "start" as const,
              onClick: () => void make(),
            },
          ]
        : []),
      working
        ? { label: t("flashcards.new.making"), working: true, disabled: true, onClick: () => undefined }
        : reviewing
          ? {
              label: t("flashcards.new.saveProposed", { count: rows.length }),
              disabled: !rows.length || incomplete,
              onClick: () => void saveProposed(),
            }
          : { label: t("flashcards.new.make"), disabled: !canMake, onClick: () => void make() },
    ];

  // Where the focus goes as it opens: the first field of the side on show when the subjects are there, else the dialog
  // itself, and the effect above places it once they arrive, unless the student has already gone to a field.
  const firstControl = useMemo(
    () => ({
      get current() {
        return (places.data && subjectId ? firstField() : null) ?? card.current?.closest("dialog") ?? null;
      },
    }),
    [places.data, subjectId, side],
  );

  return (
    <Dialog
      open={open}
      width={reviewing ? "lg" : "md"}
      className="px-nc"
      title={t("flashcards.new.title")}
      // A click outside asks like Annulla does, even with text typed: the leave question is how it is answered.
      outside="close"
      // Enter in its one-line fields (the new subject's name, the number of flashcards) never saves or writes: the
      // buttons do, so a card is not saved or written by accident.
      enterConfirms={false}
      // While a card is being saved the dialog stays.
      busy={saving || savingProposed}
      origin={grownFrom}
      initialFocus={firstControl}
      onClose={askClose}
      onClosed={onClosed}
      actions={actions}
    >
      <div ref={card} className="px-nc-card">
        {reviewing ? null : working ? (
          // What Pyxis was asked, while it works; its proposals then say it in their own line.
          <p className="small px-nc-summary">
            <b>{[subject?.name, topicTitle].filter(Boolean).join(" · ")}</b>
            {focusText.trim() ? ` · «${focusText.trim()}»` : ""} · {askedLabel}
          </p>
        ) : (
          <>
            <span className="visually-hidden" id={switchId}>
              {t("flashcards.new.how")}
            </span>
            <div className="px-nc-switch">
              <Segmented<NewCardSide>
                label={switchId}
                value={side}
                options={[
                  { value: "hand", label: t("flashcards.new.byHand") },
                  { value: "pyxis", label: t("flashcards.new.byPyxis") },
                ]}
                onChange={switchSide}
              />
            </div>
          </>
        )}

          <div className="px-nc-body">
            {places.isError && !places.data ? (
              <Notice tone="danger" action={{ label: t("flashcards.new.retry"), onClick: () => void places.refetch() }}>
                {t("flashcards.loadFailed")}
              </Notice>
            ) : null}

            <div data-pane="hand" hidden={side !== "hand"} className="px-nc-pane">
              <SubjectField
                id="nc-subject"
                subjects={subjects}
                value={subjectId}
                allowNew
                disabled={saving || !places.data}
                onChange={chooseSubject}
              />
              <Fold shut={!isNew}>
                <div className="px-nc-sub">
                  <input
                    id="nc-new-name"
                    className="px-nc-field"
                    aria-label={t("flashcards.new.newSubjectName")}
                    placeholder={t("flashcards.new.newSubjectPlaceholder")}
                    maxLength={120}
                    value={newName}
                    disabled={saving}
                    aria-invalid={errors.name ? true : undefined}
                    aria-describedby={errors.name ? "nc-new-name-error" : undefined}
                    onChange={(event) => {
                      setNewName(event.target.value);
                      setErrors((current) => ({ ...current, name: undefined }));
                    }}
                    // Enter in this one-line field never saves the card by accident.
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.preventDefault();
                    }}
                  />
                  <FieldError id="nc-new-name-error" text={errors.name} />
                </div>
              </Fold>
              <Fold shut={!subject || subject.exams.length === 0}>
                <div className="px-nc-block">
                  <label className="label" htmlFor="nc-exam">
                    {t("flashcards.new.exam")} <span className="px-nc-optional">{t("flashcards.new.optional")}</span>
                  </label>
                  <Select id="nc-exam" value={planId} disabled={saving} onChange={setPlanId}>
                    <option value="">{t("flashcards.new.noExam")}</option>
                    {subject?.exams.map((exam) => (
                      <option key={exam.id} value={exam.id}>
                        {exam.title}
                      </option>
                    ))}
                  </Select>
                </div>
              </Fold>
              <FaceField
                face="front"
                value={front}
                error={errors.front}
                disabled={saving}
                onChange={(value) => {
                  setFront(value);
                  setErrors((current) => ({ ...current, front: undefined }));
                }}
              />
              <FaceField
                face="back"
                value={back}
                error={errors.back}
                disabled={saving}
                onChange={(value) => {
                  setBack(value);
                  setErrors((current) => ({ ...current, back: undefined }));
                }}
              />
              {handFailed ? (
                <div className="px-nc-block">
                  <Notice tone="danger">{t("flashcards.new.saveFailed")}</Notice>
                </div>
              ) : null}
              <p className="visually-hidden" role="status">
                {announce}
              </p>
            </div>

            <div data-pane="pyxis" hidden={side !== "pyxis"} className="px-nc-pane">
              {step === "form" ? (
                places.data && subjects.length === 0 ? (
                  <div className="px-nc-block">
                    <Notice
                      tone="info"
                      action={{ label: t("flashcards.new.openLibrary"), onClick: () => navigate("/exams/library") }}
                    >
                      {t("flashcards.new.noSubjects")}
                    </Notice>
                  </div>
                ) : (
                  <>
                    {!engine ? (
                      <div className="px-nc-block">
                        <Notice
                          tone="info"
                          action={{
                            label: t("flashcards.new.noEngineAction"),
                            onClick: () => navigate("/settings/engines"),
                          }}
                        >
                          {t("flashcards.new.noEngine")}
                        </Notice>
                      </div>
                    ) : subject && noMaterial ? (
                      <div className="px-nc-block">
                        <Notice
                          tone="info"
                          action={{ label: t("flashcards.new.openLibrary"), onClick: () => navigate("/exams/library") }}
                        >
                          <Trans
                            i18nKey="flashcards.new.noMaterial"
                            values={{ subject: subject.name }}
                            components={{ b: <b /> }}
                          />
                        </Notice>
                      </div>
                    ) : subject ? (
                      <p className="small px-nc-lead">
                        <Trans
                          i18nKey="flashcards.new.pyxisLead"
                          values={{ subject: subject.name }}
                          components={{ b: <b /> }}
                        />
                      </p>
                    ) : null}
                    <SubjectField
                      id="nc-py-subject"
                      subjects={subjects}
                      value={subjectId === NEW_SUBJECT ? "" : subjectId}
                      disabled={!places.data}
                      onChange={chooseSubject}
                    />
                    <Fold shut={!subject || subject.topics.length === 0}>
                      <div className="px-nc-block">
                        <label className="label" htmlFor="nc-topic">
                          {t("flashcards.new.topic")}
                        </label>
                        <Select id="nc-topic" value={topic} onChange={setTopic}>
                          <option value="">{t("flashcards.new.wholeSubject")}</option>
                          {subject?.topics.map((group) => (
                            <optgroup key={group.planId} label={group.planTitle}>
                              {group.topics.map((item) => (
                                <option key={item.id} value={topicValue(group.planId, item.id)}>
                                  {item.title}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </Select>
                      </div>
                    </Fold>
                    <div className="px-nc-block">
                      <label className="label" htmlFor="nc-focus">
                        {t("flashcards.new.focus")}{" "}
                        <span className="px-nc-optional">{t("flashcards.new.optional")}</span>
                      </label>
                      <textarea
                        id="nc-focus"
                        className="px-nc-field px-nc-area"
                        rows={2}
                        maxLength={NEW_CARDS.focus}
                        placeholder={t("flashcards.new.focusPlaceholder")}
                        value={focusText}
                        onChange={(event) => setFocusText(event.target.value)}
                      />
                    </div>
                    <div className="px-nc-count">
                      <div>
                        <b id="nc-count-label">{t("flashcards.new.count")}</b>
                        <span className="small">{t("flashcards.new.countHint")}</span>
                      </div>
                      <Stepper
                        label="nc-count-label"
                        value={count}
                        min={NEW_CARDS.min}
                        max={NEW_CARDS.max}
                        decreaseLabel={t("flashcards.new.fewer")}
                        increaseLabel={t("flashcards.new.more")}
                        onChange={setCount}
                      />
                    </div>
                    {failure ? (
                      <div className="px-nc-block">
                        <Notice
                          tone="danger"
                          action={failureView?.action ?? retry}
                          secondary={failureView?.action ? retry : undefined}
                        >
                          {failureView?.action
                            ? failureView.text
                            : t(failure.key, { defaultValue: t("flashcards.new.failed") })}
                        </Notice>
                      </div>
                    ) : null}
                  </>
                )
              ) : null}

              {working ? (
                <div className="px-nc-slot">
                  <Logo size={44} working decorative />
                  <p role="status">
                    <b>{t("flashcards.new.workingLine")}</b>
                    {t("flashcards.new.workingDetail")}
                  </p>
                </div>
              ) : null}

              {reviewing && made ? (
                <>
                  <p className="small px-nc-lead" role="status">
                    <Trans
                      i18nKey={made.focus ? "flashcards.new.reviewLeadFocus" : "flashcards.new.reviewLead"}
                      count={made.wrote}
                      values={{ place: made.place, focus: made.focus }}
                      components={{ b: <b /> }}
                    />
                    {made.wrote < made.asked ? ` ${t("flashcards.new.short", { asked: made.asked })}` : ""}
                    {made.repeats ? ` ${t("flashcards.new.repeats", { count: made.repeats })}` : ""}
                    {rows.length ? ` ${t("flashcards.new.reviewHint")}` : ` ${t("flashcards.new.allDropped")}`}
                  </p>
                  <ProposedCards
                    rows={rows}
                    idPrefix="nc-pc"
                    disabled={savingProposed}
                    onChange={(key, patch) =>
                      setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
                    }
                    onDrop={(key) => setRows((current) => current.filter((row) => row.key !== key))}
                    onEmptied={() => document.querySelector<HTMLElement>("#nc-change-wrap button")?.focus()}
                  />
                  {rows.length === 0 ? (
                    <div className="px-nc-block">
                      <span id="nc-change-wrap">
                        <Button variant="secondary" onClick={() => setStep("form")}>
                          {t("flashcards.new.changeRequest")}
                        </Button>
                      </span>
                    </div>
                  ) : null}
                  {failure ? (
                    <div className="px-nc-block">
                      <Notice tone="danger" action={retry}>
                        {t(failure.key)}
                      </Notice>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>

      </div>
    </Dialog>
  );
}

/** A native select drawn as the dialog's fields, with its chevron. */
function Select({
  id,
  value,
  disabled,
  onChange,
  children,
}: {
  id: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <span className="px-nc-select">
      <select
        id={id}
        className="px-nc-field"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <Icon name="chevron-down" size={16} />
    </span>
  );
}

function SubjectField({
  id,
  subjects,
  value,
  allowNew,
  disabled,
  onChange,
}: {
  id: string;
  subjects: Subject[];
  value: string;
  allowNew?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="px-nc-block">
      <label className="label" htmlFor={id}>
        {t("flashcards.new.subject")}
      </label>
      <Select id={id} value={value} disabled={disabled} onChange={onChange}>
        {value === "" ? (
          <option value="" disabled>
            {t("flashcards.new.pickSubject")}
          </option>
        ) : null}
        {subjects.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
        {allowNew ? <option value={NEW_SUBJECT}>{t("flashcards.new.newSubject")}</option> : null}
      </Select>
    </div>
  );
}

/** A face of the card: its label, "Inserisci formula", the text, and a preview of a formula as the flashcard shows it. */
function FaceField({
  face,
  value,
  error,
  disabled,
  onChange,
}: {
  face: "front" | "back";
  value: string;
  error?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const id = `nc-${face}`;
  const field = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  // After a formula goes in, the caret sits between its dollars.
  useLayoutEffect(() => {
    if (caret.current === null || !field.current) return;
    field.current.focus();
    field.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);
  return (
    <div className="px-nc-block">
      <div className="px-nc-labelrow">
        <label className="label" htmlFor={id}>
          {t(`flashcards.new.${face}`)}
        </label>
        <Button
          variant="ghost"
          size="sm"
          icon="sigma"
          aria-label={t(face === "front" ? "flashcards.new.formulaFront" : "flashcards.new.formulaBack")}
          disabled={disabled}
          onClick={() => {
            const at = field.current?.selectionStart ?? value.length;
            const end = field.current?.selectionEnd ?? at;
            caret.current = at + 2;
            onChange(`${value.slice(0, at)}$  $${value.slice(end)}`);
          }}
        >
          {t("flashcards.new.formula")}
        </Button>
      </div>
      <textarea
        ref={field}
        id={id}
        className="px-nc-field px-nc-area"
        rows={2}
        maxLength={NEW_CARDS.face}
        placeholder={t(face === "front" ? "flashcards.new.frontPlaceholder" : "flashcards.new.backPlaceholder")}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={`${id}-error`} text={error} />
      <FormulaPreview label={t("flashcards.new.preview")} value={value} />
    </div>
  );
}

function FieldError({ id, text }: { id: string; text?: string }) {
  return (
    <p id={id} className="small px-nc-error" role={text ? "alert" : undefined} hidden={!text}>
      {text ? (
        <>
          <Icon name="circle-alert" size={14} />
          {text}
        </>
      ) : null}
    </p>
  );
}

/** A field that is there only sometimes, such as Esame: it folds in and out of the field above it. */
function Fold({ shut, children }: { shut: boolean; children: ReactNode }) {
  return (
    <div className="px-nc-fold" data-shut={shut || undefined} inert={shut}>
      <div>{children}</div>
    </div>
  );
}
