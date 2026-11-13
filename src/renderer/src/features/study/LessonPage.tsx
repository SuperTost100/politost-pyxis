import { useEffect, useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { LegacyLessonPage } from "./LegacyLessonPage";
import { PartLoading, PartPage, partKey, usePartQuery } from "./PartPage";
import { addressPart, freshRead } from "./partPage";

/**
 * A topic's lesson: in parts (`PartPage`) for a topic planned in parts or never read, and in the reader that came
 * before parts (`LegacyLessonPage`) for a lesson written before them, as `study.part` decides. `?part=3` opens that
 * part, `?item=` a saved lesson from a finished step. A read that fails leaves the page to the earlier reader, which
 * shows its own error.
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
  // fresh read has chosen, what is cached names a part that may be done by now, so the page waits for it.
  const opened = addressPart(query.data, { position, itemId }, fresh);
  useEffect(() => {
    if (opened) navigate(`/plans/${planId}/lesson/${topicId}?part=${opened}`, { replace: true });
  }, [opened, planId, topicId, navigate]);
  const choosing = !position && !itemId && !fresh && !query.isError;
  if (query.data?.mode === "parts" && !choosing)
    return (
      <PartPage
        planId={planId}
        topicId={topicId}
        data={query.data}
        query={query}
        queryKey={partKey(planId, topicId, position, itemId)}
      />
    );
  if ((query.data?.mode === "legacy" && !choosing) || query.isError) return <LegacyLessonPage />;
  return <PartLoading planId={planId} topicId={topicId} />;
}
