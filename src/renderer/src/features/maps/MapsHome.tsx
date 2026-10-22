import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button, Input, Modal, Select } from "antd";
import { GraduationCap, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import type { MapEntry } from "@shared/concept-map";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { Notice } from "../../components/Notice";
import { Tag } from "../../components/Tag";
import { invoke } from "../../lib/ipc";
import "./MapsHome.css";
import { usePlan, usePlans } from "../../lib/queries";

/** Where a map opens full screen; its close button comes back here. */
export const mapPath = (map: {
  planId: string;
  topicId: string;
  id?: string;
}) =>
  `/plans/${map.planId}/map/${map.topicId}?from=maps${map.id ? `&map=${encodeURIComponent(map.id)}` : ""}`;

/** The Maps section: every map of every exam, grouped by subject, with search and a way to start a new one. */
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

  const data = maps.data;
  const dialog = (
    <NewMapDialog
      open={creating}
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
  if (maps.isError && !data)
    body = (
      <Notice
        tone="danger"
        action={{ label: t("maps.retry"), onClick: () => void maps.refetch() }}
      >
        {t("maps.loadFailed")}
      </Notice>
    );
  // Nothing shows until the lists arrive, so the empty state never flashes first.
  else if (!data || plans.isPending) body = null;
  else if (data.length === 0 && !query)
    body =
      (plans.data?.length ?? 0) > 0 ? (
        <EmptyState
          title={t("maps.emptyTitle")}
          body={t("maps.emptyBody")}
          action={newMap}
        />
      ) : (
        <EmptyState
          title={t("maps.emptyTitle")}
          body={t("maps.emptyNoExams")}
          action={
            <Button
              type="primary"
              shape="round"
              onClick={() => navigate("/plans/new")}
            >
              {t("exams.newPlan")}
            </Button>
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
                <li key={`${map.planId}-${map.topicId}-${map.id}`}>
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

function MapCard({ map }: { map: MapEntry }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <article className="px-card px-maps-card">
      <div className="px-maps-card-top">
        <h3 className="px-maps-card-title">{map.title}</h3>
        <p className="small px-maps-card-origin">
          <Link
            to={`/plans/${map.planId}`}
            aria-label={t("map.openExam", { title: map.planTitle })}
          >
            <GraduationCap size={14} strokeWidth={1.75} aria-hidden />
            <span>{map.planTitle}</span>
          </Link>
          {/* The dot stays with the topic when the line wraps. */}
          <span>
            <span aria-hidden>· </span>
            {map.topicTitle}
          </span>
        </p>
      </div>
      <div className="px-maps-card-foot">
        <span className="px-maps-card-meta">
          {t("maps.concepts", { count: map.nodeCount })}
          {map.grounding === "general" ? (
            <Tag tone="general">{t("maps.general")}</Tag>
          ) : null}
        </span>
        <Button
          shape="round"
          size="small"
          aria-label={t("maps.openLabel", { title: map.title })}
          onClick={() => navigate(mapPath(map))}
        >
          {t("maps.open")}
        </Button>
      </div>
    </article>
  );
}

/** Picks the exam and topic a new map belongs to, then opens that topic's map page, where the maps are built. */
function NewMapDialog(props: {
  open: boolean;
  plans: Array<{ id: string; title: string; subject: string | null }>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [planId, setPlanId] = useState<string>();
  const [topicId, setTopicId] = useState<string>();
  const plan = usePlan(planId, props.open);
  // How many maps each topic holds already, so the student sees which topics are mapped.
  const existing = useQuery({
    queryKey: ["maps-all", ""],
    enabled: props.open,
    queryFn: () => invoke("maps.all", {}),
  });
  useEffect(() => {
    if (!props.open) {
      setPlanId(undefined);
      setTopicId(undefined);
    }
  }, [props.open]);

  const examGroups: Array<{
    label: string;
    options: Array<{ value: string; label: string }>;
  }> = [];
  for (const item of props.plans) {
    const label = item.subject ?? t("maps.noSubject");
    let group = examGroups.find((entry) => entry.label === label);
    if (!group) {
      group = { label, options: [] };
      examGroups.push(group);
    }
    group.options.push({ value: item.id, label: item.title });
  }
  const topics = plan.data?.topics ?? [];
  const counts = new Map<string, number>();
  for (const map of existing.data ?? [])
    if (map.planId === planId)
      counts.set(map.topicId, (counts.get(map.topicId) ?? 0) + 1);

  return (
    <Modal
      open={props.open}
      title={t("maps.new")}
      onCancel={props.onClose}
      okText={t("maps.continue")}
      cancelText={t("maps.cancel")}
      okButtonProps={{ disabled: !planId || !topicId }}
      onOk={() => {
        if (!planId || !topicId) return;
        props.onClose();
        navigate(mapPath({ planId, topicId }));
      }}
      destroyOnHidden
    >
      <p className="small px-maps-new-lead">{t("maps.newBody")}</p>
      <div className="px-maps-new-fields">
        <div className="px-form-field">
          <label className="label" htmlFor="new-map-exam">
            {t("maps.exam")}
          </label>
          <Select
            id="new-map-exam"
            placeholder={t("maps.pickExam")}
            value={planId}
            onChange={(value) => {
              setPlanId(value);
              setTopicId(undefined);
            }}
            options={examGroups}
          />
        </div>
        <div className="px-form-field">
          <label className="label" htmlFor="new-map-topic">
            {t("maps.topic")}
          </label>
          <Select
            id="new-map-topic"
            placeholder={t("maps.pickTopic")}
            value={topicId}
            disabled={!planId || plan.isPending}
            loading={Boolean(planId) && plan.isPending}
            onChange={setTopicId}
            options={topics.map((topic) => ({
              value: topic.id,
              label: counts.get(topic.id)
                ? t("maps.topicMaps", {
                    topic: topic.title,
                    count: counts.get(topic.id),
                  })
                : topic.title,
            }))}
          />
          {planId && plan.data && topics.length === 0 ? (
            <p className="small px-maps-new-note">{t("maps.noTopics")}</p>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
