import { useEffect } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { LegacyLessonPage } from "./LegacyLessonPage";
import { PartLoading, PartPage, partKey, usePartQuery } from "./PartPage";

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
  // Opened without a part, core picks the first one not done. The address then names that part, so finishing it
  // does not move the page on to the next one when the part is read again.
  const opened = query.data?.mode === "parts" && !position && !itemId ? query.data.position : null;
  useEffect(() => {
    if (opened) navigate(`/plans/${planId}/lesson/${topicId}?part=${opened}`, { replace: true });
  }, [opened, planId, topicId, navigate]);
  if (query.data?.mode === "parts")
    return (
      <PartPage
        planId={planId}
        topicId={topicId}
        data={query.data}
        query={query}
        queryKey={partKey(planId, topicId, position, itemId)}
      />
    );
  if (query.data?.mode === "legacy" || query.isError) return <LegacyLessonPage />;
  return <PartLoading planId={planId} topicId={topicId} />;
}
