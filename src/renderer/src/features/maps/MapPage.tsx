import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Modal, Segmented, Select } from "antd";
import {
  Plus,
  Link,
  Trash2,
  Palette,
  Scan,
  Undo2,
  Redo2,
  Download,
  Pencil,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
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
import { toPng, toSvg } from "html-to-image";
import { CanvasLayout } from "../../app/layouts/TaskLayouts";
import { MarkdownView } from "../../components/MarkdownView";
import { invoke } from "../../lib/ipc";
import { mapColors as fills, type MapOp } from "@shared/concept-map";
import "@xyflow/react/dist/style.css";
import {
  NODE_WIDTH,
  initialCollapsed,
  layoutTree,
  parentIds,
  startViewport,
  visibleNodes,
} from "./mapLayout";
import "./MapPage.css";

type FlowNode = Node<
  {
    label: string;
    color: string;
    root: boolean;
    folded: boolean;
    hidden: number;
    hasChildren: boolean;
    toggle: (id: string) => void;
  },
  "concept"
>;
type FlowEdge = Edge<{ label?: string; active: boolean }, "cross">;
function ConceptNode({ id, data }: NodeProps<FlowNode>) {
  const { t } = useTranslation();
  const Chevron = data.folded ? ChevronRight : ChevronLeft;
  return (
    <div
      className={`px-concept-node${data.root ? " is-root" : ""}`}
      style={{
        background: data.color.startsWith("#")
          ? data.color
          : `var(--${data.color})`,
      }}
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
  const { planId = "", topicId = "" } = useParams();
  const client = useQueryClient();
  const [mapId, setMapId] = useState<string>();
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
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  // Real node heights, measured by React Flow, so the layout can leave room for long labels.
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  const [ready, setReady] = useState<string>();
  const [fold, setFold] = useState<{ mapId?: string; ids: Set<string> }>({
    ids: new Set(),
  });
  const viewed = useRef("");
  const flow = useRef<ReactFlowInstance<FlowNode> | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const moves = useRef<Promise<unknown>>(Promise.resolve());
  const listKey = ["maps", planId, topicId];
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => invoke("maps.list", { planId, topicId }),
    refetchInterval: jobId ? 500 : false,
  });
  const build = useQuery({
    queryKey: ["map-build", planId, topicId],
    queryFn: () => invoke("maps.build", { planId, topicId }),
    refetchInterval: (query) =>
      query.state.data && ["queued", "running"].includes(query.state.data.state)
        ? 500
        : false,
  });
  const activeId =
    list.data?.find((m) => m.id === mapId)?.id ?? list.data?.[0]?.id;
  useEffect(() => {
    setMapId(undefined);
    setJobId(undefined);
    setNotice("");
    setInstruction("");
  }, [planId, topicId]);
  const mapKey = ["map", planId, topicId, activeId];
  const map = useQuery({
    queryKey: mapKey,
    enabled: Boolean(activeId),
    queryFn: () => invoke("maps.open", { planId, topicId, mapId: activeId }),
  });
  const graph = map.data;
  const selectedNode = graph?.nodes.find((n) => n.id === selected);
  const root = graph?.nodes.find((n) => n.parent === null);
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
  }, [job?.state, jobId, client, planId, topicId, t]);
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
    setNodes(
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
            root: n.parent === null,
            folded: folded.has(n.id),
            hidden: shown.hidden.get(n.id) ?? 0,
            hasChildren: parents.has(n.id),
            toggle,
            color:
              fills.some((color) => color === n.color) ||
              /^#[0-9a-f]{6}$/i.test(n.color ?? "")
                ? n.color!
                : n.parent === null
                  ? "surface-overlay"
                  : "surface-raised",
          },
        };
      }),
    );
  }, [spots, shown, heights, selected, folded, parents, toggle]);
  useEffect(() => {
    setSelected(undefined);
    setPaletteOpen(false);
    setHeights(new Map());
  }, [activeId]);
  const edges = useMemo(() => {
    const at = new Map(nodes.map((n) => [n.id, n.position.x]));
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
      const base = {
        id: JSON.stringify([e.from, e.to]),
        source,
        target,
        sourceHandle: forward ? "out-r" : "out-l",
        targetHandle: forward ? "in-l" : "in-r",
        focusable: false,
      };
      result.push(
        tree
          ? {
              ...base,
              type: "default",
              style: { stroke: "var(--border-control)", strokeWidth: 1.5 },
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
  }, [graph, nodes, selected]);
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

  async function commit(action: () => Promise<NonNullable<typeof graph>>) {
    if (disabled) return;
    setBusy(true);
    setNotice("");
    try {
      await moves.current.catch(() => undefined);
      const result = await action();
      client.setQueryData(mapKey, result);
    } catch {
      setNotice(t("map.editFailed"));
    } finally {
      setBusy(false);
    }
  }
  function patch(ops: MapOp[]) {
    return commit(() =>
      invoke("maps.patch", { planId, topicId, mapId: activeId, ops }),
    );
  }
  const changes = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
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
        moves.current = moves.current
          .catch(() => undefined)
          .then(() =>
            invoke("maps.move", {
              planId,
              topicId,
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
    [planId, topicId, activeId, client],
  );
  async function generateMaps() {
    setBusy(true);
    setNotice("");
    try {
      const result = await invoke("maps.generate", { planId, topicId });
      setJobId(result.jobId);
      await client.invalidateQueries({ queryKey: listKey });
      await client.invalidateQueries({
        queryKey: ["map-build", planId, topicId],
      });
    } catch {
      setNotice(t("map.generateFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function exportMap(format: "png" | "svg") {
    if (!canvas.current) return;
    setBusy(true);
    setNotice("");
    try {
      await document.fonts.ready;
      const url = await (format === "png" ? toPng : toSvg)(canvas.current, {
        backgroundColor: getComputedStyle(document.documentElement)
          .getPropertyValue("--bg")
          .trim(),
        pixelRatio: 2,
        filter: (el) =>
          !(
            el instanceof HTMLElement &&
            (el.classList.contains("px-map-rail") ||
              el.classList.contains("react-flow__attribution"))
          ),
      });
      const link = document.createElement("a");
      link.href = url;
      link.download = `map.${format}`;
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
  return (
    <CanvasLayout
      title={list.data?.find((m) => m.id === activeId)?.title ?? t("map.title")}
      closeTo={`/plans/${planId}`}
    >
      <div className="px-map-editor">
        <div className="px-map-topbar">
          {graph && (
            <Segmented
              aria-label={t("map.layout")}
              disabled={disabled}
              value={graph?.layout ?? "tree"}
              options={[
                { label: t("map.tree"), value: "tree" },
                { label: t("map.radial"), value: "radial" },
              ]}
              onChange={(layout) =>
                void commit(() =>
                  invoke("maps.layout", {
                    planId,
                    topicId,
                    mapId: activeId,
                    layout: layout as "tree" | "radial",
                  }),
                )
              }
            />
          )}
          {list.data && list.data.length > 1 && (
            <Select
              aria-label={t("map.choose")}
              className="px-map-picker"
              value={activeId}
              disabled={disabled}
              options={list.data.map((m) => ({ label: m.title, value: m.id }))}
              onChange={setMapId}
            />
          )}
          <span className="px-map-top-spacer" />
          {graph && (
            <>
              {(!list.data?.some((m) => m.provider) ||
                (job &&
                  ["failed", "cancelled", "interrupted"].includes(
                    job.state,
                  ))) && (
                <Button
                  shape="round"
                  disabled={disabled}
                  onClick={() => void generateMaps()}
                >
                  {t("map.buildSources")}
                </Button>
              )}
              <Button
                shape="circle"
                aria-label={t("map.undo")}
                disabled={disabled || !graph.undo}
                icon={<Undo2 size={18} />}
                onClick={() =>
                  void commit(() =>
                    invoke("maps.undo", { planId, topicId, mapId: activeId }),
                  )
                }
              />
              <Button
                shape="circle"
                aria-label={t("map.redo")}
                disabled={disabled || !graph.redo}
                icon={<Redo2 size={18} />}
                onClick={() =>
                  void commit(() =>
                    invoke("maps.redo", { planId, topicId, mapId: activeId }),
                  )
                }
              />
              <Button
                shape="round"
                disabled={disabled}
                onClick={() => void exportMap("svg")}
              >
                {t("map.svg")}
              </Button>
              <Button
                shape="round"
                disabled={disabled}
                icon={<Download size={18} />}
                onClick={() => void exportMap("png")}
              >
                {t("map.png")}
              </Button>
            </>
          )}
        </div>
        {building && (
          <p className="meta px-map-notice" role="status">
            {t("map.building")}
          </p>
        )}
        {(notice || map.isError || list.isError) && (
          <p className="small px-map-notice" role="status">
            {notice || t("map.editFailed")}
          </p>
        )}
        {list.data?.find((m) => m.id === activeId)?.grounding === "general" && (
          <p className="meta px-map-notice">{t("map.general")}</p>
        )}
        {!graph ? (
          <div className="px-map-empty">
            <h2 className="title-2">
              {t(building ? "map.building" : "map.empty")}
            </h2>
            <p className="small">{t("map.emptyBody")}</p>
            <Button
              type="primary"
              shape="round"
              loading={disabled}
              onClick={() => void generateMaps()}
            >
              {t("map.generate")}
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
                    disabled
                  )
                    return;
                  if (event.key === "Enter" && selectedNode) {
                    event.preventDefault();
                    rename();
                  }
                  if (event.key === "Delete" && selectedNode?.parent) {
                    event.preventDefault();
                    void patch([{ op: "delete", id: selectedNode.id }]);
                  }
                }}
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={24}
                  size={1}
                  color="var(--border)"
                />
              </ReactFlow>
              <div
                className="px-map-rail"
                role="toolbar"
                aria-label={t("map.tools")}
              >
                <Button
                  type="text"
                  shape="circle"
                  disabled={disabled}
                  aria-label={t("map.add")}
                  icon={<Plus size={18} />}
                  onClick={() => {
                    setLabel("");
                    setDialog("add");
                  }}
                />
                <Button
                  type="text"
                  shape="circle"
                  disabled={disabled || !selectedNode}
                  aria-label={t("map.rename")}
                  icon={<Pencil size={18} />}
                  onClick={rename}
                />
                <Button
                  type="text"
                  shape="circle"
                  disabled={disabled || !selectedNode}
                  aria-label={t("map.connect")}
                  icon={<Link size={18} />}
                  onClick={() => {
                    setTarget(undefined);
                    setDialog("connect");
                  }}
                />
                <Button
                  type="text"
                  shape="circle"
                  disabled={disabled || !selectedNode?.parent}
                  aria-label={t("map.delete")}
                  icon={<Trash2 size={18} />}
                  onClick={() =>
                    selected && void patch([{ op: "delete", id: selected }])
                  }
                />
                <Button
                  type="text"
                  shape="circle"
                  disabled={disabled || !selectedNode}
                  aria-label={t("map.recolor")}
                  icon={<Palette size={18} />}
                  onClick={() => setPaletteOpen((v) => !v)}
                />
                <Button
                  type="text"
                  shape="circle"
                  aria-label={t("map.fit")}
                  icon={<Scan size={18} />}
                  onClick={startView}
                />
                {paletteOpen && selected && (
                  <div
                    className="px-map-palette"
                    role="group"
                    aria-label={t("map.recolor")}
                  >
                    {fills.map((color) => (
                      <button
                        key={color}
                        disabled={disabled}
                        aria-label={t(`map.colors.${color}`)}
                        style={{ background: `var(--${color})` }}
                        onClick={() => {
                          void patch([{ op: "recolor", id: selected, color }]);
                          setPaletteOpen(false);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
            <form
              className="px-map-composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (instruction.trim())
                  void commit(async () => {
                    const result = await invoke("maps.edit", {
                      planId,
                      topicId,
                      mapId: activeId,
                      instruction: instruction.trim(),
                    });
                    setInstruction("");
                    setNotice(t("map.applied"));
                    return result;
                  });
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
                htmlType="submit"
                type="primary"
                shape="round"
                loading={busy}
                disabled={disabled || !instruction.trim()}
              >
                {t("map.apply")}
              </Button>
            </form>
            <p className="meta px-map-help">{t("map.keyboard")}</p>
          </>
        )}
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
    </CanvasLayout>
  );
}
