import { useQueryClient } from "@tanstack/react-query";
import { App, Button, Input, Modal, Select, Skeleton } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import { isCloze } from "../../../core/study/cloze";
import { invoke } from "../lib/ipc";
import { CitationChip } from "./CitationChip";
import { IconButton } from "./IconButton";
import { MathText } from "./math/MathText";
import { Notice } from "./Notice";
import { openSourceViewer } from "./SourceViewer";
import "./MakeCardsDialog.css";

/** The text to make flashcards from, and what is known about where they belong. */
export type CardSource = {
  text: string;
  origin: "reply" | "selection";
  /** The lesson's plan and topic, or the chat's plan. */
  planId?: string;
  topicId?: string;
  /** The chat's subject name. */
  subject?: string;
  /** Passages the text cites or comes from; they pick the topic and become the cards' source links. */
  passageIds?: string[];
};

const eventName = "pyxis:make-cards";
export function openMakeCards(source: CardSource): void {
  window.dispatchEvent(new CustomEvent(eventName, { detail: source }));
}

type Places = RequestOutput<"study.cardsPlaces">;
type Proposal = RequestOutput<"study.cardsPropose">;
type Row = {
  key: number;
  front: string;
  back: string;
  passageId: string | null;
};

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
  const client = useQueryClient();
  const [source, setSource] = useState<CardSource | null>(null);
  const [places, setPlaces] = useState<Places | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [step, setStep] = useState<"pick" | "working" | "review">("pick");
  const [rows, setRows] = useState<Row[]>([]);
  const [made, setMade] = useState<Pick<Proposal, "provider" | "model"> | null>(
    null,
  );
  const [error, setError] = useState<{ key: string; save: boolean } | null>(
    null,
  );
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
        passageIds: next.passageIds,
      }).then(
        (found) => {
          if (id !== run.current) return;
          setPlaces(found);
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

  async function make() {
    if (!source || !planId || !topicId) return;
    stop();
    const id = run.current;
    setError(null);
    setStep("working");
    const handle = window.pyxis.stream(
      "study.cardsPropose",
      {
        planId,
        topicId,
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
      setError({ key: failureKey(err), save: false });
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
    if (!planId || !topicId || !made || !rows.length || incomplete || saving)
      return;
    setSaving(true);
    setError(null);
    try {
      const result = await invoke("study.cardsSaveProposed", {
        planId,
        topicId,
        cards: rows.map(({ front, back, passageId }) => ({
          front,
          back,
          passageId,
        })),
        ...made,
      });
      await Promise.all(
        ["cards", "card-queue", "card-browse", "review-session", "plan"].map(
          (key) => client.invalidateQueries({ queryKey: [key] }),
        ),
      );
      const saved = t("makeCards.saved", {
        count: result.saved,
        topic: topic?.title ?? "",
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
  const noPlans = places !== null && places.plans.length === 0;
  const footer =
    step === "review" ? (
      <>
        <Button shape="round" onClick={close} disabled={saving}>
          {t("makeCards.cancel")}
        </Button>
        <Button
          shape="round"
          onClick={() => void make()}
          disabled={saving || !topicId}
        >
          {t("makeCards.again")}
        </Button>
        <Button
          type="primary"
          shape="round"
          loading={saving}
          disabled={!rows.length || incomplete || !topicId}
          onClick={() => void save()}
        >
          {t("makeCards.save", { count: rows.length })}
        </Button>
      </>
    ) : (
      <>
        <Button shape="round" onClick={close}>
          {t("makeCards.cancel")}
        </Button>
        <Button
          type="primary"
          shape="round"
          loading={working}
          disabled={!topicId || noPlans}
          onClick={() => void make()}
        >
          {t("makeCards.make")}
        </Button>
      </>
    );

  return (
    <Modal
      title={t("makeCards.title")}
      open={source !== null}
      onCancel={() => {
        if (!saving) close();
      }}
      closable={!saving}
      maskClosable={!saving && !working}
      keyboard={!saving}
      footer={footer}
      width={640}
      className="px-makecards"
      destroyOnHidden
    >
      {source ? (
        <div className="px-mc-body">
          <figure className="px-mc-source">
            <figcaption className="label">
              {t(
                source.origin === "reply"
                  ? "makeCards.fromReply"
                  : "makeCards.fromSelection",
              )}
            </figcaption>
            <p>
              <MathText text={source.text} />
            </p>
          </figure>
          <div className="px-mc-where">
            <div className="px-mc-field">
              <label className="label" htmlFor="mc-plan">
                {t("makeCards.plan")}
              </label>
              <Select
                id="mc-plan"
                showSearch={{ optionFilterProp: "label" }}
                loading={places === null && !error}
                disabled={working || saving || noPlans}
                value={planId}
                placeholder={t("makeCards.planPlaceholder")}
                options={places?.plans.map((item) => ({
                  value: item.id,
                  label: item.title,
                }))}
                onChange={(value) => {
                  setPlanId(value);
                  setTopicId(null);
                }}
              />
            </div>
            <div className="px-mc-field">
              <label className="label" htmlFor="mc-topic">
                {t("makeCards.topic")}
              </label>
              <Select
                id="mc-topic"
                showSearch={{ optionFilterProp: "label" }}
                disabled={working || saving || !plan}
                value={topicId}
                placeholder={t("makeCards.topicPlaceholder")}
                options={plan?.topics.map((item) => ({
                  value: item.id,
                  label: item.title,
                }))}
                onChange={setTopicId}
              />
            </div>
          </div>
          {noPlans ? (
            <Notice tone="info">{t("makeCards.noPlans")}</Notice>
          ) : null}
          {error ? (
            <Notice tone="danger">
              {t(error.key, { defaultValue: t("makeCards.failed") })}
            </Notice>
          ) : null}
          {step === "pick" && !noPlans && !error ? (
            <p className="small px-mc-hint">{t("makeCards.hint")}</p>
          ) : null}
          {working ? (
            <div className="px-mc-working" role="status">
              <span className="small">{t("makeCards.working")}</span>
              <Skeleton active paragraph={{ rows: 3 }} title={false} />
            </div>
          ) : null}
          {step === "review" ? (
            rows.length ? (
              <ol className="px-mc-list" aria-label={t("makeCards.listLabel")}>
                {rows.map((row, index) => (
                  <li key={row.key} className="px-mc-card">
                    <div className="px-mc-card-head">
                      <span className="label">
                        {t("makeCards.cardN", { n: index + 1 })}
                      </span>
                      {row.passageId ? (
                        <CitationChip
                          onClick={() =>
                            openSourceViewer({
                              passageId: row.passageId ?? undefined,
                            })
                          }
                        >
                          {t("makeCards.source")}
                        </CitationChip>
                      ) : null}
                      <span className="px-mc-spacer" />
                      <IconButton
                        icon="x"
                        variant="ghost"
                        size="sm"
                        label={t("makeCards.drop", { n: index + 1 })}
                        disabled={saving}
                        onClick={() =>
                          setRows((current) =>
                            current.filter((item) => item.key !== row.key),
                          )
                        }
                      />
                    </div>
                    <label
                      className="small px-mc-face"
                      htmlFor={`mc-front-${row.key}`}
                    >
                      {t("makeCards.front")}
                    </label>
                    <Input.TextArea
                      id={`mc-front-${row.key}`}
                      autoSize={{ minRows: 1, maxRows: 5 }}
                      value={row.front}
                      disabled={saving}
                      onChange={(event) =>
                        update(row.key, { front: event.target.value })
                      }
                    />
                    {isCloze(row.front) ? (
                      <p className="small px-mc-cloze">
                        {t("makeCards.cloze", { markup: "{{c1::…}}" })}
                      </p>
                    ) : null}
                    <label
                      className="small px-mc-face"
                      htmlFor={`mc-back-${row.key}`}
                    >
                      {t("makeCards.back")}
                    </label>
                    <Input.TextArea
                      id={`mc-back-${row.key}`}
                      autoSize={{ minRows: 1, maxRows: 5 }}
                      value={row.back}
                      disabled={saving}
                      onChange={(event) =>
                        update(row.key, { back: event.target.value })
                      }
                    />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="small px-mc-hint">{t("makeCards.allDropped")}</p>
            )
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
