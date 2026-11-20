import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CircleAlert, CircleCheck, CircleDashed, GripVertical } from "lucide-react";
import { useRef, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { MenuButton, useItemMenu } from "../../components/ItemMenu";
import { Logo } from "../../components/Logo";

/** The items and the choice handler of a tool's menu, as the app's menu button takes them. */
export type ToolMenu = ComponentProps<typeof MenuButton>["menu"];

export type Tool = {
  id: string;
  name: string;
  /** The line under the name: the program behind the tool and the models it works on. */
  detail: string;
  /**
   * The three roles with the model each one runs, drawn in place of `detail`: the role in the quiet colour, the model
   * in the normal one. Said only once the tool's models are known.
   */
  roles?: Array<{ role: string; label: string; model: string }>;
  /** Lines under the roles: when the requests return, a model the plan leaves out, a task that runs in another role. */
  notes?: string[];
  /** Its place among the tools in use, once the student has set an order. */
  position?: number;
  state: { tone: "ok" | "warn" | "idle"; text: string };
  /** Work on this tool that is running now, such as a test: said in place of its state. */
  working?: string;
  /** Turned off by the student: it keeps its place but takes no work. */
  off: boolean;
  menu: ToolMenu;
  /** The row's own button, such as Scollega. */
  action?: ReactNode;
};

const STATE_ICONS = { ok: CircleCheck, warn: CircleAlert, idle: CircleDashed };

function ToolRow({ tool, sortable, disabled }: { tool: Tool; sortable: boolean; disabled: boolean }) {
  const { t } = useTranslation();
  const { setNodeRef, setActivatorNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    id: tool.id,
    disabled: !sortable || disabled,
  });
  const region = t("engines.tool.actions", { name: tool.name });
  const { bind, popup } = useItemMenu({ menu: tool.menu, region });
  const StateIcon = STATE_ICONS[tool.state.tone];
  return (
    <li
      ref={setNodeRef}
      className={["engines-tool", isDragging && "is-dragging", tool.off && "is-off"].filter(Boolean).join(" ")}
      // The row moves up and down only, whatever the pointer does sideways, and keeps its size over a taller or
      // shorter neighbour.
      style={{ transform: CSS.Translate.toString(transform && { ...transform, x: 0 }), transition }}
      data-tool={tool.id}
      {...bind}
    >
      {sortable ? (
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="engines-grip"
          {...attributes}
          {...listeners}
          aria-label={t("engines.order.reorder", { name: tool.name })}
        >
          <GripVertical size={18} strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
      {tool.position ? (
        <span className="engines-tool-n" aria-hidden>
          {tool.position}
        </span>
      ) : null}
      <div className="px-ctl-text">
        <span className="px-ctl-title">
          <span className="engines-tool-name">{tool.name}</span>
          {tool.position ? <span className="visually-hidden">{t("engines.order.place", { position: tool.position })}</span> : null}
        </span>
        {tool.roles ? (
          <>
            <span className="px-ctl-description engines-roles" data-roles>
              {tool.roles.map((item) => (
                <span key={item.role} data-role={item.role}>
                  <span className="engines-role">{item.label}</span> <span className="engines-role-model">{item.model}</span>
                </span>
              ))}
            </span>
            {tool.notes?.map((note) => (
              <span key={note} className="px-ctl-description">
                {note}
              </span>
            ))}
          </>
        ) : (
          <span className="px-ctl-description">{tool.detail}</span>
        )}
      </div>
      {tool.working ? (
        <span className="engines-tool-state is-working" role="status">
          <Logo size={16} working decorative />
          {tool.working}
        </span>
      ) : (
        <span className={`engines-tool-state is-${tool.state.tone}`}>
          <StateIcon size={16} strokeWidth={1.75} aria-hidden />
          {tool.state.text}
        </span>
      )}
      {tool.action}
      <MenuButton size="sm" menu={tool.menu} label={region} />
      {popup}
    </li>
  );
}

/**
 * The student's connected tools, in the order Pyxis uses them. A row is moved by dragging its grip, or with the
 * keyboard on the grip: Space picks the tool up, the arrows move it, Space drops it and Escape puts it back. Each step
 * is announced to screen readers. The row's menu, on the dots and on a right-click, moves it one place as well.
 */
export function ToolList({
  tools,
  disabled,
  onMove,
}: {
  tools: Tool[];
  /** While an order is being saved the rows stay where they are. */
  disabled: boolean;
  onMove: (from: number, to: number) => void;
}) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const nameOf = (id: string | number) => tools.find((tool) => tool.id === id)?.name ?? "";
  const placeOf = (id: string | number) => tools.findIndex((tool) => tool.id === id) + 1;
  const sortable = tools.length > 1;
  // True from the moment a tool is picked up until its first report of where it is.
  const lifted = useRef(false);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{
        screenReaderInstructions: { draggable: t("engines.order.instructions") },
        announcements: {
          onDragStart: ({ active }) => {
            lifted.current = true;
            return t("engines.order.picked", {
              name: nameOf(active.id),
              position: placeOf(active.id),
              count: tools.length,
            });
          },
          onDragOver: ({ active, over }) => {
            // A tool just picked up is over its own place, which the pick-up has already said.
            const first = lifted.current;
            lifted.current = false;
            if (!over || (first && over.id === active.id)) return undefined;
            return t("engines.order.moved", {
              name: nameOf(active.id),
              position: placeOf(over.id),
              count: tools.length,
            });
          },
          onDragEnd: ({ active, over }) =>
            t("engines.order.dropped", {
              name: nameOf(active.id),
              position: placeOf(over?.id ?? active.id),
              count: tools.length,
            }),
          onDragCancel: ({ active }) => t("engines.order.cancelled", { name: nameOf(active.id) }),
        },
      }}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return;
        const from = placeOf(active.id) - 1;
        const to = placeOf(over.id) - 1;
        if (from >= 0 && to >= 0) onMove(from, to);
      }}
    >
      <SortableContext items={tools.map((tool) => tool.id)} strategy={verticalListSortingStrategy}>
        <ul className="px-ctl engines-tools">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} sortable={sortable} disabled={disabled} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
