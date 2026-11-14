import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dropdown, Input, Modal, Radio } from "antd";
import {
  ChevronDown,
  Download,
  ListOrdered,
  Network,
  PencilLine,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import {
  finalRecap,
  parseSmartText,
  smartQuestions,
  smartSections,
  writtenSections,
} from "@shared/smart-text";
import { ExportButton } from "../share/ExportButton";
import { errorDetails } from "../../lib/errorDetails";
import { errorProvider, useEngineError } from "../../lib/engineError";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";
import { createAnswerQueue } from "./answerQueue";
import { ErrorState } from "../../components/ErrorState";
import { MenuButton } from "../../components/ItemMenu";
import { Notice } from "../../components/Notice";
import { Tag } from "../../components/Tag";
import { openSourceViewer } from "../../components/SourceViewer";
import { SelectionMenu } from "../../components/SelectionMenu";
import { SmartText } from "../../components/SmartText";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import {
  ReaderEnd,
  ReaderLayout,
  ReaderProgress,
  SourcesFooter,
  useOpenNext,
} from "./Reader";
import { showsLiveText } from "./lessonLive";
import { lessonLine, sectionFailedKey } from "./partPage";
import { usePlan } from "../../lib/queries";
import { returnTo, type BackTarget } from "../../app/usePlace";
import { refreshPlan } from "../../lib/refreshPlan";

type Wording = "simple" | "balanced" | "technical";
type Lesson = RequestOutput<"study.lesson">;
const wordings: Wording[] = ["simple", "balanced", "technical"];

/** A rewrite in parts that did not finish: what happened, with Riprova, above the old lesson it leaves as it was. */
type RewriteNotice = {
  text: string;
  /** Danger when the rewrite failed, warning when it stopped with nothing failed (`stoppedTone`). */
  tone: "danger" | "warning";
  action: { label: string; onClick: () => void; disabled?: boolean };
  secondary?: { label: string; onClick: () => void };
  details?: string;
};

/**
 * The reader that came before lessons in parts. Old lessons in parts: `old: "finished"` is a finished lesson written
 * before parts, whose menu gets "Riscrivi in parti"; `old: "earlier"` is the version a lesson in parts rewrote, shown
 * as it was, read-only, with the way back to the parts. `itemId` with `notice` shows the old lesson in place of a
 * rewrite that did not finish: the student can still answer it and finish it, but not rewrite it in one piece.
 */
export function LegacyLessonPage({
  old,
  itemId,
  notice,
  back,
}: { old?: "finished" | "earlier"; itemId?: string; notice?: RewriteNotice; back: BackTarget | null }) {
  const { t } = useTranslation();
  const { planId = "", topicId = "" } = useParams();
  useActiveTime(planId, topicId || null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [modal, modalContext] = Modal.useModal();
  const [live, setLive] = useState("");
  const [livePassages, setLivePassages] = useState<string[]>([]);
  const [liveCitations, setLiveCitations] = useState<string[]>([]);
  // Known from the first event, before any text: the lesson is written from the model's own knowledge, not sources.
  const [liveGeneral, setLiveGeneral] = useState(false);
  const [chosen, setChosen] = useState<Wording | undefined>();
  const [exportOpen, setExportOpen] = useState(false);
  const [sectionOpen, setSectionOpen] = useState(false);
  const [section, setSection] = useState(0);
  const [note, setNote] = useState("");
  const stop = useRef<(() => void) | null>(null);
  // Picks on checks the stream has closed; they wait here until the lesson is saved.
  const [queued] = useState(createAnswerQueue);
  const regenerate = useRef(false);
  // Opened from a finished step: that saved lesson is shown as it was read, until the student picks a level or
  // rewrites it. Without it (or if it is gone) the topic's lesson opens as usual.
  const [searchParams] = useSearchParams();
  const [reopened] = useState(() => itemId ?? searchParams.get("item") ?? undefined);
  // The earlier version of a lesson now in parts is read as it was; neither it nor the old lesson a rewrite fell back
  // to is rewritten in one piece, by level or by section.
  const readOnly = old === "earlier";
  const fixed = readOnly || itemId !== undefined;
  const [partsOpen, setPartsOpen] = useState(false);
  const reading = useRef(true);
  const key = ["lesson", planId, topicId, chosen ?? null, reopened ?? null];
  const lesson = useQuery({
    queryKey: key,
    enabled: Boolean(planId && topicId),
    retry: false,
    queryFn: async ({ signal }) => {
      setLive("");
      setLivePassages([]);
      setLiveCitations([]);
      setLiveGeneral(false);
      queued.drop();
      const again = regenerate.current;
      regenerate.current = false;
      if (again || chosen) reading.current = false;
      const handle = window.pyxis.stream(
        "study.lesson",
        {
          planId,
          topicId,
          ...(chosen ? { wording: chosen } : {}),
          ...(again ? { regenerate: true } : {}),
          ...(reopened && reading.current ? { itemId: reopened } : {}),
        },
        (event) => {
          const data = event as { text?: string; passageIds?: string[]; citations?: string[] };
          if (Array.isArray(data.passageIds)) {
            setLivePassages(data.passageIds);
            setLiveGeneral(data.passageIds.length === 0);
          }
          if (Array.isArray(data.citations)) setLiveCitations(data.citations);
          if (typeof data.text === "string") setLive(data.text);
        },
      );
      stop.current = handle.cancel;
      signal.addEventListener("abort", handle.cancel, { once: true });
      try {
        return (await handle.result) as Lesson;
      } finally {
        signal.removeEventListener("abort", handle.cancel);
        if (stop.current === handle.cancel) stop.current = null;
      }
    },
  });
  const plan = usePlan(planId);
  const rewriteSection = useMutation({
    mutationFn: () =>
      invoke("study.lessonSection", {
        planId,
        topicId,
        section,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(chosen ? { wording: chosen } : {}),
      }),
    onSuccess: (next) => {
      client.setQueryData(key, next);
      setSectionOpen(false);
      setNote("");
    },
    // Another rewrite saved the lesson meanwhile: the page reads the text it has now, which a new try starts from.
    onError: (error) => {
      if (sectionFailedKey(error, "lesson") === "lesson.rewriteSectionChanged") void lesson.refetch();
    },
  });
  // "Riscrivi in parti" on a finished lesson: the rewrite starts, and the page opens part 1, which shows it at work.
  const toParts = useMutation({
    mutationFn: () => invoke("study.rewriteInParts", { planId, topicId }),
    onSuccess: () => {
      setPartsOpen(false);
      void client.invalidateQueries({ queryKey: ["jobs"] });
      navigate(`/plans/${planId}/lesson/${topicId}?part=1`, { replace: true });
    },
  });
  const openNext = useOpenNext(planId);
  // "Done" goes back to the plan; "Done, continue" opens the next step. A page already done only moves on.
  const markDone = useMutation({
    mutationFn: async (then: "done" | "continue") => {
      if (!read) await invoke("plans.complete", { planId, activity: "lesson", topicId });
      return then;
    },
    onSuccess: async (then) => {
      await refreshPlan(client, planId);
      if (then === "continue") await openNext();
      else returnTo(back, `/plans/${planId}`, navigate);
    },
  });

  const cancelled =
    (lesson.error as { code?: string } | null)?.code === "aborted" ||
    (lesson.error as Error | null)?.name === "AbortError";
  const failedToOpen = lesson.isError && !cancelled && !lesson.data?.fallback;
  const writing = lesson.isFetching;
  const data = lesson.data;
  const describeEngineError = useEngineError();
  // The engine whose failure left the lesson on the book text, or kept it from opening, named with its sign-in.
  const fallbackError = data?.fallbackReason
    ? describeEngineError(data.fallbackReason, data.fallbackProvider)
    : undefined;
  const openError =
    failedToOpen && lesson.error && typeof lesson.error === "object" && "messageKey" in lesson.error
      ? describeEngineError(String(lesson.error.messageKey), errorProvider(lesson.error))
      : undefined;
  const fromLive = showsLiveText({ writing, live, saved: data?.markdown, cancelled });
  // While the lesson is written, the reader gets each section once it is finished and a status for the one in progress,
  // so nothing they are reading changes under them. Text that is stopped or saved shows whole.
  const written = useMemo(() => (writing && live ? writtenSections(live) : null), [writing, live]);
  const markdown = writing
    ? written
      ? written.done
      : (data?.markdown ?? "")
    : (data?.markdown ?? (cancelled ? live : ""));
  const topic = plan.data?.topics.find((item) => item.id === topicId);
  const read = plan.data?.steps.some(
    (step) => step.activity === "lesson" && step.topicId === topicId,
  );
  const wording = chosen ?? data?.wording ?? "balanced";
  const model = Boolean(data && !data.fallback);
  // Only a smart lesson can have one section rewritten; an earlier lesson is rewritten whole.
  const sections = useMemo(
    () => (model && data && !data.earlier ? smartSections(data.markdown) : []),
    [model, data],
  );
  const recap = useMemo(
    () => (data ? finalRecap(parseSmartText(data.markdown)) : null),
    [data],
  );
  const recapOpen = recap?.questions.some(
    (question) => data?.answers[question.id] === undefined,
  );
  const busy = writing || rewriteSection.isPending;
  // Chips read the section they cite, as in Ask. Kept stable so a render that changes nothing else reuses the parse.
  // They follow the text on screen: a regenerate that has not streamed yet, or was stopped, still shows the saved lesson.
  const labels = fromLive ? liveCitations : data?.citations;
  const citationLabel = useCallback((number: number) => labels?.[number - 1], [labels]);

  async function save(itemId: string, blockId: string, pick: number) {
    const result = await invoke("study.lessonAnswer", {
      planId,
      itemId,
      blockId,
      pick,
    });
    client.setQueryData<Lesson>(key, (current) =>
      current
        ? { ...current, answers: { ...current.answers, [blockId]: result.pick } }
        : current,
    );
    void client.invalidateQueries({ queryKey: ["series", planId] });
    if (result.finished) await refreshPlan(client, planId);
  }

  // While the lesson is written, a pick has no saved lesson to count against: the reader sees the result at once and
  // the pick is sent when the lesson is saved. A stop, a failure or the book fallback drops it without an error: the
  // partial lesson is not saved, and its notice says so. Until the new text starts, the old lesson on screen is not
  // the one being written, so its checks take no pick.
  async function answer(blockId: string, pick: number) {
    if (writing) return queued.add(blockId, pick);
    if (data?.itemId) await save(data.itemId, blockId, pick);
  }
  useEffect(() => {
    if (lesson.isFetching) return;
    const saved = lesson.data;
    if (lesson.isError || !saved?.itemId || saved.fallback) {
      queued.drop();
      return;
    }
    const itemId = saved.itemId;
    const ids = new Set(smartQuestions(parseSmartText(saved.markdown)).keys());
    void queued.flush(
      (blockId) => ids.has(blockId),
      (blockId, pick) => save(itemId, blockId, pick),
    );
    // `save` reads only what the render that finished the stream holds.
  }, [lesson.data, lesson.isFetching, lesson.isError, queued]);

  const levelHintId = useId();
  const levelMenu = (
    <>
      <Dropdown
        trigger={["click"]}
        disabled={busy}
        menu={{
          selectable: true,
          selectedKeys: [wording],
          items: wordings.map((value) => ({
            key: value,
            label: t(`lesson.wording.${value}`),
          })),
          onClick: ({ key: value }) => setChosen(value as Wording),
        }}
      >
        <Button type="text" className="px-studybar-action" icon={<SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden />} aria-describedby={levelHintId}>
          <span className="px-reader-level">
            <span className="ink-muted">{t("lesson.level")}</span>
            {t(`lesson.wording.${wording}`)}
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
          </span>
        </Button>
      </Dropdown>
      {/* The visible "Level Balanced" names the button (WCAG 2.5.3); the full name of the setting is its description. */}
      <span id={levelHintId} className="visually-hidden">
        {t("lesson.wording.label")}
      </span>
    </>
  );
  const moreMenu = (
    <MenuButton
      rightClick
      label={t("lesson.more")}
      menu={{
        items: [
          ...(old === "finished"
            ? [
                {
                  key: "parts",
                  icon: <ListOrdered size={16} aria-hidden />,
                  label: t("lesson.rewriteInParts"),
                  disabled: busy,
                },
              ]
            : []),
          ...(fixed
            ? []
            : [
                {
                  key: "regenerate",
                  icon: <RefreshCw size={16} aria-hidden />,
                  label: t("lesson.regenerate"),
                  disabled: busy,
                },
                {
                  key: "section",
                  icon: <PencilLine size={16} aria-hidden />,
                  label: t("lesson.rewriteSection"),
                  disabled: busy || sections.length === 0,
                },
                { type: "divider" as const },
              ]),
          {
            key: "map",
            icon: <Network size={16} aria-hidden />,
            label: t("map.title"),
          },
          {
            key: "export",
            icon: <Download size={16} aria-hidden />,
            label: t("export.title"),
            disabled: busy || !data,
          },
        ],
        onClick: ({ key: action }) => {
          if (action === "parts") {
            toParts.reset();
            setPartsOpen(true);
          }
          if (action === "regenerate")
            void modal.confirm({
              icon: null,
              title: t("lesson.regenerateConfirm"),
              content: t("lesson.regenerateNote"),
              okText: t("lesson.regenerate"),
              cancelText: t("jobs.cancel"),
              onOk: () => {
                regenerate.current = true;
                void lesson.refetch();
              },
            });
          if (action === "section") {
            setSection(0);
            rewriteSection.reset();
            setSectionOpen(true);
          }
          if (action === "map") navigate(`/plans/${planId}/map/${topicId}`);
          if (action === "export") setExportOpen(true);
        },
      }}
    />
  );

  // Above the title, what the lesson was written from: its first two sources and how many more.
  const sourceTitles = (data?.sources ?? []).map((source) => source.title);
  const sourceLine = sourceTitles.length
    ? t("lesson.fromSources", {
        list:
          sourceTitles.length > 2
            ? t("lesson.sourcesMore", { first: sourceTitles.slice(0, 2).join(", "), count: sourceTitles.length - 2 })
            : sourceTitles.join(t("lesson.sourcesAnd")),
      })
    : t("lesson.title");

  return (
    <ReaderLayout
      eyebrow={sourceLine}
      title={topic?.title ?? t("lesson.title")}
      back={back}
      barTitle={topic?.title ?? t("lesson.title")}
      barSubtitle={(minutes) => lessonLine(t, { many: false, recap: false, position: 1, parts: 1, minutes })}
      outline
      tools={fixed ? null : levelMenu}
      menu={moreMenu}
    >
      {modalContext}
      {notice ? (
        <div className="px-reader-note">
          <Notice tone={notice.tone} action={notice.action} secondary={notice.secondary} details={notice.details}>
            {notice.text}
          </Notice>
        </div>
      ) : readOnly ? (
        <div className="px-reader-note">
          <Notice
            tone="info"
            action={{ label: t("lesson.backToParts"), onClick: () => navigate(`/plans/${planId}/lesson/${topicId}`, { replace: true }) }}
          >
            {t("lesson.earlierNote")}
          </Notice>
        </div>
      ) : null}
      {(writing ? liveGeneral : data?.general) ? (
        <div className="px-reader-note">
          <Tag tone="general">{t("components.tags.general")}</Tag>
          <span className="meta ink-muted">{t("lesson.generalNote")}</span>
        </div>
      ) : null}
      {failedToOpen ? (
        <div className="px-reader-note">
          <ErrorState
            action={{ label: t("lesson.retry"), onClick: () => void lesson.refetch() }}
            secondary={
              openError?.action ?? {
                label: t("engines.title"),
                onClick: () => navigate("/settings/engines"),
              }
            }
            details={errorDetails(lesson.error)}
          >
            {openError?.action ? openError.text : t("lesson.failed")}
          </ErrorState>
        </div>
      ) : lesson.isError || data?.fallback ? (
        <div className="px-reader-note">
          {/* What the notice says and its tone come from one kind, so a text for one cannot be drawn as another. */}
          {(() => {
            const kind = data?.fallback ? "fallback" : cancelled ? "cancelled" : "failed";
            return (
              <Notice
                tone={{ fallback: "warning", cancelled: "info", failed: "danger" }[kind] as "warning" | "info" | "danger"}
                action={{ label: t("lesson.retry"), onClick: () => void lesson.refetch() }}
                secondary={
                  // A refused sign-in names its engine and opens its sign-in; any other engine failure opens the engines page.
                  fallbackError?.action ??
                  ((lesson.isError && !cancelled) || data?.fallbackReason
                    ? { label: t("engines.title"), onClick: () => navigate("/settings/engines") }
                    : undefined)
                }
              >
                {kind === "fallback"
                  ? fallbackError
                    ? `${t("lesson.sourceFallback")} ${fallbackError.text}`
                    : t("lesson.sourceFallback")
                  : t(kind === "cancelled" ? "lesson.cancelled" : "lesson.failed")}
              </Notice>
            );
          })()}
        </div>
      ) : null}
      {rewriteSection.isPending ? (
        <ReaderProgress
          label={t("lesson.rewritingSection", { title: sections[section]?.title ?? "" })}
          empty={false}
        />
      ) : null}
      <SelectionMenu planId={planId} topicId={topicId} passageIds={fromLive ? livePassages : data?.passageIds} onAsk={(chatId) => navigate(`/ask/${chatId}`)}>
        <SmartText
          streaming={writing}
          figures={data?.figures}
          answers={data?.answers}
          onAnswer={
            readOnly ? undefined : writing ? (live ? answer : undefined) : model && data?.itemId ? answer : undefined
          }
          onCitationClick={(number) => {
            const passageId = (fromLive ? livePassages : data?.passageIds)?.[
              number - 1
            ];
            if (passageId) openSourceViewer({ passageId });
          }}
          citationResolver={citationLabel}
        >
          {markdown}
        </SmartText>
      </SelectionMenu>
      {writing ? (
        <ReaderProgress
          label={
            written?.writing
              ? t("lesson.writingSection", { n: written.writing.number })
              : t("lesson.writing")
          }
          detail={written?.writing ? <InlineMarkdown>{written.writing.title}</InlineMarkdown> : undefined}
          stopLabel={t("lesson.stop")}
          onStop={() => stop.current?.()}
          empty={!markdown}
          pending
        />
      ) : null}
      {data && !writing ? (
        <>
          {readOnly ? null : <ReaderEnd
            state={!plan.data || !topic ? "other" : read ? "done" : "current"}
            doneLabel={t("lesson.doneTitle")}
            pendingHint={recapOpen ? t("lesson.recapPrompt") : undefined}
            busy={markDone.isPending ? markDone.variables : undefined}
            failed={markDone.isError}
            onDone={() => markDone.mutate("done")}
            onContinue={() => markDone.mutate("continue")}
          />}
          <SourcesFooter sources={data.sources} />
        </>
      ) : null}
      <ExportButton
        planId={planId}
        topicId={topicId}
        kind="lesson"
        wording={wording}
        open={exportOpen}
        onOpenChange={setExportOpen}
      />
      <Modal
        open={partsOpen}
        title={t("lesson.rewriteInPartsTitle")}
        okText={t("lesson.rewriteInParts")}
        cancelText={t("jobs.cancel")}
        confirmLoading={toParts.isPending}
        onOk={() => toParts.mutate()}
        onCancel={() => !toParts.isPending && setPartsOpen(false)}
        closable={!toParts.isPending}
        maskClosable={!toParts.isPending}
      >
        <div className="px-reader-section">
          <p>{t("lesson.rewriteInPartsNote")}</p>
          {toParts.isError ? <Notice tone="danger">{t("lesson.rewriteInPartsFailed")}</Notice> : null}
        </div>
      </Modal>
      <Modal
        open={sectionOpen}
        title={t("lesson.rewriteSectionTitle")}
        okText={t("lesson.regenerate")}
        cancelText={t("jobs.cancel")}
        confirmLoading={rewriteSection.isPending}
        onOk={() => rewriteSection.mutate()}
        onCancel={() => !rewriteSection.isPending && setSectionOpen(false)}
        closable={!rewriteSection.isPending}
        maskClosable={!rewriteSection.isPending}
      >
        <div className="px-reader-section">
          <p className="small ink-muted">{t("lesson.rewriteSectionHint")}</p>
          <Radio.Group
            value={section}
            onChange={(event) => setSection(event.target.value as number)}
            disabled={rewriteSection.isPending}
            aria-label={t("lesson.rewriteSectionTitle")}
          >
            {sections.map((section, index) => (
              <Radio key={index} value={index}>
                <InlineMarkdown>{section.title}</InlineMarkdown>
              </Radio>
            ))}
          </Radio.Group>
          <Input.TextArea
            value={note}
            maxLength={500}
            rows={3}
            disabled={rewriteSection.isPending}
            aria-label={t("lesson.rewriteSectionNote")}
            placeholder={t("lesson.rewriteSectionNote")}
            onChange={(event) => setNote(event.target.value)}
          />
          {rewriteSection.isError ? (
            <Notice tone="danger">{t(sectionFailedKey(rewriteSection.error, "lesson"))}</Notice>
          ) : null}
        </div>
      </Modal>
    </ReaderLayout>
  );
}
