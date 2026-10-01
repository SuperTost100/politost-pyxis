import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { CanvasLayout } from "../../app/layouts/TaskLayouts";
import { invoke } from "../../lib/ipc";
import { branchFromInstruction } from "../../../../core/maps/graph";

export function MapPage() {
  const { t } = useTranslation();
  const { planId, topicId } = useParams();
  const client = useQueryClient();
  const [label, setLabel] = useState("");
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const keyPos = useRef(new Map<string, { x: number; y: number }>());
  const keyChain = useRef(new Map<string, Promise<unknown>>());
  const moveGen = useRef(new Map<string, number>());
  const map = useQuery({
    queryKey: ["map", planId, topicId],
    enabled: Boolean(planId && topicId),
    queryFn: () => invoke("maps.open", { planId: planId ?? "", topicId: topicId ?? "" }),
  });
  const graph = map.data;
  const nodes = (graph?.nodes ?? []).map((node) =>
    drag?.id === node.id ? { ...node, x: drag.x, y: drag.y } : node,
  );
  const bounds = boundsOf(nodes);

  function refresh() {
    void client.invalidateQueries({ queryKey: ["map", planId, topicId] });
  }

  return (
    <CanvasLayout title={t("map.title")} closeTo={`/plans/${planId ?? ""}`}>
      <div className="gallery-row">
        <Button
          shape="round"
          type={graph?.layout === "tree" ? "primary" : "default"}
          onClick={() =>
            void invoke("maps.layout", {
              planId: planId ?? "",
              topicId: topicId ?? "",
              layout: "tree",
            }).then(refresh)
          }
        >
          {t("map.tree")}
        </Button>
        <Button
          shape="round"
          type={graph?.layout === "radial" ? "primary" : "default"}
          onClick={() =>
            void invoke("maps.layout", {
              planId: planId ?? "",
              topicId: topicId ?? "",
              layout: "radial",
            }).then(refresh)
          }
        >
          {t("map.radial")}
        </Button>
        <Button shape="round" disabled={!graph?.undo} onClick={() => {
          const pending = [...keyChain.current.values()];
          for (const id of keyChain.current.keys()) {
            moveGen.current.set(id, (moveGen.current.get(id) ?? 0) + 1);
          }
          keyPos.current.clear();
          void Promise.all(pending.map((job) => job.catch(() => undefined))).then(() =>
            invoke("maps.undo", { planId: planId ?? "", topicId: topicId ?? "" }).then(refresh),
          );
        }}>
          {t("map.undo")}
        </Button>
        <Button shape="round" onClick={() => downloadPng(nodes, graph?.edges ?? [])}>
          {t("map.png")}
        </Button>
        <Input
          aria-label={t("map.add")}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          style={{ maxWidth: 240 }}
        />
        <Button
          type="primary"
          shape="round"
          disabled={label.trim() === ""}
          onClick={() => {
            const branch = branchFromInstruction(label);
            void invoke("maps.patch", {
              planId: planId ?? "",
              topicId: topicId ?? "",
              ops: [
                {
                  op: "add_node",
                  id: `n-${Date.now()}`,
                  label: branch ?? label.trim(),
                  parent: "root",
                },
              ],
            }).then(() => {
              setLabel("");
              refresh();
            });
          }}
        >
          {t("map.add")}
        </Button>
      </div>
      <svg
        className="px-map"
        role="group"
        aria-label={t("map.title")}
        viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
        style={{ width: "100%", height: "70vh", background: "transparent" }}
      >
        {(graph?.edges ?? []).map((edge) => {
          const from = nodes.find((node) => node.id === edge.from);
          const to = nodes.find((node) => node.id === edge.to);
          if (!from || !to) return null;
          return (
            <line
              key={`${edge.from}-${edge.to}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="currentColor"
              strokeWidth={1.5}
            />
          );
        })}
        {nodes.map((node) => (
          <g
            key={node.id}
            tabIndex={0}
            role="button"
            aria-label={node.label}
            transform={`translate(${node.x} ${node.y})`}
            style={{ cursor: "grab" }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 48 : 16;
              const dx =
                event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
              const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
              if ((dx === 0 && dy === 0) || !planId || !topicId) return;
              event.preventDefault();
              const current = keyPos.current.get(node.id) ?? { x: node.x, y: node.y };
              const x = current.x + dx;
              const y = current.y + dy;
              keyPos.current.set(node.id, { x, y });
              const gen = moveGen.current.get(node.id) ?? 0;
              const prev = keyChain.current.get(node.id) ?? Promise.resolve();
              const job = prev.catch(() => undefined).then(() => {
                if ((moveGen.current.get(node.id) ?? 0) !== gen) return;
                return invoke("maps.move", { planId, topicId, nodeId: node.id, x, y }).then(refresh);
              });
              keyChain.current.set(node.id, job);
            }}
            onPointerDown={(event) => {
              const origin = { x: node.x, y: node.y };
              const gen = (moveGen.current.get(node.id) ?? 0) + 1;
              moveGen.current.set(node.id, gen);
              keyPos.current.delete(node.id);
              const pending = keyChain.current.get(node.id) ?? Promise.resolve();
              const svg = event.currentTarget.ownerSVGElement;
              const target = event.currentTarget;
              target.setPointerCapture(event.pointerId);
              const local = (ev: PointerEvent) => svgPoint(svg, ev.clientX, ev.clientY);
              const originPointer = local(event.nativeEvent);
              const move = (ev: PointerEvent) => {
                const point = local(ev);
                setDrag({
                  id: node.id,
                  x: Math.round(origin.x + point.x - originPointer.x),
                  y: Math.round(origin.y + point.y - originPointer.y),
                });
              };
              const up = (ev: PointerEvent) => {
                target.removeEventListener("pointermove", move);
                target.removeEventListener("pointerup", up);
                const point = local(ev);
                const x = Math.round(origin.x + point.x - originPointer.x);
                const y = Math.round(origin.y + point.y - originPointer.y);
                setDrag(null);
                const job = pending.catch(() => undefined).then(() => {
                  if ((moveGen.current.get(node.id) ?? 0) !== gen) return;
                  return invoke("maps.move", {
                    planId: planId ?? "",
                    topicId: topicId ?? "",
                    nodeId: node.id,
                    x,
                    y,
                  }).then(refresh);
                });
                keyChain.current.set(node.id, job);
              };
              target.addEventListener("pointermove", move);
              target.addEventListener("pointerup", up);
            }}
          >
            <rect x={-70} y={-22} width={140} height={44} rx={12} fill={node.color ?? "var(--surface)"} stroke="currentColor" />
            <text textAnchor="middle" dominantBaseline="middle" fill="currentColor" fontSize={13}>
              {node.label.slice(0, 22)}
            </text>
          </g>
        ))}
      </svg>
    </CanvasLayout>
  );
}

function svgPoint(svg: SVGSVGElement | null, clientX: number, clientY: number) {
  if (!svg) return { x: 0, y: 0 };
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const matrix = svg.getScreenCTM();
  if (!matrix) return { x: 0, y: 0 };
  const local = point.matrixTransform(matrix.inverse());
  return { x: local.x, y: local.y };
}

function boundsOf(nodes: Array<{ x: number; y: number }>) {
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const minX = Math.min(0, ...xs) - 120;
  const minY = Math.min(0, ...ys) - 80;
  const maxX = Math.max(0, ...xs) + 120;
  const maxY = Math.max(0, ...ys) + 80;
  return { minX, minY, width: Math.max(400, maxX - minX), height: Math.max(300, maxY - minY) };
}

function downloadPng(
  nodes: Array<{ id: string; x: number; y: number; label: string }>,
  edges: Array<{ from: string; to: string }>,
) {
  const bounds = boundsOf(nodes);
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = Math.round((1200 * bounds.height) / bounds.width);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#101218";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const sx = canvas.width / bounds.width;
  const sy = canvas.height / bounds.height;
  const px = (x: number) => (x - bounds.minX) * sx;
  const py = (y: number) => (y - bounds.minY) * sy;
  ctx.strokeStyle = "#d7dbe6";
  ctx.lineWidth = 2;
  for (const edge of edges) {
    const from = nodes.find((node) => node.id === edge.from);
    const to = nodes.find((node) => node.id === edge.to);
    if (!from || !to) continue;
    ctx.beginPath();
    ctx.moveTo(px(from.x), py(from.y));
    ctx.lineTo(px(to.x), py(to.y));
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "16px sans-serif";
  for (const node of nodes) {
    const x = px(node.x);
    const y = py(node.y);
    const w = 140 * sx;
    const h = 44 * sy;
    ctx.fillStyle = "#1c2230";
    ctx.strokeStyle = "#d7dbe6";
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#e8ebf2";
    ctx.fillText(node.label.slice(0, 22), x, y);
  }
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = "map.png";
  link.click();
}
