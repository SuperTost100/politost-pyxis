import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { CanvasLayout } from "../../app/layouts/TaskLayouts";
import { invoke } from "../../lib/ipc";

export function MapPage() {
  const { t } = useTranslation();
  const { planId, topicId } = useParams();
  const client = useQueryClient();
  const [label, setLabel] = useState("");
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
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
        <Button shape="round" disabled={!graph?.undo} onClick={() => void invoke("maps.undo", { planId: planId ?? "", topicId: topicId ?? "" }).then(refresh)}>
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
            void invoke("maps.patch", {
              planId: planId ?? "",
              topicId: topicId ?? "",
              ops: [{ op: "add_node", id: `n-${Date.now()}`, label: label.trim(), parent: "root" }],
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
        role="img"
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
            transform={`translate(${node.x} ${node.y})`}
            style={{ cursor: "grab" }}
            onPointerDown={(event) => {
              const startX = event.clientX;
              const startY = event.clientY;
              const origin = { x: node.x, y: node.y };
              const target = event.currentTarget;
              target.setPointerCapture(event.pointerId);
              const scale = bounds.width / Math.max(target.ownerSVGElement?.clientWidth ?? 1, 1);
              const move = (ev: PointerEvent) => {
                setDrag({
                  id: node.id,
                  x: Math.round(origin.x + (ev.clientX - startX) * scale),
                  y: Math.round(origin.y + (ev.clientY - startY) * scale),
                });
              };
              const up = (ev: PointerEvent) => {
                target.removeEventListener("pointermove", move);
                target.removeEventListener("pointerup", up);
                const x = Math.round(origin.x + (ev.clientX - startX) * scale);
                const y = Math.round(origin.y + (ev.clientY - startY) * scale);
                setDrag(null);
                void invoke("maps.move", {
                  planId: planId ?? "",
                  topicId: topicId ?? "",
                  nodeId: node.id,
                  x,
                  y,
                }).then(refresh);
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
  for (const edge of edges) {
    const from = nodes.find((node) => node.id === edge.from);
    const to = nodes.find((node) => node.id === edge.to);
    if (!from || !to) continue;
    ctx.beginPath();
    ctx.moveTo(px(from.x), py(from.y));
    ctx.lineTo(px(to.x), py(to.y));
    ctx.stroke();
  }
  ctx.fillStyle = "#e8ebf2";
  ctx.font = "16px sans-serif";
  ctx.textAlign = "center";
  for (const node of nodes) ctx.fillText(node.label.slice(0, 22), px(node.x), py(node.y));
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = "map.png";
  link.click();
}
