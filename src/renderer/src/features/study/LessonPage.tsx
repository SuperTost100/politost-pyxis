import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dropdown, Input, Modal, Radio } from "antd";
import {
  ChevronDown,
  Download,
  Ellipsis,
  Network,
  PencilLine,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import {
  finalRecap,
  parseSmartText,
  smartQuestions,
  smartSections,
} from "@shared/smart-text";
import { ExportButton } from "../share/ExportButton";
import { errorDetails } from "../../lib/errorDetails";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";
import { createAnswerQueue } from "./answerQueue";
import { ErrorState } from "../../components/ErrorState";
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

type Wording = "simple" | "balanced" | "technical";
type Lesson = RequestOutput<"study.lesson">;
const wordings: Wording[] = ["simple", "balanced", "technical"];

export function LessonPage() {
  const { t } = useTranslation();
  const { planId = "", topicId = "" } = useParams();
  useActiveTime(planId, topicId || null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [modal, modalContext] = Modal.useModal();
  const [live, setLive] = useState("");
  const [livePassages, setLivePassages] = useState<string[]>([]);
  const [liveCitations, setLiveCitations] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Wording | undefined>();
  const [exportOpen, setExportOpen] = useState(false);
  const [partOpen, setPartOpen] = useState(false);
  const [part, setPart] = useState(0);
  const [note, setNote] = useState("");
  const stop = useRef<(() => void) | null>(null);
  // Picks on checks the stream has closed; they wait here until the lesson is saved.
  const [queued] = useState(createAnswerQueue);
  const regenerate = useRef(false);
  // Opened from a finished step: that saved lesson is shown as it was read, until the student picks a level or
  // rewrites it. Without it (or if it is gone) the topic's lesson opens as usual.
  const [searchParams] = useSearchParams();
  const [reopened] = useState(() => searchParams.get("item") ?? undefined);
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
          if (Array.isArray(data.passageIds)) setLivePassages(data.passageIds);
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
  const plan = useQuery({
    queryKey: ["plan", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.read", { planId }),
  });
  const refreshPlan = () =>
    Promise.all(
      [["plan", planId], ["series", planId], ["recommend", planId], ["progress", planId]].map(
        (queryKey) => client.invalidateQueries({ queryKey }),
      ),
    );
  const rewritePart = useMutation({
    mutationFn: () =>
      invoke("study.lessonSection", {
        planId,
        topicId,
        section: part,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(chosen ? { wording: chosen } : {}),
      }),
    onSuccess: (next) => {
      client.setQueryData(key, next);
      setPartOpen(false);
      setNote("");
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
      await refreshPlan();
      if (then === "continue") await openNext();
      else navigate(`/plans/${planId}`);
    },
  });

  const cancelled =
    (lesson.error as { code?: string } | null)?.code === "aborted" ||
    (lesson.error as Error | null)?.name === "AbortError";
  const failedToOpen = lesson.isError && !cancelled && !lesson.data?.fallback;
  const writing = lesson.isFetching;
  const data = lesson.data;
  const fromLive = showsLiveText({ writing, live, saved: data?.markdown, cancelled });
  const markdown = writing
    ? live || data?.markdown || ""
    : (data?.markdown ?? (cancelled ? live : ""));
  const topic = plan.data?.topics.find((item) => item.id === topicId);
  const read = plan.data?.steps.some(
    (step) => step.activity === "lesson" && step.topicId === topicId,
  );
  const wording = chosen ?? data?.wording ?? "balanced";
  const model = Boolean(data && !data.fallback);
  // Only a smart lesson can have one part rewritten; an earlier lesson is rewritten whole.
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
  const busy = writing || rewritePart.isPending;
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
    if (result.finished) await refreshPlan();
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

  const levelMenu = (
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
      <Button
        shape="round"
        aria-label={`${t("lesson.wording.label")}: ${t(`lesson.wording.${wording}`)}`}
      >
        <span className="px-reader-level">
          <span className="ink-muted">{t("lesson.level")}</span>
          {t(`lesson.wording.${wording}`)}
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
        </span>
      </Button>
    </Dropdown>
  );
  const moreMenu = (
    <Dropdown
      trigger={["click"]}
      placement="bottomRight"
      menu={{
        items: [
          {
            key: "regenerate",
            icon: <RefreshCw size={16} aria-hidden />,
            label: t("lesson.regenerate"),
            disabled: busy,
          },
          {
            key: "part",
            icon: <PencilLine size={16} aria-hidden />,
            label: t("lesson.rewritePart"),
            disabled: busy || sections.length === 0,
          },
          { type: "divider" },
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
          if (action === "part") {
            setPart(0);
            rewritePart.reset();
            setPartOpen(true);
          }
          if (action === "map") navigate(`/plans/${planId}/map/${topicId}`);
          if (action === "export") setExportOpen(true);
        },
      }}
    >
      <Button
        shape="circle"
        type="text"
        aria-label={t("lesson.more")}
        title={t("lesson.more")}
        icon={<Ellipsis size={18} strokeWidth={1.75} />}
      />
    </Dropdown>
  );

  return (
    <ReaderLayout
      eyebrow={t("lesson.title")}
      title={topic?.title ?? t("lesson.title")}
      backLabel={t("lesson.back")}
      onBack={() => navigate(`/plans/${planId}`)}
      actions={
        <>
          {levelMenu}
          {moreMenu}
        </>
      }
    >
      {modalContext}
      {data?.general && !writing ? (
        <div className="px-reader-note">
          <Tag tone="general">{t("components.tags.general")}</Tag>
          <span className="meta ink-muted">{t("lesson.generalNote")}</span>
        </div>
      ) : null}
      {failedToOpen ? (
        <div className="px-reader-note">
          <ErrorState
            action={{ label: t("lesson.retry"), onClick: () => void lesson.refetch() }}
            secondary={{ label: t("engines.title"), onClick: () => navigate("/settings/engines") }}
            details={errorDetails(lesson.error)}
          >
            {t("lesson.failed")}
          </ErrorState>
        </div>
      ) : lesson.isError || data?.fallback ? (
        <div className="px-reader-note">
          <Notice
            tone={cancelled ? "info" : "warning"}
            action={{ label: t("lesson.retry"), onClick: () => void lesson.refetch() }}
            secondary={
              lesson.isError && !cancelled
                ? { label: t("engines.title"), onClick: () => navigate("/settings/engines") }
                : undefined
            }
          >
            {data?.fallback
              ? t("lesson.sourceFallback")
              : t(cancelled ? "lesson.cancelled" : "lesson.failed")}
          </Notice>
        </div>
      ) : null}
      {writing ? (
        <ReaderProgress
          label={t("lesson.writing")}
          stopLabel={t("lesson.stop")}
          onStop={() => stop.current?.()}
          empty={!markdown}
        />
      ) : null}
      {rewritePart.isPending ? (
        <ReaderProgress
          label={t("lesson.rewritingPart", { title: sections[part]?.title ?? "" })}
          empty={false}
        />
      ) : null}
      <SelectionMenu planId={planId} topicId={topicId} passageIds={data?.passageIds} onAsk={(chatId) => navigate(`/ask/${chatId}`)}>
        <SmartText
          streaming={writing}
          figures={data?.figures}
          answers={data?.answers}
          onAnswer={
            writing ? (live ? answer : undefined) : model && data?.itemId ? answer : undefined
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
      {data && !writing ? (
        <>
          <ReaderEnd
            state={!plan.data || !topic ? "other" : read ? "done" : "current"}
            doneLabel={t("lesson.doneTitle")}
            pendingHint={recapOpen ? t("lesson.recapPrompt") : undefined}
            busy={markDone.isPending ? markDone.variables : undefined}
            failed={markDone.isError}
            onDone={() => markDone.mutate("done")}
            onContinue={() => markDone.mutate("continue")}
            onBack={() => navigate(`/plans/${planId}`)}
          />
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
        open={partOpen}
        title={t("lesson.rewritePartTitle")}
        okText={t("lesson.regenerate")}
        cancelText={t("jobs.cancel")}
        confirmLoading={rewritePart.isPending}
        onOk={() => rewritePart.mutate()}
        onCancel={() => !rewritePart.isPending && setPartOpen(false)}
        closable={!rewritePart.isPending}
        maskClosable={!rewritePart.isPending}
      >
        <div className="px-reader-part">
          <p className="small ink-muted">{t("lesson.rewritePartHint")}</p>
          <Radio.Group
            value={part}
            onChange={(event) => setPart(event.target.value as number)}
            disabled={rewritePart.isPending}
            aria-label={t("lesson.rewritePartTitle")}
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
            disabled={rewritePart.isPending}
            aria-label={t("lesson.rewritePartNote")}
            placeholder={t("lesson.rewritePartNote")}
            onChange={(event) => setNote(event.target.value)}
          />
          {rewritePart.isError ? (
            <Notice tone="danger">{t("lesson.rewritePartFailed")}</Notice>
          ) : null}
        </div>
      </Modal>
    </ReaderLayout>
  );
}
