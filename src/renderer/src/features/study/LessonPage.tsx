import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useEngineError } from "../../lib/engineError";
import { invoke } from "../../lib/ipc";
import { jobErrorEngine, jobErrorKey } from "../jobs/jobErrors";
import { LegacyLessonPage } from "./LegacyLessonPage";
import { PartLoading, PartPage, partKey, usePartQuery } from "./PartPage";
import { oldLessonView, type PartData } from "./partPage";

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
  // Opened without a part, core picks the first one not done. The address then names that part, so finishing it
  // does not move the page on to the next one when the part is read again. Only a read of this address that is not
  // being made again names it: what shows while it loads is the part the page came from, or an earlier read of the
  // address, from before a finished lesson's rewrite stopped.
  const opened = query.data?.mode === "parts" && !query.isFetching && !position && !itemId ? query.data.position : null;
  useEffect(() => {
    if (opened) navigate(`/plans/${planId}/lesson/${topicId}?part=${opened}`, { replace: true });
  }, [opened, planId, topicId, navigate]);
  const key = partKey(planId, topicId, position, itemId);
  if (query.data?.mode === "parts" && query.data.replaces && oldLessonView(query.data) === "fallback")
    return <RewriteFallback planId={planId} topicId={topicId} data={query.data} queryKey={key} />;
  if (query.data?.mode === "parts")
    return <PartPage planId={planId} topicId={topicId} data={query.data} query={query} queryKey={key} />;
  if (query.data?.mode === "legacy" || query.isError)
    return <LegacyLessonPage old={query.data?.mode === "legacy" ? query.data.old : undefined} />;
  return <PartLoading planId={planId} topicId={topicId} />;
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
}: {
  planId: string;
  topicId: string;
  data: PartData;
  queryKey: readonly unknown[];
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
      itemId={data.replaces!.itemId}
      notice={{
        text: engine ? `${t("lesson.oldRewriteFailed")} ${engine.text}` : t("lesson.oldRewriteFailed"),
        action: { label: t("lesson.partRetry"), onClick: () => retry.mutate(), disabled: retry.isPending },
        secondary:
          engine?.action ??
          (key?.startsWith("engines.errors.") ? { label: t("engines.title"), onClick: () => navigate("/settings/engines") } : undefined),
        details: error || undefined,
      }}
    />
  );
}
