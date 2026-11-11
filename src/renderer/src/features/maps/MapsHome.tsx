import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { Button, Input, Modal, Select } from "antd";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { MAP_INSTRUCTION_MAX, type MapEntry } from "@shared/concept-map";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { Notice } from "../../components/Notice";
import { SkeletonRows } from "../../components/Skeleton";
import { Tag } from "../../components/Tag";
import { invoke } from "../../lib/ipc";
import { MapThumb } from "./MapThumb";
import "./MapsHome.css";
import { planQuery, usePlans, useSubjects } from "../../lib/queries";
import { mapPath } from "./mapPath";

/** The Maps section: every map, grouped by subject, with search and a way to start a new one. */
export function MapsHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  // The search waits for a pause in typing.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [text]);

  const maps = useQuery({
    queryKey: ["maps-all", query],
    queryFn: () => invoke("maps.all", query ? { query } : {}),
    placeholderData: keepPreviousData,
  });
  const plans = usePlans();
  const subjects = useSubjects();

  const data = maps.data;
  const dialog = (
    <NewMapDialog
      open={creating}
      subjects={subjects.data ?? []}
      plans={plans.data ?? []}
      onClose={() => setCreating(false)}
    />
  );
  const newMap = (
    <Button type="primary" shape="round" onClick={() => setCreating(true)}>
      {t("maps.new")}
    </Button>
  );

  let body;
  // Without the subjects the empty state and the new-map dialog would be wrong, so their failure shows like the maps'.
  if ((maps.isError && !data) || (subjects.isError && !subjects.data))
    body = (
      <Notice
        tone="danger"
        action={{
          label: t("maps.retry"),
          onClick: () => void Promise.all([maps.refetch(), subjects.refetch()]),
        }}
      >
        {t("maps.loadFailed")}
      </Notice>
    );
  // A skeleton until the lists arrive, so the empty state never flashes first.
  else if (!data || subjects.isPending) body = <SkeletonRows label={t("components.loading")} />;
  else if (data.length === 0 && !query)
    body =
      (subjects.data?.length ?? 0) > 0 ? (
        <EmptyState
          title={t("maps.emptyTitle")}
          body={t("maps.emptyBody")}
          action={newMap}
        />
      ) : (
        // A map needs a subject's material, so without any subject the ways to add some come first.
        <EmptyState
          title={t("maps.emptyTitle")}
          body={t("maps.emptyNoSubjects")}
          action={
            <Button
              type="primary"
              shape="round"
              onClick={() => navigate("/onboarding?again=1&step=material&from=maps")}
            >
              {t("maps.linkFolder")}
            </Button>
          }
          secondary={
            <>
              <Button shape="round" onClick={() => navigate("/exams/library")}>
                {t("maps.openLibrary")}
              </Button>
              <Button shape="round" onClick={() => navigate("/plans/new")}>
                {t("exams.newPlan")}
              </Button>
            </>
          }
        />
      );
  else
    body = (
      <>
        <div className="px-maps-toolbar">
          <Input
            aria-label={t("maps.search")}
            prefix={<Search size={16} strokeWidth={1.75} aria-hidden />}
            placeholder={t("maps.searchPlaceholder")}
            allowClear
            maxLength={200}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {newMap}
        </div>
        <p className="small px-maps-summary" role="status">
          {data.length === 0
            ? t("maps.noMatch")
            : t("maps.count", { count: data.length })}
        </p>
        {groups(data).map((group) => (
          <section
            key={group.subjectId ?? "none"}
            className="px-maps-subject"
            aria-labelledby={`px-maps-${group.subjectId ?? "none"}`}
          >
            <header>
              <h2
                className="title-3"
                id={`px-maps-${group.subjectId ?? "none"}`}
              >
                {group.subjectName ?? t("maps.noSubject")}
              </h2>
              <span className="small">
                {t("maps.count", { count: group.maps.length })}
              </span>
            </header>
            <ul className="px-maps-grid">
              {group.maps.map((map) => (
                <li key={`${map.subjectId}-${map.planId}-${map.topicId}-${map.id}`}>
                  <MapCard map={map} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </>
    );

  return (
    <div className="px-maps">
      <h1 className="title-1">{t("maps.title")}</h1>
      {body}
      {dialog}
    </div>
  );
}

/** The list arrives in subject order, so a new group starts wherever the subject changes. */
function groups(maps: MapEntry[]) {
  const result: Array<{
    subjectId: string | null;
    subjectName: string | null;
    maps: MapEntry[];
  }> = [];
  for (const map of maps) {
    let group = result.at(-1);
    if (!group || group.subjectId !== map.subjectId) {
      group = {
        subjectId: map.subjectId,
        subjectName: map.subjectName,
        maps: [],
      };
      result.push(group);
    }
    group.maps.push(map);
  }
  return result;
}

/** A map's tile: a small drawing of the map, its title and where it belongs. The whole tile opens the map. */
function MapCard({ map }: { map: MapEntry }) {
  const { t } = useTranslation();
  return (
    <Link className="px-maps-tile" to={mapPath(map)}>
      <span className="px-maps-thumb">
        <MapThumb shape={map.shape} />
      </span>
      <div className="px-maps-cap">
        <h3 className="px-maps-card-title">{map.title}</h3>
        {map.instruction ? (
          // Maps of one topic share a title, so what the student asked for tells them apart. One line, the rest on hover.
          <p className="px-maps-card-ask" title={map.instruction}>
            {t("maps.asked", { text: map.instruction })}
          </p>
        ) : null}
        <p className="px-maps-card-origin">
          {map.planTitle && map.topicTitle
            ? `${map.planTitle} · ${map.topicTitle}`
            : t("maps.wholeSubject")}
        </p>
        <p className="px-maps-card-meta">
          {t("maps.concepts", { count: map.nodeCount })}
          {map.grounding === "general" ? <Tag tone="general">{t("maps.general")}</Tag> : null}
        </p>
      </div>
    </Link>
  );
}

/** The topic select's value for the whole subject, which no topic ID can be. */
const WHOLE = "";

/**
 * Picks the subject a new map belongs to and, when its exams have topics, one of them (the default is the whole
 * subject), and lets the student say how they want the map. Confirming opens the map page, which builds the map at once.
 * A subject or topic that has a map already opens that map, unless the student said how they want this one: that asks
 * for a new map.
 */
function NewMapDialog(props: {
  open: boolean;
  subjects: Array<{ id: string; name: string }>;
  plans: Array<{ id: string; title: string; subject: string | null; archived: boolean }>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [subjectId, setSubjectId] = useState<string>();
  const [topicId, setTopicId] = useState<string>();
  const [instruction, setInstruction] = useState("");
  const subject = props.subjects.find((item) => item.id === subjectId);
  // The subject's exams, matched by name as the exam list names them; subject names are unique regardless of case.
  const exams = subject
    ? props.plans.filter(
        (plan) => !plan.archived && plan.subject?.toLocaleLowerCase() === subject.name.toLocaleLowerCase(),
      )
    : [];
  const read = useQueries({
    queries: exams.map((plan) => ({ ...planQuery(plan.id), enabled: props.open })),
  });
  // How many maps each topic and subject holds already, so the student sees what is mapped.
  const existing = useQuery({
    queryKey: ["maps-all", ""],
    enabled: props.open,
    queryFn: () => invoke("maps.all", {}),
  });
  useEffect(() => {
    if (!props.open) {
      setSubjectId(undefined);
      setTopicId(undefined);
      setInstruction("");
    }
  }, [props.open]);

  // Topics by id; a whole subject's maps by the subject's id.
  const counts = new Map<string, number>();
  for (const map of existing.data ?? []) {
    const key = map.topicId ?? map.subjectId;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const label = (title: string, key: string) =>
    counts.get(key) ? t("maps.topicMaps", { topic: title, count: counts.get(key) }) : title;
  const topicGroups = exams.flatMap((plan, index) => {
    const topics = read[index]?.data?.topics ?? [];
    return topics.length
      ? [
          {
            label: plan.title,
            options: topics.map((topic) => ({ value: topic.id, label: label(topic.title, topic.id) })),
          },
        ]
      : [];
  });
  // The topic select is there only for a subject whose exams have topics, and folds out of the subject select when
  // they are known. It stays mounted, so that it folds back in too; it keeps its last options while it does.
  const hasTopics = Boolean(subjectId) && !read.some((query) => query.isPending) && topicGroups.length > 0;
  const shownGroups = useRef(topicGroups);
  if (hasTopics) shownGroups.current = topicGroups;
  const wholeLabel = subjectId ? label(t("maps.wholeSubject"), subjectId) : t("maps.wholeSubject");
  const asked = instruction.trim();

  return (
    <Modal
      open={props.open}
      title={t("maps.new")}
      onCancel={props.onClose}
      okText={t("maps.create")}
      cancelText={t("maps.cancel")}
      okButtonProps={{ disabled: !subjectId }}
      onOk={() => {
        if (!subjectId) return;
        props.onClose();
        // A subject or topic that is mapped already opens its map, unless the student asked for a different one; the
        // page checks again before it builds.
        navigate(mapPath({ subjectId, topicId }), {
          state: asked || !counts.get(topicId ?? subjectId) ? { build: true, instruction: asked } : null,
        });
      }}
      destroyOnHidden
    >
      <div className="px-maps-new-fields">
        <div className="px-maps-new-block px-form-field">
          <label className="label" htmlFor="new-map-subject">
            {t("maps.subject")}
          </label>
          <Select
            id="new-map-subject"
            placeholder={t("maps.pickSubject")}
            value={subjectId}
            onChange={(value) => {
              setSubjectId(value);
              setTopicId(undefined);
            }}
            options={props.subjects.map((item) => ({
              value: item.id,
              label: label(item.name, item.id),
            }))}
          />
        </div>
        <div className="px-maps-coll" data-shut={!hasTopics || undefined} inert={!hasTopics}>
          <div>
            <div className="px-maps-new-block px-form-field">
              <label className="label" htmlFor="new-map-topic">
                {t("maps.topic")}
              </label>
              <Select
                id="new-map-topic"
                value={topicId ?? WHOLE}
                onChange={(value) => setTopicId(value || undefined)}
                options={[{ value: WHOLE, label: wholeLabel }, ...shownGroups.current]}
              />
            </div>
          </div>
        </div>
        <div className="px-maps-new-block px-form-field">
          <label className="label" htmlFor="new-map-instruction">
            {t("maps.instruction")} <span className="px-maps-optional">{t("maps.optional")}</span>
          </label>
          <Input.TextArea
            id="new-map-instruction"
            value={instruction}
            maxLength={MAP_INSTRUCTION_MAX}
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder={t("maps.instructionPlaceholder")}
            onChange={(event) => setInstruction(event.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}
