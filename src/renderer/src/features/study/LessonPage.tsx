import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Popconfirm, Popover, Segmented } from "antd";
import { Flag, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { MarkdownView } from "../../components/MarkdownView";
import { ExportButton } from "../share/ExportButton";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";
import { Notice } from "../../components/Notice";
import { Tag } from "../../components/Tag";
import { openSourceViewer } from "../../components/SourceViewer";
import { SelectionMenu } from "../../components/SelectionMenu";
import { useRef, useState } from "react";

type Wording = "simple" | "balanced" | "technical";
const wordings: Wording[] = ["simple", "balanced", "technical"];

export function LessonPage() {
  const { t } = useTranslation();
  const { planId, topicId } = useParams();
  useActiveTime(planId, topicId ?? null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [live, setLive] = useState("");
  const [livePassages, setLivePassages] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Wording | undefined>();
  const [reason, setReason] = useState("");
  const [flagOpen, setFlagOpen] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  const regenerate = useRef(false);
  const lesson = useQuery({
    queryKey: ["lesson", planId, topicId, chosen ?? null],
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
          planId: planId ?? "",
          topicId: topicId ?? "",
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
        return (await handle.result) as Awaited<
          ReturnType<typeof invoke<"study.lesson">>
        >;
      } finally {
        signal.removeEventListener("abort", handle.cancel);
        if (stop.current === handle.cancel) stop.current = null;
      }
    },
  });
  const flag = useMutation({
    mutationFn: (itemId: string) =>
      invoke("study.flag", { targetKind: "item", targetId: itemId, reason }),
    onSuccess: () => {
      setFlagOpen(false);
      setReason("");
      void client.invalidateQueries({ queryKey: ["progress", planId] });
    },
  });
  const cancelled =
    (lesson.error as { code?: string } | null)?.code === "aborted" ||
    (lesson.error as Error | null)?.name === "AbortError";
  const plan = useQuery({
    queryKey: ["plan", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.read", { planId: planId ?? "" }),
  });
  const node = (plan.data?.nodes ?? []).find(
    (item) =>
      item.kind === "learn" &&
      item.topicId === topicId &&
      item.state === "current",
  );
  const wording = chosen ?? lesson.data?.wording ?? "balanced";
  const itemId = lesson.data?.fallback ? undefined : lesson.data?.itemId;
  const flagged = flag.isSuccess && flag.variables === itemId;

  return (
    <FocusLayout
      title={t("lesson.title")}
      secondary={
        <Button
          type="text"
          shape="round"
          onClick={() => navigate(`/plans/${planId ?? ""}`)}
        >
          {t("nav.back")}
        </Button>
      }
    >
      <div className="gallery-row">
        <Segmented<Wording>
          aria-label={t("lesson.wording.label")}
          value={wording}
          onChange={setChosen}
          options={wordings.map((value) => ({
            value,
            label: t(`lesson.wording.${value}`),
          }))}
        />
        <Popconfirm
          icon={null}
          title={
            <section role="region" aria-label={t("lesson.regenerateConfirm")}>
              <p>{t("lesson.regenerateConfirm")}</p>
              <p className="small ink-muted">{t("lesson.regenerateNote")}</p>
            </section>
          }
          okText={t("lesson.regenerate")}
          cancelText={t("jobs.cancel")}
          disabled={lesson.isFetching}
          onConfirm={() => {
            regenerate.current = true;
            void lesson.refetch();
          }}
        >
          <Button
            shape="round"
            icon={<RefreshCw size={16} aria-hidden />}
            aria-label={t("lesson.regenerate")}
            disabled={lesson.isFetching}
          >
            {t("lesson.regenerate")}
          </Button>
        </Popconfirm>
        <Popover
          trigger="click"
          open={flagOpen}
          onOpenChange={(open) => setFlagOpen(open && Boolean(itemId))}
          content={
            <section role="region" aria-label={t("lesson.flagTitle")} style={{ display: "grid", gap: "0.5rem", width: "18rem" }}>
              <p className="body-strong">{t("lesson.flagTitle")}</p>
              <Input.TextArea
                value={reason}
                maxLength={500}
                rows={3}
                aria-label={t("lesson.flagReason")}
                placeholder={t("lesson.flagReason")}
                onChange={(event) => setReason(event.target.value)}
              />
              {flag.isError ? (
                <p className="meta" role="alert">
                  {t("lesson.flagFailed")}
                </p>
              ) : null}
              <Button
                shape="round"
                loading={flag.isPending}
                onClick={() => itemId && flag.mutate(itemId)}
              >
                {t("lesson.flagSend")}
              </Button>
            </section>
          }
        >
          <Button
            shape="round"
            icon={<Flag size={16} aria-hidden />}
            aria-label={t("lesson.flag")}
            disabled={!itemId || lesson.isFetching || flagged}
          >
            {flagged ? t("lesson.flagged") : t("lesson.flag")}
          </Button>
        </Popover>
        <Button
          shape="round"
          onClick={() =>
            navigate(`/plans/${planId ?? ""}/map/${topicId ?? ""}`)
          }
        >
          {t("map.title")}
        </Button>
        <ExportButton
          planId={planId ?? ""}
          topicId={topicId}
          kind="lesson"
          wording={wording}
          disabled={!lesson.data}
        />
      </div>
      {lesson.data?.general && !lesson.isFetching ? (
        <div>
          <Tag tone="general">{t("components.tags.general")}</Tag>{" "}
          <span className="meta">{t("lesson.generalNote")}</span>
        </div>
      ) : null}
      {lesson.isFetching ? (
        <div role="status">
          {t("lesson.writing")}{" "}
          <Button onClick={() => stop.current?.()}>{t("jobs.cancel")}</Button>
        </div>
      ) : null}
      {lesson.isError || lesson.data?.fallback ? (
        <Notice tone={cancelled ? "info" : "warning"}>
          {lesson.data?.fallback
            ? t("lesson.sourceFallback")
            : t(cancelled ? "lesson.cancelled" : "lesson.failed")}
          <Button onClick={() => void lesson.refetch()}>
            {t("lesson.retry")}
          </Button>
          {lesson.isError && !cancelled ? (
            <Button onClick={() => navigate("/settings/engines")}>
              {t("engines.title")}
            </Button>
          ) : null}
        </Notice>
      ) : null}
      <SelectionMenu planId={planId} onAsk={(chatId) => navigate(`/ask/${chatId}`)}>
      <article className="passage">
        <MarkdownView
          runnable
          onCitationClick={(number) => {
            const passageId = (
              lesson.isFetching || cancelled
                ? livePassages
                : lesson.data?.passageIds
            )?.[number - 1];
            if (passageId) openSourceViewer({ passageId });
          }}
        >
          {lesson.isFetching
            ? live || lesson.data?.markdown || ""
            : (lesson.data?.markdown ?? (cancelled ? live : ""))}
        </MarkdownView>
      </article>
      </SelectionMenu>
      {node ? (
        <Button
          type="primary"
          shape="round"
          onClick={() => {
            if (!planId) return;
            void invoke("plans.complete", { planId, nodeId: node.id }).then(
              () => {
                void client.invalidateQueries({ queryKey: ["plan", planId] });
                navigate(`/plans/${planId}`);
              },
            );
          }}
        >
          {t("lesson.done")}
        </Button>
      ) : null}
    </FocusLayout>
  );
}
