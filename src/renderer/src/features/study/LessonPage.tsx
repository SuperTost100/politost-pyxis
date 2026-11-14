import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { usePlace, type BackTarget } from "../../app/usePlace";
import { useEngineError } from "../../lib/engineError";
import { invoke } from "../../lib/ipc";
import { usePlan } from "../../lib/queries";
import { useStillHere } from "../../lib/useStillHere";
import { jobErrorEngine, jobErrorKey } from "../jobs/jobErrors";
import { LegacyLessonPage } from "./LegacyLessonPage";
import { PartLoading, PartPage, partKey, usePartQuery } from "./PartPage";
import { addressPart, freshRead, oldLessonView, stoppedTone, type PartData } from "./partPage";

/**
 * A topic's lesson: in parts (`PartPage`) for a topic planned in parts, never read, or with an unfinished lesson written
 * before parts, which is rewritten in parts; in the reader that came before parts (`LegacyLessonPage`) for a finished
 * lesson written before them, as `study.part` decides. `?part=3` opens that part, `?item=` a saved lesson from a
 * finished step. A read that fails leaves the page to the earlier reader, which shows its own error.
 */
export function LessonPage() {
  const { planId = "", topicId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const asked = Number(searchParams.get("part"));
  const position = Number.isInteger(asked) && asked >= 1 ? asked : undefined;
  const itemId = searchParams.get("item") ?? undefined;
  const query = usePartQuery(planId, topicId, position, itemId);
  // When the page came to this address: only a read made since then decides for it.
  const address = `${planId}/${topicId}/${position ?? ""}/${itemId ?? ""}`;
  const came = useRef({ address, at: Date.now() });
  if (came.current.address !== address) came.current = { address, at: Date.now() };
  const fresh = freshRead(
    { fetching: query.isFetching, placeholder: query.isPlaceholderData, updatedAt: query.dataUpdatedAt },
    came.current.at,
  );
  // Opened without a part, core picks the first one not done, and the address then names it (`addressPart`). Until a
  // fresh read has chosen, what is cached names a part that may be done by now, or the part from before a finished
  // lesson's rewrite stopped, so the page waits for it. The read can come back after the student has left, while the
  // next page is still being drawn or loaded: the address is then no longer this page's to name.
  const opened = addressPart(query.data, { position, itemId }, fresh);
  const stillHere = useStillHere();
  // Every state of the lesson has the same way back, and the page goes by its topic elsewhere.
  const plan = usePlan(planId);
  const topic = plan.data?.topics.find((item) => item.id === topicId)?.title;
  const back = usePlace({
    name: topic ? { text: topic } : null,
    parent: plan.data ? { name: { text: plan.data.title } } : undefined,
  });
  useEffect(() => {
    if (opened && stillHere()) navigate(`/plans/${planId}/lesson/${topicId}?part=${opened}`, { replace: true });
  }, [opened, planId, topicId, navigate, stillHere]);
  const choosing = !position && !itemId && !fresh && !query.isError;
  const key = partKey(planId, topicId, position, itemId);
  if (query.data?.mode === "parts" && !choosing && query.data.replaces && oldLessonView(query.data) === "fallback")
    return <RewriteFallback planId={planId} topicId={topicId} data={query.data} queryKey={key} back={back} />;
  if (query.data?.mode === "parts" && !choosing)
    return <PartPage planId={planId} topicId={topicId} data={query.data} query={query} queryKey={key} back={back} />;
  if ((query.data?.mode === "legacy" && !choosing) || query.isError)
    // The reader notes the lesson it was opened on when it mounts, so another item of the topic is a reader of its own.
    // The page's place on the trail and its way back stay with LessonPage, which a new reader does not remount.
    return <LegacyLessonPage key={itemId ?? ""} old={query.data?.mode === "legacy" ? query.data.old : undefined} back={back} />;
  return <PartLoading planId={planId} topicId={topicId} back={back} />;
}

/**
 * A rewrite in parts that did not finish before any part was written: the old lesson as it was, in its own reader and
 * still the student's to answer and finish, under a notice that says what happened, with Riprova and the engine's own
 * fix when an engine failed.
 */
function RewriteFallback({
  planId,
  topicId,
  data,
  queryKey,
  back,
}: {
  planId: string;
  topicId: string;
  data: PartData;
  queryKey: readonly unknown[];
  back: BackTarget | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const describeEngineError = useEngineError();
  const retry = useMutation({
    mutationFn: () => invoke("study.part", { planId, topicId, position: data.position, write: true }),
    onSuccess: (next) => {
      client.setQueryData(queryKey, next);
      void client.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
  const error = data.error ?? "";
  const key = error ? jobErrorKey(error) : null;
  const engine = key && key.startsWith("engines.errors.") ? describeEngineError(key, jobErrorEngine(error)) : undefined;
  return (
    <LegacyLessonPage
      key={data.replaces!.itemId}
      back={back}
      itemId={data.replaces!.itemId}
      notice={{
        text: engine ? `${t("lesson.oldRewriteFailed")} ${engine.text}` : t("lesson.oldRewriteFailed"),
        tone: stoppedTone(error),
        action: { label: t("lesson.partRetry"), onClick: () => retry.mutate(), disabled: retry.isPending },
        secondary:
          engine?.action ??
          (key?.startsWith("engines.errors.") ? { label: t("engines.title"), onClick: () => navigate("/settings/engines") } : undefined),
        details: error || undefined,
      }}
    />
  );
}
