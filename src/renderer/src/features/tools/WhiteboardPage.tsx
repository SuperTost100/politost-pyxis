import { Button } from "antd";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Download, Paperclip } from "lucide-react";
import { useAppState } from "../../app/app-state";
import { useLeaveGuard } from "../../app/useLeaveGuard";
import { usePlace } from "../../app/usePlace";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";
import { BarTool, StudyLayout } from "../study/StudyBar";
import { strokeHits } from "./strokes";
import "./WhiteboardPage.css";

type Point = { x: number; y: number };
type Stroke = { width: number; points: Point[] };

export function WhiteboardPage() {
  const { t } = useTranslation();
  const { appearance } = useAppState();
  // The chat the board was opened from, which Attach returns to with the picture.
  const back = usePlace({});
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const baseline = useRef(strokes);
  const dirty = useRef(false);
  const current = useRef<Stroke | null>(null);
  // While the eraser is held down: the strokes left so far. One drag is one undo step.
  const erasing = useRef<Stroke[] | null>(null);
  const past = useRef<Stroke[][]>([]);
  const future = useRef<Stroke[][]>([]);
  const board = useRef<HTMLCanvasElement>(null);
  // Set when the student leaves without saving: a save still running then hands nothing on and moves nowhere.
  const left = useRef(false);
  useLeaveGuard({
    dirty: () => dirty.current,
    body: t("tools.leaveBody"),
    onLeave: () => {
      left.current = true;
      sessionStorage.setItem("pyxis-board", JSON.stringify(baseline.current));
      dirty.current = false;
    },
  });

  function paint(next: Stroke[]) {
    const canvas = board.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const colors = getComputedStyle(document.documentElement);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = colors.getPropertyValue("--surface").trim();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = colors.getPropertyValue("--ink").trim();
    for (const stroke of next) {
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      stroke.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      if (stroke.points.length === 1) {
        const point = stroke.points[0]!;
        ctx.lineTo(point.x + 0.01, point.y);
      }
      ctx.stroke();
    }
  }
  function point(event: PointerEvent<HTMLCanvasElement>): Point {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }
  useEffect(() => {
    paint(strokes);
  }, [strokes, appearance.resolved]);

  function apply(next: Stroke[]) {
    dirty.current = JSON.stringify(next) !== JSON.stringify(baseline.current);
    setStrokes(next);
    sessionStorage.setItem("pyxis-board", JSON.stringify(next));
    paint(next);
  }
  function remember(next: Stroke[]) {
    if (JSON.stringify(next) === JSON.stringify(strokes)) return;
    past.current.push(strokes);
    future.current = [];
    apply(next);
  }
  function undo() {
    if (busy || current.current || erasing.current) return;
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(strokes);
    apply(prev);
  }
  function redo() {
    if (busy || current.current || erasing.current) return;
    const next = future.current.pop();
    if (!next) return;
    past.current.push(strokes);
    apply(next);
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        busy ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            "input,textarea,select,[contenteditable='true'],[role='dialog']",
          ))
      )
        return;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (key === "p" || key === "e")
      ) {
        event.preventDefault();
        setTool(key === "p" ? "pen" : "erase");
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [strokes, busy]);

  async function keep(attach: boolean) {
    if (busy || current.current || erasing.current || strokes.length === 0)
      return;
    const url = board.current?.toDataURL("image/png");
    if (!url) return;
    setBusy(true);
    setError(false);
    left.current = false;
    try {
      if (attach) {
        const staged = await invoke("tools.stagePng", { dataUrl: url });
        // Left meanwhile: the staged file is not handed on, or the next chat would attach it.
        if (left.current) return;
        sessionStorage.setItem("pyxis-board-file", staged.path);
      } else {
        const saved = await window.pyxis.saveArtifact({
          filename: "whiteboard.png",
          base64: url.split(",")[1]!,
        });
        if (saved === "cancelled") return;
      }
      if (left.current) return;
      baseline.current = strokes;
      dirty.current = false;
      // Only Attach hands the image to Ask, and Ask takes it together with the staged file.
      if (attach) {
        sessionStorage.setItem("pyxis-board-png", url);
        // Back to the chat the student came from, where their draft and picked files wait.
        back?.go();
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <StudyLayout
      stage
      back={back}
      title={t("tools.whiteboardTitle")}
      subtitle={back?.name}
      tools={
        <>
          <BarTool
            icon={<Download size={16} strokeWidth={1.75} aria-hidden />}
            label={t("tools.save")}
            loading={busy}
            disabled={busy || strokes.length === 0}
            onClick={() => void keep(false)}
          />
          <BarTool
            icon={<Paperclip size={16} strokeWidth={1.75} aria-hidden />}
            label={t("tools.attach")}
            disabled={busy || strokes.length === 0}
            onClick={() => void keep(true)}
          />
        </>
      }
    >
      <div className="px-whiteboard">
        <div
          className="px-whiteboard-toolbar"
          role="toolbar"
          aria-label={t("tools.boardTools")}
        >
          {[2, 4, 8].map((size) => (
            <Button
              key={size}
              shape="circle"
              aria-label={t("tools.penWidth", { size })}
              aria-pressed={width === size}
              disabled={busy}
              type={width === size ? "primary" : "default"}
              onClick={() => setWidth(size)}
            >
              <span
                className="px-whiteboard-width"
                aria-hidden="true"
                style={{ width: size, height: size }}
              />
            </Button>
          ))}
          <Button
            shape="round"
            disabled={busy}
            aria-pressed={tool === "pen"}
            type={tool === "pen" ? "primary" : "default"}
            onClick={() => setTool("pen")}
          >
            {t("tools.pen")}
          </Button>
          <Button
            shape="round"
            disabled={busy}
            aria-pressed={tool === "erase"}
            type={tool === "erase" ? "primary" : "default"}
            onClick={() => setTool("erase")}
          >
            {t("tools.erase")}
          </Button>
          <Button
            shape="round"
            disabled={busy || past.current.length === 0}
            onClick={undo}
          >
            {t("map.undo")}
          </Button>
          <Button
            shape="round"
            disabled={busy || future.current.length === 0}
            onClick={redo}
          >
            {t("tools.redo")}
          </Button>
          <Button
            shape="round"
            disabled={busy || strokes.length === 0}
            onClick={() => remember([])}
          >
            {t("tools.clear")}
          </Button>
        </div>
        <canvas
          ref={board}
          width={1200}
          height={700}
          aria-label={t("tools.whiteboardTitle")}
          onPointerDown={(event) => {
            if (busy) return;
            const at = point(event);
            event.currentTarget.setPointerCapture(event.pointerId);
            if (tool === "erase") {
              erasing.current = strokes.filter(
                (stroke) => !strokeHits(stroke, at),
              );
              paint(erasing.current);
              return;
            }
            current.current = { width, points: [at] };
          }}
          onPointerMove={(event) => {
            if (erasing.current) {
              const at = point(event);
              const left = erasing.current.filter(
                (stroke) => !strokeHits(stroke, at),
              );
              if (left.length !== erasing.current.length) {
                erasing.current = left;
                paint(left);
              }
              return;
            }
            if (!current.current) return;
            current.current.points.push(point(event));
            paint([...strokes, current.current]);
          }}
          onPointerUp={() => {
            if (erasing.current) {
              const left = erasing.current;
              erasing.current = null;
              remember(left);
              return;
            }
            if (!current.current) return;
            const next = [...strokes, current.current];
            current.current = null;
            remember(next);
          }}
          onPointerCancel={() => {
            current.current = null;
            erasing.current = null;
            paint(strokes);
          }}
        />
        {error ? (
          <div className="px-whiteboard-notice">
            <Notice tone="danger">{t("tools.boardFailed")}</Notice>
          </div>
        ) : null}
      </div>
    </StudyLayout>
  );
}
