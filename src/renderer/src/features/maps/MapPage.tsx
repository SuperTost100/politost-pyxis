import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input, Modal, Select, type MenuProps } from "antd";
import { ChevronLeft, ChevronRight, GraduationCap, Library } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Link as RouterLink,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import {
  ReactFlow,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  applyNodeChanges,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import { toPng } from "html-to-image";
import { BackLink } from "../../components/BackLink";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Icon } from "../../components/Icon";
import { MenuButton, useItemMenu } from "../../components/ItemMenu";
import { Segmented } from "../../components/Controls";
import { LoadError } from "../../components/LoadError";
import { Working } from "../../components/Working";
import { MarkdownView } from "../../components/MarkdownView";
import { openMakeCards } from "../../components/MakeCardsDialog";
import { MathText } from "../../components/math/MathText";
import { invoke } from "../../lib/ipc";
import { MAP_INSTRUCTION_MAX, mapColors as fills, type MapAddress, type MapOp } from "@shared/concept-map";
import "@xyflow/react/dist/style.css";
import {
  NODE_MIN_HEIGHT,
  NODE_WIDTH,
  initialCollapsed,
  layoutTree,
  parentIds,
  startViewport,
  revealViewport,
  visibleNodes,
} from "./mapLayout";
import { describeChange } from "./mapChange";
import { MapNameField, useMapActions } from "./MapActions";
import { requestName } from "./mapMenu";
import { useNodeSources, type NodeSource } from "./nodeSources";
import { useSourceView } from "../../components/SourceViewer";
import "./MapPage.css";

type FlowNode = Node<
  {
    label: string;
    /** A fill the student picked, as a token name or a hex colour; none keeps the plain node. */
    color?: string;
    /** 0 for the root, 1 for its branches, 2 for anything deeper. */
    level: 0 | 1 | 2;
    folded: boolean;
    hidden: number;
    hasChildren: boolean;
    toggle: (id: string) => void;
    /** Sliding back into the node that was folded, on its way out. */
    leaving?: boolean;
  },
  "concept"
>;
/** How long a fold or an unfold moves the map. */
const MOTION_MS = 300;
type FlowEdge = Edge<{ label?: string; active: boolean }, "cross">;
function ConceptNode({ id, data }: NodeProps<FlowNode>) {
  const { t } = useTranslation();
  const Chevron = data.folded ? ChevronRight : ChevronLeft;
  return (
    <div
      className={`px-concept-node is-level-${data.level}`}
      style={
        data.color
          ? ({
              "--node-fill": data.color.startsWith("#")
                ? data.color
                : `var(--${data.color})`,
            } as CSSProperties)
          : undefined
      }
    >
      <Handle id="in-l" type="target" position={Position.Left} />
      <Handle id="in-r" type="target" position={Position.Right} />
      <MarkdownView variant="body">{data.label}</MarkdownView>
      <Handle id="out-r" type="source" position={Position.Right} />
      <Handle id="out-l" type="source" position={Position.Left} />
      {data.hasChildren && (
        <button
          type="button"
          className="px-concept-fold nodrag nopan"
          aria-expanded={!data.folded}
          aria-label={
            data.folded
              ? t("map.expand", { count: data.hidden })
              : t("map.collapse")
          }
          onClick={(event) => {
            event.stopPropagation();
            data.toggle(id);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <Chevron size={14} aria-hidden />
          {data.folded && <span>{data.hidden}</span>}
        </button>
      )}
    </div>
  );
}
// A relation outside the hierarchy: quiet and dashed, its label only on hover or when an end is selected.
function CrossEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
}: EdgeProps<FlowEdge>) {
  const [hover, setHover] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const lit = hover || Boolean(data?.active);
  return (
    <g
      className={`px-cross-edge${lit ? " is-lit" : ""}`}
      style={style?.opacity === undefined ? undefined : { opacity: style.opacity }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <BaseEdge path={path} interactionWidth={20} />
      {data?.label && lit && (
        <EdgeLabelRenderer>
          <div
            className="px-cross-label nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              // The label sits outside the edge's group, so it fades with the connector here.
              opacity: style?.opacity,
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}
const nodeTypes = { concept: ConceptNode };
const edgeTypes = { cross: CrossEdge };

export function MapPage() {
  const { t } = useTranslation();
  // `/maps/:subjectId/:topicId?` names a subject and maybe one of its topics; `/plans/:planId/map/:topicId`, the older
  // address, a topic of an exam. Core reads either as the same map.
  const params = useParams();
  const address = useMemo<MapAddress>(
    () =>
      params.topicId
        ? { topicId: params.topicId, ...(params.planId ? { planId: params.planId } : {}) }
        : { subjectId: params.subjectId ?? "" },
    [params.subjectId, params.planId, params.topicId],
  );
  const scopeKey = params.topicId ?? `subject:${params.subjectId ?? ""}`;
  // The Maps section opens one map by id and expects its close button to lead back there.
  const [search, setSearch] = useSearchParams();
  const openMap = search.get("map") ?? undefined;
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  const [selected, setSelected] = useState<string>();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [jobId, setJobId] = useState<string>();
  // The Nuova mappa dialog opens this page with `build` set, so the map is built without a second click. It waits for
  // the page to know the scope has no map and no build, then starts one; the working mark shows meanwhile.
  const arrival = location.state as { build?: boolean; instruction?: string; job?: string } | null;
  const [starting, setStarting] = useState(() => arrival?.build === true);
  const wanted = useRef(arrival?.instruction?.trim() ?? "");
  // Attività's "Cambia la richiesta" opens this page with `job` set to the request whose row was pressed, since a scope can
  // have several requests that found nothing. The page shows that request for as long as this history entry says so:
  // a reload or Back and Forward come back to it, and anything the student does on the page (another map, a new request)
  // takes `job` out of the entry. A request whose job is gone leaves it too.
  // A request that found nothing on this page stays the same way, in `kept`, until the student changes it or chooses a map.
  // A request chosen by navigation wins over the kept one, which stands only when none arrived that way.
  const [kept, setKept] = useState<string>();
  const reviewed = jobId ? undefined : (arrival?.job ?? kept);
  const leaveRequest = () => {
    setKept(undefined);
    if (arrival?.job) navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  };
  // A map the student asked for in their own words is built next to the maps the scope has. Until it is, the page shows
  // its working state in place of those.
  const [fresh, setFresh] = useState(false);
  const buildAsked = useRef(false);
  const [dialog, setDialog] = useState<"add" | "rename" | "connect" | null>(
    null,
  );
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState<string>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The last change the AI made, for the line under the map with its Annulla. Any other edit replaces what Annulla
  // would undo, so it clears this.
  const [editing, setEditing] = useState(false);
  const [lastChange, setLastChange] = useState<{
    mapId?: string;
    text: string;
  }>();
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // Unfolding or folding a node moves the map in one motion instead of a cut: children slide out of the node they hang
  // from, or back into it, and the others move to their new places. `motion` holds where that node is and the frame.
  // `map` is the map the fold happened on, so switching maps mid-move cuts to the new one.
  const motion = useRef<{ origin?: string; map?: string; frame: number }>({ frame: 0 });
  // The branch that was just unfolded, until the view has been moved to show it.
  const reveal = useRef<{ id: string; map?: string } | undefined>(undefined);
  // Real node heights, measured by React Flow, so the layout can leave room for long labels.
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  // Their widths too, which only the fold's motion needs: a branch grows out of its node's right edge.
  const widths = useRef(new Map<string, number>());
  const [ready, setReady] = useState<string>();
  const [fold, setFold] = useState<{ mapId?: string; ids: Set<string> }>({
    ids: new Set(),
  });
  const viewed = useRef("");
  const flow = useRef<ReactFlowInstance<FlowNode> | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const moves = useRef<Promise<unknown>>(Promise.resolve());
  const listKey = ["maps", scopeKey];
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => invoke("maps.list", address),
    refetchInterval: jobId ? 500 : false,
  });
  // The page reads the build it waits for by its job: `maps.generate` returns the job it started or resumed, which is not
  // always the scope's newest build (a retried request has older jobs than a build the student asked for since). Without
  // one, as when the page is opened with no request, it reads the scope's newest build.
  const buildKey = (id?: string) => ["map-build", scopeKey, id ?? "newest"];
  const readBuild = (id?: string) => invoke("maps.build", id ? { ...address, jobId: id } : address);
  // A request opened from Attività is read afresh under a key of its own: `buildKey(id)` holds what the page read when
  // that build started, which says it is running.
  const followed = jobId ?? reviewed;
  const build = useQuery({
    queryKey: reviewed ? ["map-build", scopeKey, "request", reviewed] : buildKey(jobId),
    queryFn: () => readBuild(followed),
    refetchInterval: (query) =>
      query.state.data && ["queued", "running"].includes(query.state.data.state)
        ? 500
        : false,
  });
  const activeId =
    list.data?.find((m) => m.id === openMap)?.id ?? list.data?.[0]?.id;
  // The map id lives in the URL, so the first render already shows the map the Maps section opened.
  const pickMap = useCallback(
    (id: string) => {
      // Choosing the map the address already names changes nothing there, so the kept request is dropped here.
      setKept(undefined);
      setSearch(
        (current) => {
          const next = new URLSearchParams(current);
          next.set("map", id);
          return next;
        },
        { replace: true },
      );
    },
    [setSearch],
  );
  useEffect(() => {
    setJobId(undefined);
    setKept(undefined);
    setNotice("");
    setInstruction("");
    setLastChange(undefined);
  }, [scopeKey, openMap]);
  // The subject, exam and topic the header names; the exam also gives flashcards and Chiedi their place.
  const scope = useQuery({
    queryKey: ["map-scope", scopeKey],
    queryFn: () => invoke("maps.scope", address),
  });
  const planId = scope.data?.planId ?? undefined;
  const topicId = scope.data?.topicId ?? undefined;
  const subjectName = scope.data?.subjectName ?? undefined;
  const wholeSubject = !params.topicId;
  const mapKey = ["map", scopeKey, activeId];
  const map = useQuery({
    queryKey: mapKey,
    enabled: Boolean(activeId),
    queryFn: () => invoke("maps.open", { ...address, mapId: activeId }),
  });
  const graph = map.data;
  const selectedNode = graph?.nodes.find((n) => n.id === selected);
  const root = graph?.nodes.find((n) => n.parent === null);
  const nodeSources = useNodeSources(selectedNode?.sources ?? []);
  // A concept's source opens beside the map, at the passage it cites. The panel keeps its passage while it slides out,
  // and Esc or its close button put focus back on the source button that opened it.
  const [openSourceAt, setOpenSourceAt] = useState<NodeSource>();
  const [sourceOpen, setSourceOpen] = useState(false);
  const sourceTrigger = useRef<HTMLElement | null>(null);
  const sourcePanel = useRef<HTMLElement>(null);
  const sourceSlot = useRef<HTMLDivElement>(null);
  const sourceTitleId = useId();
  const layoutLabel = useId();
  // Picking another concept meanwhile removes that button, so focus goes to the concept selected now.
  const closeSource = useCallback(() => {
    setSourceOpen(false);
    const trigger = sourceTrigger.current;
    if (trigger?.isConnected) trigger.focus();
    else
      (
        canvas.current?.querySelector<HTMLElement>(".react-flow__node.selected") ??
        canvas.current?.querySelector<HTMLElement>(".react-flow__node")
      )?.focus({ preventScroll: true });
  }, []);
  const sourceView = useSourceView(
    openSourceAt
      ? { passageId: openSourceAt.passageId, sourceId: openSourceAt.sourceId }
      : null,
    { titleId: sourceTitleId, onClose: closeSource },
  );
  function openSource(picked: NodeSource, trigger: HTMLElement) {
    sourceTrigger.current = trigger;
    setOpenSourceAt(picked);
    setSourceOpen(true);
  }
  // The view before the panel moved it and the view it moved to, so closing the panel can put the map back.
  const shiftedFrom = useRef<{ before: Viewport; after: Viewport } | undefined>(undefined);
  // Closing the panel puts the view back where it was before the panel moved it, unless the student moved it since.
  useEffect(() => {
    const shifted = shiftedFrom.current;
    const instance = flow.current;
    if (sourceOpen || !shifted || !instance) return;
    shiftedFrom.current = undefined;
    const now = instance.getViewport();
    const moved =
      Math.abs(now.x - shifted.after.x) > 1 ||
      Math.abs(now.y - shifted.after.y) > 1 ||
      Math.abs(now.zoom - shifted.after.zoom) > 0.001;
    if (moved) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    void instance.setViewport(shifted.before, { duration: reduced ? 0 : 200 });
  }, [sourceOpen]);
  // Focus moves into the panel once it is no longer inert, so the keyboard and screen readers follow it there. When the
  // narrower canvas has hidden the concept whose source is open, the view moves just enough to show it, at the same
  // zoom, once the panel's slot has finished growing; the rest of the map stays where it was.
  useEffect(() => {
    if (!sourceOpen) return;
    sourcePanel.current?.focus({ preventScroll: true });
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const reveal = () => {
      const instance = flow.current;
      const node = selected ? instance?.getInternalNode(selected) : undefined;
      const box = canvas.current?.getBoundingClientRect();
      if (!instance || !node || !box) return;
      const { x, y, zoom } = instance.getViewport();
      const at = node.internals.positionAbsolute;
      const width = node.measured.width ?? NODE_WIDTH;
      const height = node.measured.height ?? NODE_MIN_HEIGHT;
      // How far to move along one axis so a span from `start` to `end` fits in `size`, keeping a margin; a span wider
      // than the canvas lines up with its start.
      const MARGIN = 24;
      const shift = (start: number, end: number, size: number) =>
        start < MARGIN || end - start > size - 2 * MARGIN
          ? MARGIN - start
          : end > size - MARGIN
            ? size - MARGIN - end
            : 0;
      const left = at.x * zoom + x;
      const top = at.y * zoom + y;
      const dx = shift(left, left + width * zoom, box.width);
      const dy = shift(top, top + height * zoom, box.height);
      if (!dx && !dy) return;
      const after = { x: x + dx, y: y + dy, zoom };
      // Kept from the first move only, so a second source opened meanwhile still leads back to the view before both.
      shiftedFrom.current = { before: shiftedFrom.current?.before ?? { x, y, zoom }, after };
      void instance.setViewport(after, { duration: reduced ? 0 : 200 });
    };
    const slot = sourceSlot.current;
    // A slot that was open already, or under reduced motion, does not move, so no transition ends.
    if (reduced || !slot || slot.getBoundingClientRect().width >= (sourcePanel.current?.offsetWidth ?? 0)) {
      const timer = window.setTimeout(reveal, 0);
      return () => window.clearTimeout(timer);
    }
    const ended = (event: TransitionEvent) => {
      if (event.target === slot && event.propertyName === "width") reveal();
    };
    slot.addEventListener("transitionend", ended);
    return () => slot.removeEventListener("transitionend", ended);
    // Only opening the panel, or another source in it, moves the view; picking a concept afterwards does not.
  }, [sourceOpen, openSourceAt]);
  useEffect(() => {
    if (!sourceOpen) return;
    const escape = (event: KeyboardEvent) => {
      // A dialog over the map takes its own Esc, and a menu that handled the key stopped it already.
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest("dialog, [role='dialog']"))
      )
        return;
      closeSource();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [sourceOpen, closeSource]);
  // Another map, or another scope, starts without the panel.
  useEffect(() => setSourceOpen(false), [scopeKey, activeId]);
  // The finished map is named after the topic, or the subject for a whole-subject map, so the page shows that name from
  // the first frame, before the map exists.
  const title =
    list.data?.find((m) => m.id === activeId)?.title ??
    (wholeSubject ? scope.data?.subjectName : scope.data?.topicTitle) ??
    t("map.title");
  const job = build.data;
  const building = Boolean(job && ["queued", "running"].includes(job.state));
  // The request found nothing in the material and no map was built. With a map to show, the notice says it instead.
  // The request the student came to change from Attività shows even when the scope has maps; they stay in the page's menu.
  const nothingMatched =
    job?.state === "failed" && job.error === "map-nothing-matched" && (!graph || job.jobId === reviewed);
  // The words the student can change, which start as the ones that found nothing.
  const [reask, setReask] = useState("");
  useEffect(() => {
    if (nothingMatched) setReask(job?.instruction ?? "");
  }, [nothingMatched, job?.jobId]);
  // The working state gives way to the result without a live region of its own, so when a build the page waited for ends
  // with nothing matched, focus moves to the result's heading, which a screen reader then reads.
  const announce = useRef(false);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const working = (!graph || fresh) && (building || starting || busy);
  // A request whose job is gone (cleared from Attività, or from an older workspace) leaves the scope's normal view.
  useEffect(() => {
    if (reviewed && build.isSuccess && build.data === null) leaveRequest();
  }, [reviewed, build.isSuccess, build.data]);
  useEffect(() => {
    // Only a read that came back counts: while the query refetches, `job` may be a stale copy of a build that has ended
    // since, as when the page opens on a scope whose last build the student left running.
    if (job && !build.isFetching && ["queued", "running"].includes(job.state) && job.jobId !== jobId) {
      // The build is read by its job from now on; its first read is the one the page has, so the working state stays.
      client.setQueryData(buildKey(job.jobId), job);
      setJobId(job.jobId);
    }
  }, [job?.jobId, job?.state, build.isFetching]);
  const disabled =
    busy ||
    Boolean(building) ||
    list.isPending ||
    Boolean(activeId && map.isPending);
  useEffect(() => {
    // The job the page waits for; until the build query has caught up with a build just started, `job` is the last one.
    if (
      jobId &&
      job &&
      job.jobId === jobId &&
      ["succeeded", "failed", "cancelled", "interrupted"].includes(job.state)
    ) {
      // The page goes back to the scope's newest build, which until it is read is the build that just ended. A request
      // that found nothing stays on the page the way Attività's "Cambia la richiesta" opens it, whether or not the scope
      // has a map, until the student changes it or chooses a map.
      if (job.state === "failed" && job.error === "map-nothing-matched") {
        announce.current = true;
        client.setQueryData(["map-build", scopeKey, "request", job.jobId], job);
        setKept(job.jobId);
      } else leaveRequest();
      client.setQueryData(buildKey(), job);
      setJobId(undefined);
      setFresh(false);
      // The map this build made is the one the student wants to see, so it opens. Another build of the scope may have
      // finished since, so the build's own map id says which it is, not the last map of the list. A build saved before
      // it kept one still opens the last map of a request with an instruction.
      const { state, instruction, mapId } = job;
      void client
        .fetchQuery({ queryKey: listKey, queryFn: () => invoke("maps.list", address), staleTime: 0 })
        .then((maps) => {
          if (state !== "succeeded") return;
          if (mapId && maps.some((map) => map.id === mapId)) pickMap(mapId);
          else if (!mapId && instruction && maps.length > 1) pickMap(maps[maps.length - 1]!.id);
        })
        .catch(() => undefined);
      // A build the student stopped is not a failure. Without a map the empty state says so and offers to resume it.
      // One that found nothing for the request says so next to the request, which the page shows.
      if (job.state === "cancelled") setNotice(graph ? t("map.stopped") : "");
      else if (job.state !== "succeeded" && !(job.state === "failed" && job.error === "map-nothing-matched"))
        setNotice(t("map.generateFailed"));
    }
  }, [job?.state, jobId, client, scopeKey, t]);
  useEffect(() => {
    // The heading is not there while the working state shows; the announcement waits for it.
    if (!nothingMatched || !announce.current || !resultHeading.current) return;
    announce.current = false;
    resultHeading.current.focus();
  }, [nothingMatched, job?.jobId, working]);
  // A build that starts again, here or from Attività, clears what the last one left.
  useEffect(() => {
    if (building) setNotice("");
  }, [building]);
  const radial = graph?.layout === "radial";
  const folded = useMemo(
    () =>
      fold.mapId === activeId ? fold.ids : initialCollapsed(graph?.nodes ?? []),
    [fold, activeId, graph],
  );
  const foldedRef = useRef(folded);
  foldedRef.current = folded;
  const toggle = useCallback(
    (id: string) => {
      motion.current.origin = id;
      motion.current.map = activeId;
      const ids = new Set(foldedRef.current);
      if (ids.delete(id)) reveal.current = { id, map: activeId };
      else ids.add(id);
      setFold({ mapId: activeId, ids });
    },
    [activeId],
  );
  const shown = useMemo(
    () => visibleNodes(graph?.nodes ?? [], folded),
    [graph, folded],
  );
  const places = useMemo(
    () => (radial ? null : layoutTree(shown.shown, heights)),
    [radial, shown, heights],
  );
  const parents = useMemo(() => parentIds(graph?.nodes ?? []), [graph]);
  const levels = useMemo(() => {
    const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
    const level = (id: string | null): 0 | 1 | 2 => {
      const parent = id ? byId.get(id)?.parent : null;
      return parent == null ? 0 : byId.get(parent)?.parent == null ? 1 : 2;
    };
    return new Map((graph?.nodes ?? []).map((n) => [n.id, level(n.id)]));
  }, [graph]);
  // Dragged nodes keep the spot they were dropped on; the rest follow the layout.
  const spots = useMemo(
    () =>
      shown.shown.map((n) => ({
        node: n,
        at: (!n.pinned && places?.get(n.id)) || { x: n.x, y: n.y },
      })),
    [shown, places],
  );
  useEffect(() => {
    const target: FlowNode[] = 
      spots.map(({ node: n, at }) => {
        const height = heights.get(n.id);
        return {
          id: n.id,
          type: "concept",
          position: at,
          selected: selected === n.id,
          ariaLabel: n.label,
          ariaRole: "group",
          ...(height ? { measured: { width: NODE_WIDTH, height } } : {}),
          data: {
            label: n.label,
            level: levels.get(n.id) ?? 2,
            folded: folded.has(n.id),
            hidden: shown.hidden.get(n.id) ?? 0,
            hasChildren: parents.has(n.id),
            toggle,
            // Neutro is the plain node, which differs between the themes.
            color:
              n.color !== "surface-raised" &&
              (fills.some((color) => color === n.color) ||
                /^#[0-9a-f]{6}$/i.test(n.color ?? ""))
                ? n.color
                : undefined,
          },
        };
      });
    const originId = motion.current.map === activeId ? motion.current.origin : undefined;
    const now = new Map(nodesRef.current.map((node) => [node.id, node]));
    const origin = originId ? now.get(originId) : undefined;
    cancelAnimationFrame(motion.current.frame);
    if (!origin || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      motion.current.origin = undefined;
      setNodes(target);
      return;
    }
    // Every node moves from where it is now to where the layout puts it. The branch that opens or closes hangs off the
    // folded node's right edge, centred on it, and moves with that node: new nodes grow out of it and fade in, leaving
    // ones slide into it and fade out. When the map redraws mid-move because a new node got measured, each node carries
    // on from where it is, so one already on its way out keeps going instead of vanishing.
    const originEnd = target.find((node) => node.id === originId)?.position ?? origin.position;
    const originWidth = widths.current.get(origin.id) ?? NODE_WIDTH;
    const originHeight = heights.get(origin.id) ?? NODE_MIN_HEIGHT;
    const tucked = (at: { x: number; y: number }, id: string) => ({
      x: at.x + originWidth,
      y: at.y + (originHeight - (heights.get(id) ?? originHeight)) / 2,
    });
    const ids = new Set(target.map((node) => node.id));
    const leaving = nodesRef.current.filter((node) => !ids.has(node.id));
    const shownAt = (node?: FlowNode) => Number(node?.style?.opacity ?? 1);
    // The clock starts at the first screen frame, which draws the start again. Whether the first frame drawn is that one
    // or the one set here, the motion starts from where the nodes are, and no node steps back first.
    let start: number | undefined;
    let ended = false;
    const step = (time?: number) => {
      if (time !== undefined) start ??= time;
      const progress =
        time === undefined || start === undefined ? 0 : Math.min(1, (time - start) / MOTION_MS);
      const eased = 1 - (1 - progress) ** 3;
      const between = (from: { x: number; y: number }, to: { x: number; y: number }) => ({
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
      });
      const originAt = between(origin.position, originEnd);
      // The last frame draws the leaving nodes invisible inside the folded node and the frame after removes them, so
      // where they last show never depends on how many frames the screen managed.
      const settled = ended;
      ended = progress === 1;
      setNodes([
        ...target.map((node) => {
          const was = now.get(node.id);
          const opacity = was ? shownAt(was) : 0;
          const inside = tucked(originEnd, node.id);
          const grown = tucked(originAt, node.id);
          return {
            ...node,
            position: was
              ? between(was.position, node.position)
              : {
                  x: grown.x + (node.position.x - inside.x) * eased,
                  y: grown.y + (node.position.y - inside.y) * eased,
                },
            style: opacity < 1 ? { ...node.style, opacity: opacity + (1 - opacity) * eased } : node.style,
          };
        }),
        ...(settled
          ? []
          : leaving.map((node) => {
              const from = tucked(origin.position, node.id);
              const into = tucked(originAt, node.id);
              return {
                ...node,
                position: {
                  x: into.x + (node.position.x - from.x) * (1 - eased),
                  y: into.y + (node.position.y - from.y) * (1 - eased),
                },
                selectable: false,
                data: { ...node.data, leaving: true },
                style: { ...node.style, opacity: shownAt(node) * (1 - eased) },
              };
            })),
      ]);
      // The canvas says while the map moves, for anything that waits for it to settle.
      canvas.current?.toggleAttribute("data-moving", !settled);
      if (!settled)
        motion.current.frame = requestAnimationFrame((time) =>
          // Each frame reaches the screen in the frame it was worked out for, so the end frame shows before the next
          // one removes the leaving nodes.
          flushSync(() => step(time)),
        );
      else motion.current.origin = undefined;
    };
    // The first frame now, so no frame shows the old layout; the rest on the screen's frames.
    step();
    return () => {
      cancelAnimationFrame(motion.current.frame);
      canvas.current?.removeAttribute("data-moving");
    };
  }, [spots, shown, heights, selected, folded, parents, levels, toggle, activeId]);
  // After an unfold, the view moves so the branch and its parent are on screen, once the new concepts are measured.
  useEffect(() => {
    const asked = reveal.current;
    const instance = flow.current;
    const size = canvas.current?.getBoundingClientRect();
    if (!asked || asked.map !== activeId || !instance || !size) return;
    const inside = new Set([asked.id]);
    const members = spots.filter(({ node }) => {
      if (node.id !== asked.id && !(node.parent && inside.has(node.parent))) return false;
      inside.add(node.id);
      return true;
    });
    if (members.length < 2 || members.some(({ node }) => !heights.has(node.id))) return;
    reveal.current = undefined;
    const boxes = members.map(({ node, at }) => ({ ...at, height: heights.get(node.id)! }));
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const parent = members.find(({ node }) => node.id === asked.id)!;
    const next = revealViewport(
      {
        x: left,
        y: top,
        width: Math.max(...boxes.map((box) => box.x)) + NODE_WIDTH - left,
        height: Math.max(...boxes.map((box) => box.y + box.height)) - top,
      },
      parent.at.y + (heights.get(asked.id) ?? NODE_MIN_HEIGHT) / 2,
      instance.getViewport(),
      size,
    );
    if (next)
      void instance.setViewport(next, {
        duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : MOTION_MS,
      });
  }, [spots, heights, activeId]);
  useEffect(() => {
    setSelected(undefined);
    setPaletteOpen(false);
    setHeights(new Map());
    widths.current = new Map();
  }, [activeId]);
  const edges = useMemo(() => {
    const at = new Map(nodes.map((n) => [n.id, n.position.x]));
    // A connector fades with the node that grows in or slides away at its end.
    const faded = new Map(
      nodes.flatMap((n) =>
        n.style?.opacity === undefined ? [] : [[n.id, Number(n.style.opacity)] as const],
      ),
    );
    const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
    const result: Array<Edge | FlowEdge> = [];
    for (const e of graph?.edges ?? []) {
      let source = e.from;
      let target = e.to;
      const tree =
        byId.get(e.to)?.parent === e.from || byId.get(e.from)?.parent === e.to;
      if (byId.get(e.from)?.parent === e.to)
        [source, target] = [target, source];
      const from = at.get(source);
      const to = at.get(target);
      if (from === undefined || to === undefined) continue;
      const forward = to >= from;
      const opacity = Math.min(faded.get(source) ?? 1, faded.get(target) ?? 1);
      const base = {
        id: JSON.stringify([e.from, e.to]),
        source,
        target,
        ...(opacity < 1 ? { style: { opacity } } : {}),
        sourceHandle: forward ? "out-r" : "out-l",
        targetHandle: forward ? "in-l" : "in-r",
        focusable: false,
      };
      result.push(
        tree
          ? {
              ...base,
              // Right-angled connectors with rounded elbows in the tree; the radial layout keeps its curves.
              ...(radial
                ? { type: "default" }
                : { type: "smoothstep", pathOptions: { borderRadius: 9 } }),
              className: "px-tree-edge",
            }
          : {
              ...base,
              type: "cross",
              data: {
                label: e.label,
                active: selected === e.from || selected === e.to,
              },
            },
      );
    }
    return result;
  }, [graph, nodes, selected, radial]);
  function startView() {
    const size = canvas.current?.getBoundingClientRect();
    if (!size || !spots.length) return;
    const boxes = spots.map(({ node, at }) => ({
      ...at,
      width: NODE_WIDTH,
      height: heights.get(node.id) ?? 64,
    }));
    const root = boxes[spots.findIndex(({ node }) => node.parent === null)];
    void flow.current?.setViewport(
      startViewport(boxes, root ?? boxes[0]!, size),
    );
  }
  // Open on the whole map, or on the root at a readable size when it will not fit.
  useEffect(() => {
    const key = `${activeId}:${graph?.layout}`;
    if (ready !== activeId || !spots.length || viewed.current === key) return;
    if (spots.some(({ node }) => !heights.has(node.id))) return;
    viewed.current = key;
    startView();
  }, [ready, spots, heights, activeId, graph?.layout]);

  async function commit(
    action: () => Promise<NonNullable<typeof graph>>,
    { keepChange = false } = {},
  ) {
    if (disabled) return;
    setBusy(true);
    setNotice("");
    try {
      await moves.current.catch(() => undefined);
      const result = await action();
      client.setQueryData(mapKey, result);
      if (!keepChange) setLastChange(undefined);
    } catch (err) {
      setNotice(
        (err as { messageKey?: unknown } | null)?.messageKey ===
          "map.editConflict"
          ? t("map.editConflict")
          : t("map.editFailed"),
      );
    } finally {
      setBusy(false);
    }
  }
  function patch(ops: MapOp[]) {
    return commit(() =>
      invoke("maps.patch", { ...address, mapId: activeId, ops }),
    );
  }
  const changes = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
      for (const change of changes)
        if (change.type === "dimensions" && change.dimensions)
          widths.current.set(change.id, change.dimensions.width);
      const measured = changes.flatMap((change) =>
        change.type === "dimensions" && change.dimensions
          ? [[change.id, Math.ceil(change.dimensions.height)] as const]
          : [],
      );
      if (measured.length)
        setHeights((current) => {
          if (measured.every(([id, height]) => current.get(id) === height))
            return current;
          return new Map([...current, ...measured]);
        });
      for (const change of changes) {
        if (
          change.type !== "position" ||
          !change.position ||
          change.dragging ||
          !activeId
        )
          continue;
        const { x, y } = change.position;
        setLastChange(undefined);
        moves.current = moves.current
          .catch(() => undefined)
          .then(() =>
            invoke("maps.move", {
              ...address,
              mapId: activeId,
              nodeId: change.id,
              x,
              y,
            }),
          )
          .then((result) => client.setQueryData(mapKey, result))
          .catch(() => setNotice(t("map.editFailed")));
      }
    },
    [address, activeId, client],
  );
  // Starts a stopped build again from the step it reached, as Attività's Riprendi does.
  async function resumeBuild() {
    if (!job) return;
    setBusy(true);
    setNotice("");
    try {
      await invoke("jobs.resumeAll", { jobIds: [job.jobId] });
      client.setQueryData(buildKey(job.jobId), job);
      setJobId(job.jobId);
      await client.invalidateQueries({ queryKey: ["map-build", scopeKey] });
    } catch {
      setNotice(t("map.generateFailed"));
    } finally {
      setBusy(false);
    }
  }
  // A stopped build asks again with the instruction it had, so it is picked up and not built anew without it.
  const retrying = Boolean(job && ["failed", "cancelled", "interrupted"].includes(job.state));
  // `changing` is the student sending other words from the request on show, which that request gives way to.
  async function generateMaps(instruction = retrying ? (job?.instruction ?? "") : "", changing = false) {
    setBusy(true);
    setNotice("");
    // A request that found nothing waits in Attività for the student to change it, so changing it takes it out there.
    const replaced = changing && nothingMatched ? job?.jobId : undefined;
    try {
      const result = await invoke("maps.generate", { ...address, ...(instruction ? { instruction } : {}) });
      // The request the page kept goes only now that the new one has started; a failure leaves it, with the words changed.
      leaveRequest();
      // The same words may be picked up by the same job, which then stays.
      if (replaced && result.jobId !== replaced)
        await invoke("jobs.dismiss", { jobId: replaced }).catch(() =>
          client.invalidateQueries({ queryKey: ["jobs-finished"] }),
        );
      // The page follows the job `maps.generate` returned. Its first read is in place before the page switches to it, so
      // the working state does not drop out for a frame.
      if (result.jobId)
        client.setQueryData(buildKey(result.jobId), await readBuild(result.jobId));
      setJobId(result.jobId);
      await client.invalidateQueries({ queryKey: listKey });
      await client.invalidateQueries({
        queryKey: ["map-build", scopeKey],
      });
    } catch {
      setFresh(false);
      setNotice(t("map.generateFailed"));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!starting || buildAsked.current || list.isPending || build.isPending) return;
    buildAsked.current = true;
    // The flag belongs to this arrival: going back to the page later must not start a build again.
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    // Without an instruction the page builds only when the scope has no map and no build; with one, the request is
    // for a map of its own and core decides whether the same request is already under way.
    const own = wanted.current;
    if (!list.isError && !build.isError && (own || (!list.data?.length && !building))) {
      if (own && list.data?.length) setFresh(true);
      void generateMaps(own).finally(() => setStarting(false));
    } else setStarting(false);
  });
  // The view on screen as a picture, without the canvas tools over it.
  async function exportPng() {
    if (!canvas.current) return;
    setBusy(true);
    setNotice("");
    try {
      await document.fonts.ready;
      const url = await toPng(canvas.current, {
        backgroundColor: getComputedStyle(canvas.current).backgroundColor,
        pixelRatio: 2,
        filter: (el) =>
          !(
            el instanceof HTMLElement &&
            (el.classList.contains("px-map-strip") ||
              el.classList.contains("react-flow__attribution"))
          ),
      });
      const link = document.createElement("a");
      link.href = url;
      link.download = "map.png";
      link.click();
    } catch {
      setNotice(t("map.exportFailed"));
    } finally {
      setBusy(false);
    }
  }
  function rename() {
    if (selectedNode) {
      setLabel(selectedNode.label);
      setDialog("rename");
    }
  }
  /** The map as an indented outline, the text the flashcards are written from. */
  function outline() {
    const nodes = graph?.nodes ?? [];
    const lines: string[] = [];
    const walk = (id: string, depth: number) => {
      const node = nodes.find((n) => n.id === id);
      if (!node) return;
      lines.push(`${"  ".repeat(depth)}${depth ? "- " : ""}${node.label}`);
      for (const child of nodes.filter((n) => n.parent === id))
        walk(child.id, depth + 1);
    };
    if (root) walk(root.id, 0);
    return lines.join("\n");
  }
  function makeCards() {
    if (!graph) return;
    openMakeCards({
      text: outline(),
      origin: "map",
      planId,
      topicId,
      subject: subjectName,
      subjectId: scope.data?.subjectId ?? undefined,
      passageIds: [
        ...new Set(graph.nodes.flatMap((n) => n.sources ?? [])),
      ].slice(0, 1000),
    });
  }
  // Chiedi opens a new chat about the concept, with its place in the map and its sources as context.
  async function askAbout() {
    if (!selectedNode || !graph) return;
    const path: string[] = [];
    for (
      let node: typeof selectedNode | undefined = selectedNode;
      node && path.length <= graph.nodes.length;
      node = graph.nodes.find((n) => n.id === node!.parent)
    )
      path.unshift(node.label);
    setNotice("");
    try {
      const { chatId } = await invoke("chats.seed", {
        kind: "passage",
        title: selectedNode.label.slice(0, 120),
        body: path.join(" › ").slice(0, 20_000),
        sourceIds: nodeSources.length
          ? nodeSources.map((source) => source.sourceId)
          : undefined,
        planId,
        subject: subjectName,
      });
      navigate(`/ask/${chatId}`);
    } catch {
      setNotice(t("map.askFailed"));
    }
  }
  function aiEdit() {
    const asked = instruction.trim();
    if (!asked || !graph) return;
    const before = graph.nodes;
    void commit(
      async () => {
        setEditing(true);
        const result = await invoke("maps.edit", {
          ...address,
          mapId: activeId,
          instruction: asked,
        }).finally(() => setEditing(false));
        setInstruction("");
        const change = describeChange(before, result.nodes);
        setLastChange({
          mapId: activeId,
          text:
            change.kind === "added"
              ? t("map.lastAdded", {
                  label: change.label,
                  parent: change.parent,
                })
              : t("map.lastChanged"),
        });
        return result;
      },
      { keepChange: true },
    );
  }
  const undo = () =>
    void commit(() =>
      invoke("maps.undo", { ...address, mapId: activeId }),
    );
  const redo = () =>
    void commit(() =>
      invoke("maps.redo", { ...address, mapId: activeId }),
    );
  // The map on show, which a tile, the switcher or a finished build chose.
  const activeMap = list.data?.find((m) => m.id === activeId);
  const [renaming, setRenaming] = useState(false);
  // What a rename or a failed delete says, read out by screen readers.
  const [said, setSaid] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const dots = useRef<HTMLDivElement>(null);
  useEffect(() => setRenaming(false), [activeId]);
  // After a rename the title takes the focus back, once it is drawn again.
  const [titleFocus, setTitleFocus] = useState(false);
  useEffect(() => {
    if (!titleFocus || renaming) return;
    setTitleFocus(false);
    heading.current?.focus({ preventScroll: true });
  }, [titleFocus, renaming]);
  // A map still being written has no map to show yet; its menu offers only to delete it, which stops its build.
  const writingJob = working ? (jobId ?? (building ? job?.jobId : undefined)) : undefined;
  // A map asked for in words goes by its request until it has a name, as the working line says.
  const writingTitle =
    (writingJob ? job?.instruction?.trim() : undefined) ||
    ((wholeSubject ? scope.data?.subjectName : scope.data?.topicTitle) ?? t("map.title"));
  const backTo = (scope.data?.subjectId ?? params.subjectId)
    ? `/maps?subject=${encodeURIComponent(scope.data?.subjectId ?? params.subjectId ?? "")}`
    : "/maps";
  const actions = useMapActions({
    address,
    mapId: writingJob ? undefined : activeId,
    jobId: writingJob,
    title: writingJob ? writingTitle : title,
    state: { writing: Boolean(writingJob), busy: disabled },
    settle: () => moves.current.catch(() => undefined),
    exportView: writingJob ? undefined : () => void exportPng(),
    onRename: () => setRenaming(true),
    // A stored map leaves from its tile on Mappe, which shrinks away where it was; a map still being written has none.
    onDelete: writingJob
      ? undefined
      : () =>
          navigate(backTo, {
            state: { remove: { ...address, mapId: activeId, title, subjectId: scope.data?.subjectId ?? null } },
          }),
    onDeleted: () => navigate(backTo),
  });
  // A right-click on the empty canvas opens the same menu at the pointer.
  const canvasMenu = useItemMenu({ menu: actions.menu, region: t("map.more"), disabled: !graph || fresh });
  // A concept keeps what a right-click or the menu key did on it, and the tools on the canvas keep theirs.
  const onCanvas = (target: EventTarget) => !(target instanceof Element && target.closest(".react-flow__node, .px-map-strip"));
  const canvasBind: typeof canvasMenu.bind = {
    onContextMenu: (event) => {
      if (onCanvas(event.target as EventTarget)) canvasMenu.bind.onContextMenu(event);
    },
    onKeyDown: (event) => {
      if (onCanvas(event.target as EventTarget)) canvasMenu.bind.onKeyDown(event);
    },
  };
  // A link to a map that was deleted since lands on Mappe, which says so, rather than on another map of the scope.
  useEffect(() => {
    if (openMap && list.isSuccess && !list.isFetching && !list.data.some((m) => m.id === openMap) && !jobId)
      navigate(backTo, { replace: true, state: { gone: true } });
  }, [openMap, list.isSuccess, list.isFetching, list.data, jobId]);
  // Several maps of one topic, or of one subject, are told apart by what the student asked for each.
  const switcher: MenuProps | undefined =
    list.data && (list.data.length > 1 || (nothingMatched && list.data.length > 0))
      ? {
          items: list.data.map((m) => ({
            key: m.id,
            role: "menuitemradio",
            "aria-checked": m.id === activeId,
            icon: (
              <span className="px-item-menu-check" aria-hidden>
                {m.id === activeId ? <Icon name="check" size={15} /> : null}
              </span>
            ),
            label: (
              <span className="px-item-menu-choice" title={m.instruction ?? undefined}>
                <span>{requestName(m, t("map.whole"))}</span>
                <small>{m.title}</small>
              </span>
            ),
            disabled,
          })),
          onClick: ({ key }) => pickMap(key),
        }
      : undefined;
  const scopeName = (wholeSubject ? scope.data?.subjectName : scope.data?.topicTitle) ?? t("map.title");
  // The working state names the map being built, which is the scope's own name until the map has a title.
  const workingLine = t("map.buildingOf", {
    title: (wholeSubject ? scope.data?.subjectName : scope.data?.topicTitle) ?? t("map.title"),
  });
  // What the student asked for, in one quiet line under the working line, so they see the request was taken.
  const workingAsk = building ? job?.instruction : starting ? wanted.current : undefined;
  const change =
    lastChange && lastChange.mapId === activeId && graph?.undo
      ? lastChange
      : undefined;
  // The way back leads to Mappe at this map's subject, or to the whole list for the topic map of an exam with none.
  const shownTitle = writingJob ? writingTitle : title;
  // The head keeps its controls while another map of the scope loads, so the switcher keeps the focus it gave back.
  const hasMap = Boolean(activeMap) && !fresh && !working;
  return (
    <div className="px-map-page">
      <BackLink to={backTo}>{t("doors.maps")}</BackLink>
      <header className="px-map-head">
        <div className="px-map-title-row">
          {renaming && activeId && graph && !fresh ? (
            <MapNameField
              className="px-map-name-title"
              address={address}
              mapId={activeId}
              value={title}
              onDone={(saved) => {
                setRenaming(false);
                if (saved) setSaid(t("map.renamed", { title: saved }));
                // Focus goes back to the title, which a screen reader then reads with its new name.
                setTitleFocus(true);
              }}
            />
          ) : (
            <h1 ref={heading} tabIndex={-1} title={shownTitle}>
              {shownTitle}
            </h1>
          )}
          {switcher && hasMap && !renaming ? (
            <MenuButton
              menu={switcher}
              size="sm"
              align="start"
              className="px-map-switch"
              label={t("map.switchMaps", {
                scope: scopeName,
                current: requestName(activeMap ?? {}, t("map.whole")),
              })}
            >
              {requestName(activeMap ?? {}, t("map.whole"))}
            </MenuButton>
          ) : null}
        </div>
        <div className="px-map-actions" ref={dots}>
          {hasMap ? (
            <Button
              variant="secondary"
              size="sm"
              icon="layers"
              // The cards go under the map's subject, and a topic map's exam and topic, which come with the scope.
              disabled={!scope.data || !graph}
              onClick={makeCards}
              // A narrow head shows the short label; the name stays whole.
              aria-label={t("map.makeCards")}
            >
              <span className="px-map-cards-long">{t("map.makeCards")}</span>
              <span className="px-map-cards-short">{t("map.makeCardsShort")}</span>
            </Button>
          ) : null}
          {hasMap || writingJob ? (
            <MenuButton menu={actions.menu} label={t("map.more")} />
          ) : null}
        </div>
        <p className="px-map-sub">
          {scope.data?.planTitle ? (
            <RouterLink
              to={`/plans/${planId}`}
              aria-label={t("map.openExam", { title: scope.data.planTitle })}
            >
              <GraduationCap size={14} strokeWidth={1.75} aria-hidden />
              <span>{scope.data.planTitle}</span>
            </RouterLink>
          ) : subjectName ? (
            <span className="px-map-subject">
              <Library size={14} strokeWidth={1.75} aria-hidden />
              <span>{subjectName}</span>
            </span>
          ) : null}
          {scope.data && (scope.data.planTitle || subjectName) && graph && !fresh ? (
            <span aria-hidden>·</span>
          ) : null}
          {graph && !fresh ? <span>{t("map.hint")}</span> : null}
        </p>
      </header>
      <p className="visually-hidden" aria-live="polite">
        {said}
      </p>
      {actions.failed ? (
        <p className="small px-map-notice px-map-error" role="alert">
          {t("map.deleteFailed")}
        </p>
      ) : null}
      {building && graph && !fresh ? <Working className="px-map-notice" line={workingLine} /> : null}
      {notice ? (
        <p className="small px-map-notice" role="status">
          {notice}
          {/* A build that stopped or failed next to a map already there is picked up again from here. */}
          {graph && retrying && !building ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => void (job?.state === "failed" ? generateMaps() : resumeBuild())}
            >
              {t(job?.state === "failed" ? "maps.retry" : "jobs.resume")}
            </Button>
          ) : null}
        </p>
      ) : null}
      {map.isError || list.isError || scope.isError ? (
        <LoadError
          onRetry={() => {
            if (list.isError) void list.refetch();
            if (map.isError) void map.refetch();
            if (scope.isError) void scope.refetch();
          }}
        >
          {t("map.loadFailed")}
        </LoadError>
      ) : null}
      {list.data?.find((m) => m.id === activeId)?.grounding === "general" ? (
        <p className="meta px-map-notice">{t("map.general")}</p>
      ) : null}
      <div className="px-map-body">
      <div className="px-map-card">
        {working ? (
          <Working
            slot
            className="px-map-working"
            line={workingLine}
            detail={
              workingAsk ? (
                <span className="px-map-asked" title={workingAsk}>
                  {t("maps.asked", { text: workingAsk })}
                </span>
              ) : undefined
            }
          />
        ) : nothingMatched ? (
          <div className="px-map-empty">
            <h2 className="title-2" tabIndex={-1} ref={resultHeading}>
              {t("map.nothingMatched")}
            </h2>
            <p className="small">{t("map.nothingMatchedBody", { text: job?.instruction ?? "" })}</p>
            <form
              className="px-map-reask px-form-field"
              onSubmit={(event) => {
                event.preventDefault();
                // With maps to show, the working state replaces them until the new map is ready.
                if (graph) setFresh(true);
                void generateMaps(reask.trim(), true);
              }}
            >
              <label className="label" htmlFor="map-reask">
                {t("maps.instruction")} <span className="px-map-optional">{t("maps.optional")}</span>
              </label>
              <Input.TextArea
                id="map-reask"
                value={reask}
                maxLength={MAP_INSTRUCTION_MAX}
                autoSize={{ minRows: 2, maxRows: 6 }}
                placeholder={t("maps.instructionPlaceholder")}
                onChange={(event) => setReask(event.target.value)}
              />
              <Button type="submit" disabled={disabled}>
                {t("maps.create")}
              </Button>
            </form>
          </div>
        ) : !graph && job?.state === "cancelled" ? (
          <div className="px-map-empty">
            <h2 className="title-2">{t("map.stopped")}</h2>
            <p className="small">{t("map.stoppedBody")}</p>
            <Button disabled={disabled} onClick={() => void resumeBuild()}>
              {t("jobs.resume")}
            </Button>
          </div>
        ) : !graph ? (
          <div className="px-map-empty">
            <h2 className="title-2">{t(wholeSubject ? "map.emptySubject" : "map.empty")}</h2>
            <p className="small">{t(wholeSubject ? "map.emptySubjectBody" : "map.emptyBody")}</p>
            <Button disabled={disabled} onClick={() => void generateMaps()}>
              {t(wholeSubject ? "map.generateSubject" : "map.generate")}
            </Button>
          </div>
        ) : (
          <>
            <div className="px-map-canvas" ref={canvas} {...canvasBind}>
              <ReactFlow<FlowNode>
                key={activeId}
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                proOptions={{ hideAttribution: true }}
                edgeTypes={edgeTypes}
                edgesFocusable={false}
                minZoom={0.15}
                maxZoom={2}
                nodesDraggable={!disabled}
                nodesConnectable={!disabled}
                elementsSelectable={!disabled}
                deleteKeyCode={null}
                onInit={(instance) => {
                  flow.current = instance;
                  setReady(activeId);
                }}
                onNodesChange={changes}
                onFocusCapture={(event) => {
                  // Folding a branch leaves the selection as it was.
                  if ((event.target as HTMLElement).closest(".px-concept-fold"))
                    return;
                  const id = (event.target as HTMLElement).closest<HTMLElement>(
                    ".react-flow__node",
                  )?.dataset.id;
                  if (id) {
                    setSelected(id);
                  }
                }}
                onNodeClick={(_, node) => setSelected(node.id)}
                onPaneClick={() => {
                  setSelected(undefined);
                  setPaletteOpen(false);
                }}
                onConnect={(connection) =>
                  void patch([
                    {
                      op: "connect",
                      from: connection.source,
                      to: connection.target,
                    },
                  ])
                }
                onNodeDoubleClick={(_, node) => {
                  setSelected(node.id);
                  setLabel(node.data.label);
                  setDialog("rename");
                }}
                onKeyDown={(event) => {
                  if (
                    event.target instanceof HTMLInputElement ||
                    event.target instanceof HTMLTextAreaElement ||
                    (event.target instanceof HTMLElement &&
                      (event.target.isContentEditable ||
                        // A fold button keeps its own Enter and Delete; the node's shortcuts are for the node.
                        event.target.closest("button") ||
                        event.target.closest("math-field"))) ||
                    disabled
                  )
                    return;
                  if (event.key === "Enter" && selectedNode) {
                    event.preventDefault();
                    rename();
                  }
                  // A Mac keyboard's delete key sends Backspace.
                  if (
                    (event.key === "Delete" || event.key === "Backspace") &&
                    selectedNode?.parent
                  ) {
                    event.preventDefault();
                    void patch([{ op: "delete", id: selectedNode.id }]);
                  }
                }}
              />
              {/* The tools that act on the whole canvas sit on it, at its bottom-right corner. */}
              <div className="px-map-strip" role="toolbar" aria-label={t("map.tools")}>
                <span className="visually-hidden" id={layoutLabel}>
                  {t("map.layout")}
                </span>
                <Segmented
                  label={layoutLabel}
                  value={graph.layout ?? "tree"}
                  disabled={disabled}
                  options={(["tree", "radial"] as const).map((layout) => ({ value: layout, label: t(`map.${layout}`) }))}
                  onChange={(layout) => {
                    if ((graph.layout ?? "tree") !== layout)
                      void commit(() => invoke("maps.layout", { ...address, mapId: activeId, layout }));
                  }}
                />
                <span className="px-map-strip-sep" aria-hidden />
                <IconButton icon="undo-2" size="sm" variant="ghost" label={t("map.undo")} disabled={disabled || !graph.undo} onClick={undo} />
                <IconButton icon="redo-2" size="sm" variant="ghost" label={t("map.redo")} disabled={disabled || !graph.redo} onClick={redo} />
                <span className="px-map-strip-sep" aria-hidden />
                <IconButton icon="scan" size="sm" variant="ghost" label={t("map.fit")} onClick={startView} />
              </div>
              {canvasMenu.popup}
            </div>
            <footer className="px-map-foot">
              <div className="px-map-node" key={selectedNode?.id ?? ""}>
                {selectedNode ? (
                  <>
                    <b className="px-map-node-label">
                      <MathText text={selectedNode.label} />
                    </b>
                    <span className="px-map-node-sources">
                      {nodeSources.slice(0, 2).map((source) => (
                        <Button
                          key={source.sourceId}
                          variant="secondary"
                          size="sm"
                          icon="book-open"
                          expanded={
                            sourceOpen && source.passageId === openSourceAt?.passageId
                          }
                          onClick={(event) =>
                            openSource(source, event.currentTarget)
                          }
                        >
                          {source.page != null
                            ? t("map.sourcePage", {
                                title: source.title,
                                page: source.page,
                              })
                            : source.slide != null
                              ? t("map.sourceSlide", {
                                  title: source.title,
                                  slide: source.slide,
                                })
                              : source.title}
                        </Button>
                      ))}
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="message-circle"
                        onClick={() => void askAbout()}
                      >
                        {t("map.ask")}
                      </Button>
                    </span>
                    <div
                      className="px-map-tools"
                      role="toolbar"
                      aria-label={t("map.conceptTools")}
                    >
                      <IconButton
                        icon="plus"
                        size="sm"
                        variant="ghost"
                        label={t("map.add")}
                        disabled={disabled}
                        onClick={() => {
                          setLabel("");
                          setDialog("add");
                        }}
                      />
                      <IconButton
                        icon="pencil"
                        size="sm"
                        variant="ghost"
                        label={t("map.rename")}
                        disabled={disabled}
                        onClick={rename}
                      />
                      <IconButton
                        icon="link"
                        size="sm"
                        variant="ghost"
                        label={t("map.connect")}
                        disabled={disabled}
                        onClick={() => {
                          setTarget(undefined);
                          setDialog("connect");
                        }}
                      />
                      <IconButton
                        icon="palette"
                        size="sm"
                        variant="ghost"
                        label={t("map.recolor")}
                        disabled={disabled}
                        expanded={paletteOpen}
                        onClick={() => setPaletteOpen((v) => !v)}
                      />
                      <IconButton
                        icon="trash-2"
                        size="sm"
                        variant="ghost"
                        label={t("map.delete")}
                        disabled={disabled || !selectedNode.parent}
                        onClick={() =>
                          void patch([{ op: "delete", id: selectedNode.id }])
                        }
                      />
                      {paletteOpen ? (
                        <div
                          className="px-map-palette"
                          role="group"
                          aria-label={t("map.recolor")}
                        >
                          {fills.map((color) => (
                            <button
                              key={color}
                              type="button"
                              disabled={disabled}
                              aria-label={t(`map.colors.${color}`)}
                              title={t(`map.colors.${color}`)}
                              style={{
                                background: `var(--${color === "surface-raised" ? "map-node" : color})`,
                              }}
                              onClick={() => {
                                void patch([
                                  { op: "recolor", id: selectedNode.id, color },
                                ]);
                                setPaletteOpen(false);
                              }}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <span className="px-map-node-hint">{t("map.pickHint")}</span>
                )}
              </div>
              <div className="px-map-lower">
                {editing ? (
                  <span className="px-map-change" role="status">
                    {t("map.editing")}
                  </span>
                ) : change ? (
                  <span className="px-map-change" role="status">
                    {change.text}
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="undo-2"
                      disabled={disabled}
                      onClick={() => {
                        setLastChange(undefined);
                        undo();
                      }}
                    >
                      {t("map.undo")}
                    </Button>
                  </span>
                ) : null}
                <form
                  className="px-map-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    aiEdit();
                  }}
                >
                  <Input
                    aria-label={t("map.instruction")}
                    placeholder={t("map.instructionPlaceholder")}
                    value={instruction}
                    maxLength={2000}
                    disabled={disabled}
                    onChange={(event) => setInstruction(event.target.value)}
                  />
                  <Button
                    type="submit"
                    disabled={disabled || !instruction.trim()}
                  >
                    {t("map.apply")}
                  </Button>
                </form>
              </div>
            </footer>
          </>
        )}
      </div>
      {/* The source panel beside the card, from the page's right edge. It is inert while closed or sliding out. */}
      <div
        ref={sourceSlot}
        className={sourceOpen ? "px-map-source is-open" : "px-map-source"}
        inert={!sourceOpen}
      >
        <aside
          ref={sourcePanel}
          className="px-map-source-panel"
          aria-labelledby={sourceTitleId}
          tabIndex={-1}
        >
          <div className="px-map-source-head">{sourceView.head}</div>
          <div className="px-map-source-body">{sourceView.body}</div>
        </aside>
      </div>
      </div>
      <Modal
        title={t(
          dialog === "connect"
            ? "map.connect"
            : dialog === "rename"
              ? "map.rename"
              : "map.add",
        )}
        open={dialog !== null}
        onCancel={() => setDialog(null)}
        okText={t("map.save")}
        cancelText={t("map.cancel")}
        okButtonProps={{
          disabled: dialog === "connect" ? !target : !label.trim(),
        }}
        onOk={() => {
          const op: MapOp =
            dialog === "connect"
              ? { op: "connect", from: selected!, to: target! }
              : dialog === "rename"
                ? { op: "rename", id: selected!, label: label.trim() }
                : {
                    op: "add_node",
                    id: crypto.randomUUID(),
                    label: label.trim(),
                    parent: selected ?? root!.id,
                  };
          if (op.op === "add_node" && folded.has(op.parent)) {
            const ids = new Set(folded);
            ids.delete(op.parent);
            setFold({ mapId: activeId, ids });
          }
          void patch([op]);
          setDialog(null);
        }}
      >
        {dialog === "connect" ? (
          <Select
            aria-label={t("map.target")}
            style={{ width: "100%" }}
            value={target}
            onChange={setTarget}
            options={graph?.nodes
              .filter((n) => n.id !== selected)
              .map((n) => ({ label: n.label, value: n.id }))}
          />
        ) : (
          <Input
            aria-label={t("map.nodeLabel")}
            value={label}
            maxLength={200}
            onChange={(event) => setLabel(event.target.value)}
          />
        )}
      </Modal>
    </div>
  );
}
