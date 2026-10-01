import { Button } from "antd";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { CanvasLayout } from "../../app/layouts/TaskLayouts";
import { invoke } from "../../lib/ipc";
import { strokeHits } from "./strokes";

type Point = { x: number; y: number };
type Stroke = { width: number; points: Point[] };

export function WhiteboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tool, setTool] = useState<"pen" | "erase">("pen");
  const [strokes, setStrokes] = useState<Stroke[]>(() => {
    try {
      const saved = sessionStorage.getItem("pyxis-board");
      return saved ? (JSON.parse(saved) as Stroke[]) : [];
    } catch {
      return [];
    }
  });
  const [width, setWidth] = useState(4);
  const current = useRef<Stroke | null>(null);
  const past = useRef<Stroke[][]>([]);
  const future = useRef<Stroke[][]>([]);
  const board = useRef<HTMLCanvasElement>(null);

  function paint(next: Stroke[]) {
    const canvas = board.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#101218";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.strokeStyle = "#e8ebf2";
    for (const stroke of next) {
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      stroke.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
    }
  }

  function point(event: PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    const canvas = event.currentTarget;
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  useEffect(() => {
    paint(strokes);
  }, []);

  function remember(next: Stroke[]) {
    past.current.push(strokes);
    future.current = [];
    setStrokes(next);
    sessionStorage.setItem("pyxis-board", JSON.stringify(next));
    paint(next);
  }

  function undo() {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(strokes);
    setStrokes(prev);
    sessionStorage.setItem("pyxis-board", JSON.stringify(prev));
    paint(prev);
  }

  function redo() {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(strokes);
    setStrokes(next);
    sessionStorage.setItem("pyxis-board", JSON.stringify(next));
    paint(next);
  }

  return (
    <CanvasLayout title={t("tools.whiteboardTitle")} closeTo="/ask">
      <div className="gallery-row">
        {[2, 4, 8].map((size) => (
          <Button
            key={size}
            shape="round"
            type={width === size ? "primary" : "default"}
            onClick={() => setWidth(size)}
          >
            {size}
          </Button>
        ))}
        <Button
          shape="round"
          type={tool === "pen" ? "primary" : "default"}
          onClick={() => setTool("pen")}
        >
          {t("tools.pen")}
        </Button>
        <Button
          shape="round"
          type={tool === "erase" ? "primary" : "default"}
          onClick={() => setTool("erase")}
        >
          {t("tools.erase")}
        </Button>
        <Button shape="round" onClick={undo}>
          {t("map.undo")}
        </Button>
        <Button shape="round" onClick={redo}>
          {t("tools.redo")}
        </Button>
        <Button
          type="primary"
          shape="round"
          onClick={() => {
            sessionStorage.setItem("pyxis-board", JSON.stringify(strokes));
            const url = board.current?.toDataURL("image/png");
            if (!url) return;
            sessionStorage.setItem("pyxis-board-png", url);
            const link = document.createElement("a");
            link.href = url;
            link.download = "whiteboard.png";
            link.click();
          }}
        >
          {t("tools.save")}
        </Button>
        <Button
          shape="round"
          onClick={() => {
            const url = board.current?.toDataURL("image/png");
            if (!url) return;
            void invoke("tools.stagePng", { dataUrl: url }).then((staged) => {
              sessionStorage.setItem("pyxis-board-file", staged.path);
              navigate("/ask");
            });
          }}
        >
          {t("tools.attach")}
        </Button>
      </div>
      <canvas
        ref={board}
        width={1200}
        height={700}
        aria-label={t("tools.whiteboardTitle")}
        style={{ width: "100%", height: "70vh", touchAction: "none", background: "#101218" }}
        onPointerDown={(event) => {
          const at = point(event);
          if (tool === "erase") {
            remember(strokes.filter((stroke) => !strokeHits(stroke, at)));
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          current.current = { width, points: [at] };
        }}
        onPointerMove={(event) => {
          if (!current.current) return;
          current.current.points.push(point(event));
          paint([...strokes, current.current]);
        }}
        onPointerUp={() => {
          if (!current.current) return;
          const next = [...strokes, current.current];
          current.current = null;
          remember(next);
        }}
      />
    </CanvasLayout>
  );
}
