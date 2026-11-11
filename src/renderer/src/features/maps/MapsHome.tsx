import { keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Modal, Select } from "antd";
import { Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { MAP_INSTRUCTION_MAX, type MapAddress, type MapEntry } from "@shared/concept-map";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { LoadError } from "../../components/LoadError";
import { Notice } from "../../components/Notice";
import { SkeletonRows } from "../../components/Skeleton";
import { Tag } from "../../components/Tag";
import { invoke } from "../../lib/ipc";
import { MapThumb } from "./MapThumb";
import "./MapsHome.css";
import { planQuery, usePlans, useSubjects } from "../../lib/queries";
import { mapPath } from "./mapPath";
import { MenuButton, useItemMenu } from "../../components/ItemMenu";
import { forgetMaps, MapNameField, useMapActions } from "./MapActions";
import { focusAfterRemoval } from "./mapMenu";

/** What the map page hands over when the student deletes the map they were looking at: it leaves from its tile here. */
type Handover = {
  gone?: boolean;
  remove?: { mapId: string; title: string; subjectId?: string | null; planId?: string; topicId?: string };
};
/** The scope a tile's map belongs to: a topic of an exam, or a whole subject. */
function addressOf(map: Pick<MapEntry, "subjectId" | "planId" | "topicId">): MapAddress {
  return map.topicId ? { topicId: map.topicId, ...(map.planId ? { planId: map.planId } : {}) } : { subjectId: map.subjectId ?? "" };
}
/** An item removed shrinks in place, then the gap closes (docs/design-system/motion.md). */
const SHRINK_MS = 220;
const CLOSE_MS = 200;

/** The Maps section: every map, grouped by subject, with search and a way to start a new one. */
export function MapsHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  // An exam's page opens Maps at its subject (`?subject=<id>`), and with `new=1` at a new map of that subject.
  const [params, setParams] = useSearchParams();
  const atSubject = params.get("subject") ?? undefined;
  const [creating, setCreating] = useState(params.get("new") === "1");
  useEffect(() => {
    // Asked once: closing the dialog, or coming back to this page, does not open it again.
    if (params.has("new"))
      setParams(
        (next) => {
          next.delete("new");
          return next;
        },
        { replace: true },
      );
  }, []);

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
  const client = useQueryClient();
  const location = useLocation();
  const arrival = location.state as Handover | null;
  // A link to a map deleted since lands here and says so, until the student goes on.
  const [goneNotice] = useState(() => arrival?.gone === true);
  // Tiles on their way out: shrinking, then out of the list while the list is read again.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<string>();
  const [said, setSaid] = useState("");
  const page = useRef<HTMLDivElement>(null);
  // Where every tile was before one left, so the others glide into the gap rather than jump.
  const before = useRef<Map<string, DOMRect> | null>(null);
  const handed = useRef(false);

  const tiles = () => [...(page.current?.querySelectorAll<HTMLElement>("[data-map-id]") ?? [])];
  async function removeMap(map: { id: string; title: string } & Pick<MapEntry, "subjectId" | "planId" | "topicId">) {
    setFailed(undefined);
    try {
      await invoke("maps.delete", { ...addressOf(map), mapId: map.id });
    } catch {
      setFailed(map.id);
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const order = tiles().map((tile) => tile.dataset.mapId!);
    setLeaving((current) => new Set(current).add(map.id));
    setSaid(t("map.deleted", { title: map.title }));
    window.setTimeout(() => {
      before.current = reduced ? null : new Map(tiles().map((tile) => [tile.dataset.mapId!, tile.getBoundingClientRect()]));
      setRemoved((current) => new Set(current).add(map.id));
      const next = focusAfterRemoval(order, map.id);
      requestAnimationFrame(() => {
        const target = next
          ? page.current?.querySelector<HTMLElement>(`[data-map-id="${CSS.escape(next)}"] .px-maps-tile`)
          : page.current?.querySelector<HTMLElement>("button:not([disabled]), a[href], input");
        target?.focus({ preventScroll: true });
      });
      void forgetMaps(client);
    }, SHRINK_MS);
  }
  // The others move from where they were into the gap.
  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    if (!was) return;
    for (const tile of tiles()) {
      const from = was.get(tile.dataset.mapId!);
      const to = tile.getBoundingClientRect();
      if (!from || (from.left === to.left && from.top === to.top)) continue;
      tile.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: "none" }], {
        duration: CLOSE_MS,
        easing: "cubic-bezier(0.77, 0, 0.175, 1)",
      });
    }
  }, [removed]);

  const data = maps.data?.filter((map) => !removed.has(map.id));
  // The map page hands over the map the student deleted there, once its tile is on screen.
  useEffect(() => {
    const asked = arrival?.remove;
    if (arrival?.gone && !asked && !handed.current) {
      // The notice is in the page; a reload or Back does not show it again.
      handed.current = true;
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    }
    if (!asked || handed.current || !data) return;
    handed.current = true;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    const shown = data.find((map) => map.id === asked.mapId);
    void removeMap(
      shown ?? {
        id: asked.mapId,
        title: asked.title,
        subjectId: asked.subjectId ?? null,
        planId: asked.planId ?? null,
        topicId: asked.topicId ?? null,
      },
    );
  }, [data]);
  const dialog = (
    <NewMapDialog
      open={creating}
      initialSubject={atSubject}
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

  // The subject asked for comes into view with its heading focused, once its maps are on the page.
  const shownSubject = useRef<string | null>(null);
  useEffect(() => {
    if (!atSubject || !data || shownSubject.current === atSubject) return;
    const heading = document.getElementById(`px-maps-${atSubject}`);
    if (!heading) return;
    shownSubject.current = atSubject;
    heading.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }, [atSubject, data]);

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
                tabIndex={-1}
              >
                {group.subjectName ?? t("maps.noSubject")}
              </h2>
              <span className="small">
                {t("maps.count", { count: group.maps.length })}
              </span>
            </header>
            <ul className="px-maps-grid">
              {group.maps.map((map) => (
                <li
                  key={`${map.subjectId}-${map.planId}-${map.topicId}-${map.id}`}
                  data-map-id={map.id}
                  className={leaving.has(map.id) ? "is-leaving" : undefined}
                >
                  <MapCard
                    map={map}
                    failed={failed === map.id}
                    onDelete={() => void removeMap(map)}
                    onRenamed={(title) => setSaid(t("map.renamed", { title }))}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </>
    );

  return (
    <div className="px-maps" ref={page}>
      <h1 className="title-1">{t("maps.title")}</h1>
      {goneNotice ? <Notice tone="info">{t("map.gone")}</Notice> : null}
      <p className="visually-hidden" aria-live="polite">
        {said}
      </p>
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

/**
 * A map's tile: a small drawing of the map, its title and where it belongs. The whole tile opens the map. Its dots, on
 * the drawing's corner on hover and focus, and a right-click anywhere on it open the same menu; the tile keeps its hover
 * look while the menu is open. Rinomina edits the title in place.
 */
function MapCard({
  map,
  failed,
  onDelete,
  onRenamed,
}: {
  map: MapEntry;
  failed: boolean;
  onDelete: () => void;
  onRenamed: (title: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [dotsOpen, setDotsOpen] = useState(false);
  const link = useRef<HTMLAnchorElement>(null);
  // After a rename the tile takes the focus back, once it is a link again.
  const [linkFocus, setLinkFocus] = useState(false);
  useEffect(() => {
    if (!linkFocus || renaming) return;
    setLinkFocus(false);
    link.current?.focus({ preventScroll: true });
  }, [linkFocus, renaming]);
  const address = addressOf(map);
  const actions = useMapActions({
    address,
    mapId: map.id,
    title: map.title,
    state: { tile: true },
    onOpen: () => navigate(mapPath(map)),
    onRename: () => setRenaming(true),
    onDelete,
  });
  const menu = useItemMenu({ menu: actions.menu, region: t("map.more"), disabled: renaming });
  const caption = (
    <div className="px-maps-cap">
      {renaming ? (
        <MapNameField
          className="px-maps-name"
          address={address}
          mapId={map.id}
          value={map.title}
          onDone={(saved) => {
            setRenaming(false);
            setLinkFocus(true);
            if (saved) onRenamed(saved);
          }}
        />
      ) : (
        <h3 className="px-maps-card-title" title={map.title}>
          {map.title}
        </h3>
      )}
      {map.instruction ? (
        // Maps of one topic share a title, so what the student asked for tells them apart. One line, the rest on hover.
        <p className="px-maps-card-ask" title={map.instruction}>
          {t("maps.asked", { text: map.instruction })}
        </p>
      ) : null}
      <p className="px-maps-card-origin">
        {map.planTitle && map.topicTitle ? `${map.planTitle} · ${map.topicTitle}` : t("maps.wholeSubject")}
      </p>
      <p className="px-maps-card-meta">
        {t("maps.concepts", { count: map.nodeCount })}
        {map.grounding === "general" ? <Tag tone="general">{t("maps.general")}</Tag> : null}
      </p>
    </div>
  );
  const thumb = (
    <span className="px-maps-thumb">
      <MapThumb shape={map.shape} />
    </span>
  );
  return (
    <div className={`px-maps-tilew${dotsOpen || menu.open ? " is-ctx" : ""}`} {...menu.bind}>
      {renaming ? (
        // A field can't sit inside a link, so the tile stops being one while its name is edited.
        <div className="px-maps-tile is-renaming">
          {thumb}
          {caption}
        </div>
      ) : (
        <Link className="px-maps-tile" to={mapPath(map)} ref={link}>
          {thumb}
          {caption}
        </Link>
      )}
      {renaming ? null : (
        <MenuButton
          className="px-maps-dots"
          size="sm"
          menu={actions.menu}
          label={t("maps.actionsFor", { title: map.title })}
         
          onOpenChange={setDotsOpen}
        />
      )}
      {menu.popup}
      {failed ? (
        <p className="small px-maps-failed" role="alert">
          {t("map.deleteFailed")}
        </p>
      ) : null}
    </div>
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
  /** The subject chosen when the dialog opens, such as the exam's subject it was opened for. */
  initialSubject?: string;
  subjects: Array<{ id: string; name: string }>;
  plans: Array<{ id: string; title: string; subject: string | null; archived: boolean }>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [subjectId, setSubjectId] = useState<string | undefined>(props.open ? props.initialSubject : undefined);
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
    } else if (props.initialSubject) setSubjectId(props.initialSubject);
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
  // An exam whose read failed has no topics here, so the subject is not taken for one without topics, or its list for
  // complete, until the read works.
  const topicsFailed = Boolean(subjectId) && read.some((query) => query.isError);
  const hasTopics =
    Boolean(subjectId) && !topicsFailed && !read.some((query) => query.isPending) && topicGroups.length > 0;
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
      okButtonProps={{ disabled: !subjectId || topicsFailed }}
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
        {topicsFailed ? (
          <LoadError
            onRetry={() => {
              for (const query of read) if (query.isError) void query.refetch();
            }}
          >
            {t("maps.topicsFailed", { subject: subject?.name ?? "" })}
          </LoadError>
        ) : null}
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
