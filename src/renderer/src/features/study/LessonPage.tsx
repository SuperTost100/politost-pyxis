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
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import {
  finalRecap,
  parseSmartText,
  smartSections,
} from "@shared/smart-text";
import { ExportButton } from "../share/ExportButton";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";
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
} from "./Reader";

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
  const [chosen, setChosen] = useState<Wording | undefined>();
  const [exportOpen, setExportOpen] = useState(false);
  const [partOpen, setPartOpen] = useState(false);
  const [part, setPart] = useState(0);
  const [note, setNote] = useState("");
  const stop = useRef<(() => void) | null>(null);
  const regenerate = useRef(false);
  const key = ["lesson", planId, topicId, chosen ?? null];
  const lesson = useQuery({
    queryKey: key,
    enabled: Boolean(planId && topicId),
    retry: false,
    queryFn: async ({ signal }) => {
      setLive("");
      setLivePassages([]);
      const again = regenerate.current;
      regenerate.current = false;
      const handle = window.pyxis.stream(
        "study.lesson",
        {
          planId,
          topicId,
          ...(chosen ? { wording: chosen } : {}),
          ...(again ? { regenerate: true } : {}),
        },
        (event) => {
          const data = event as { text?: string; passageIds?: string[] };
          if (Array.isArray(data.passageIds)) setLivePassages(data.passageIds);
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
  const markDone = useMutation({
    mutationFn: (nodeId: string) => invoke("plans.complete", { planId, nodeId }),
    onSuccess: async () => {
      await refreshPlan();
      navigate(`/plans/${planId}`);
    },
  });

  const cancelled =
    (lesson.error as { code?: string } | null)?.code === "aborted" ||
    (lesson.error as Error | null)?.name === "AbortError";
  const writing = lesson.isFetching;
  const data = lesson.data;
  const markdown = writing
    ? live || data?.markdown || ""
    : (data?.markdown ?? (cancelled ? live : ""));
  const topic = plan.data?.topics.find((item) => item.id === topicId);
  const node = plan.data?.nodes.find(
    (item) => item.kind === "learn" && item.topicId === topicId,
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

  async function answer(blockId: string, pick: number) {
    if (!data?.itemId) return;
    const result = await invoke("study.lessonAnswer", {
      planId,
      itemId: data.itemId,
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
      {lesson.isError || data?.fallback ? (
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
      <SelectionMenu planId={planId} onAsk={(chatId) => navigate(`/ask/${chatId}`)}>
        <SmartText
          streaming={writing}
          answers={data?.answers}
          onAnswer={model && data?.itemId ? answer : undefined}
          onCitationClick={(number) => {
            const passageId = (writing || cancelled ? livePassages : data?.passageIds)?.[
              number - 1
            ];
            if (passageId) openSourceViewer({ passageId });
          }}
        >
          {markdown}
        </SmartText>
      </SelectionMenu>
      {data && !writing ? (
        <>
          <ReaderEnd
            state={
              node?.state === "done"
                ? "done"
                : node?.state === "current"
                  ? "current"
                  : "other"
            }
            doneLabel={t("lesson.doneTitle")}
            pendingHint={recapOpen ? t("lesson.recapPrompt") : undefined}
            busy={markDone.isPending}
            failed={markDone.isError}
            onMarkDone={() => node && markDone.mutate(node.id)}
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
