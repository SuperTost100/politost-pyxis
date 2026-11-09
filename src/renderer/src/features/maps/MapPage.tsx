import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input, Modal, Select } from "antd";
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
} from "@xyflow/react";
import { toPng } from "html-to-image";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { LoadError } from "../../components/LoadError";
import { MarkdownView } from "../../components/MarkdownView";
import { openMakeCards } from "../../components/MakeCardsDialog";
import { MathText } from "../../components/math/MathText";
import { invoke } from "../../lib/ipc";
import { mapColors as fills, type MapAddress, type MapOp } from "@shared/concept-map";
import "@xyflow/react/dist/style.css";
import {
  NODE_MIN_HEIGHT,
  NODE_WIDTH,
  initialCollapsed,
  layoutTree,
  parentIds,
  startViewport,
  visibleNodes,
} from "./mapLayout";
import { describeChange } from "./mapChange";
import { useMapExport } from "./MapExport";
import { MAP_KEYS, MapMenu, type MapMenuGroup } from "./MapMenu";
import { KeyCombo } from "../../app/ShortcutsDialog";
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
  const client = useQueryClient();
  const [selected, setSelected] = useState<string>();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [jobId, setJobId] = useState<string>();
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
  const build = useQuery({
    queryKey: ["map-build", scopeKey],
    queryFn: () => invoke("maps.build", address),
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
      if (dx || dy)
        void instance.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: reduced ? 0 : 200 });
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
  const title =
    list.data?.find((m) => m.id === activeId)?.title ?? t("map.title");
  const job = build.data;
  const building = Boolean(job && ["queued", "running"].includes(job.state));
  useEffect(() => {
    if (job && ["queued", "running"].includes(job.state)) setJobId(job.jobId);
  }, [job?.jobId, job?.state]);
  const disabled =
    busy ||
    Boolean(building) ||
    list.isPending ||
    Boolean(activeId && map.isPending);
  useEffect(() => {
    if (
      jobId &&
      job &&
      ["succeeded", "failed", "cancelled", "interrupted"].includes(job.state)
    ) {
      setJobId(undefined);
      void client.invalidateQueries({ queryKey: listKey });
      if (job.state !== "succeeded") setNotice(t("map.generateFailed"));
    }
  }, [job?.state, jobId, client, scopeKey, t]);
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
      if (!ids.delete(id)) ids.add(id);
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
  async function generateMaps() {
    setBusy(true);
    setNotice("");
    try {
      const result = await invoke("maps.generate", address);
      setJobId(result.jobId);
      await client.invalidateQueries({ queryKey: listKey });
      await client.invalidateQueries({
        queryKey: ["map-build", scopeKey],
      });
    } catch {
      setNotice(t("map.generateFailed"));
    } finally {
      setBusy(false);
    }
  }
  // The view on screen as a picture, without the fit button over it.
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
            (el.classList.contains("px-map-fit") ||
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
  const mapExport = useMapExport({
    address,
    mapId: activeId,
    settle: () => moves.current.catch(() => undefined),
  });
  const menu: MapMenuGroup[] = graph
    ? [
        {
          key: "layout",
          label: t("map.layout"),
          items: (["tree", "radial"] as const).map((layout) => ({
            key: layout,
            label: t(`map.${layout}`),
            checked: (graph.layout ?? "tree") === layout,
            disabled,
            onSelect: () => {
              if ((graph.layout ?? "tree") !== layout)
                void commit(() =>
                  invoke("maps.layout", {
                    ...address,
                    mapId: activeId,
                    layout,
                  }),
                );
            },
          })),
        },
        ...(list.data && list.data.length > 1
          ? [
              {
                key: "maps",
                label: t("map.choose"),
                items: list.data.map((m) => ({
                  key: m.id,
                  label: m.title,
                  checked: m.id === activeId,
                  disabled,
                  onSelect: () => pickMap(m.id),
                })),
              },
            ]
          : []),
        {
          key: "edit",
          items: [
            // Offered while no map came from a model yet, or after the last build stopped.
            ...(!list.data?.some((m) => m.provider) ||
            (job && ["failed", "cancelled", "interrupted"].includes(job.state))
              ? [
                  {
                    key: "build",
                    label: t("map.buildSources"),
                    icon: "refresh-cw" as const,
                    disabled,
                    onSelect: () => void generateMaps(),
                  },
                ]
              : []),
            {
              key: "undo",
              label: t("map.undo"),
              icon: "undo-2" as const,
              disabled: disabled || !graph.undo,
              onSelect: undo,
            },
            {
              key: "redo",
              label: t("map.redo"),
              icon: "redo-2" as const,
              disabled: disabled || !graph.redo,
              onSelect: redo,
            },
          ],
        },
        {
          key: "export",
          label: t("map.export"),
          items: [
            ...(["markdown", "svg", "pdf"] as const).map((format) => ({
              key: format,
              label: t(
                format === "markdown"
                  ? "map.exportMarkdown"
                  : format === "svg"
                    ? "map.exportSvg"
                    : "map.exportPdf",
              ),
              icon: "download" as const,
              disabled: disabled || mapExport.busy,
              onSelect: () => void mapExport.save(format),
            })),
            {
              key: "png",
              label: t("map.png"),
              icon: "image" as const,
              disabled,
              onSelect: () => void exportPng(),
            },
          ],
        },
      ]
    : [];
  const shortcuts = (
    <section className="px-map-keys" aria-label={t("map.shortcuts")}>
      <div className="px-map-more-label" aria-hidden>
        {t("map.shortcuts")}
      </div>
      <dl>
        {MAP_KEYS.map((row) => (
          <div key={row.id}>
            <dt>{t(`map.keys.${row.id}`)}</dt>
            <dd>
              <KeyCombo keys={row.keys} either={row.either} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
  const change =
    lastChange && lastChange.mapId === activeId && graph?.undo
      ? lastChange
      : undefined;
  return (
    <div className="px-map-page">
      <header className="px-map-head">
        <div className="px-map-title">
          <h1>{title}</h1>
          <p>
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
            {scope.data && (scope.data.planTitle || subjectName) && graph ? (
              <span aria-hidden>·</span>
            ) : null}
            {graph ? <span>{t("map.hint")}</span> : null}
          </p>
        </div>
        {graph ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              icon="layers"
              // The cards go under the map's subject, and a topic map's exam and topic, which come with the scope.
              disabled={!scope.data}
              onClick={makeCards}
            >
              {t("map.makeCards")}
            </Button>
            <MapMenu label={t("map.more")} groups={menu} footer={shortcuts} />
          </>
        ) : null}
      </header>
      {building && graph ? (
        <p className="meta px-map-notice" role="status">
          {t("map.building")}
        </p>
      ) : null}
      {notice ? (
        <p className="small px-map-notice" role="status">
          {notice}
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
        {!graph ? (
          <div className="px-map-empty">
            <h2 className="title-2">
              {t(building ? "map.building" : wholeSubject ? "map.emptySubject" : "map.empty")}
            </h2>
            <p className="small">{t(wholeSubject ? "map.emptySubjectBody" : "map.emptyBody")}</p>
            <Button disabled={disabled} onClick={() => void generateMaps()}>
              {t(wholeSubject ? "map.generateSubject" : "map.generate")}
            </Button>
          </div>
        ) : (
          <>
            <div className="px-map-canvas" ref={canvas}>
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
              <div className="px-map-fit">
                <IconButton
                  icon="scan"
                  size="sm"
                  label={t("map.fit")}
                  onClick={startView}
                />
              </div>
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
                      aria-label={t("map.tools")}
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
