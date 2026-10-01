import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Modal, Popconfirm, Select } from "antd";
import { GripVertical } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";
import "./SubjectPicker.css";

type Subject = { id: string; name: string };
function SubjectRow({ item, disabled, remove }: { item: Subject; disabled: boolean; remove: () => void }) {
  const { t } = useTranslation();
  const { setNodeRef, setActivatorNodeRef, transform, transition, attributes, listeners } = useSortable({ id: item.id, disabled });
  return <li ref={setNodeRef} className="subject-manager-row" style={{ transform: CSS.Transform.toString(transform), transition }}>
    <button ref={setActivatorNodeRef} type="button" className="subject-drag" {...attributes} {...listeners} aria-label={t("ask.reorderSubject", { name: item.name })} disabled={disabled}>
      <GripVertical size={18} aria-hidden />
    </button>
    <span className="body">{item.name}</span>
    <Popconfirm title={t("ask.removeSubjectConfirm", { name: item.name })} onConfirm={remove} okText={t("ask.removeSubject")} cancelText={t("ask.cancelSubjects")}>
      <Button type="text" disabled={disabled} aria-label={t("ask.removeNamedSubject", { name: item.name })}>{t("ask.removeSubject")}</Button>
    </Popconfirm>
  </li>;
}

export function SubjectPicker({ value, onChange, disabled, managementOnly = false }: { value: string; onChange: (value: string) => void; disabled?: boolean; managementOnly?: boolean }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const subjects = useQuery({ queryKey: ["subjects"], queryFn: () => invoke("subjects.list", {}) });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const change = useMutation({
    mutationFn: async (action: { kind: "add"; name: string } | { kind: "remove"; item: Subject } | { kind: "order"; ids: string[] }) => {
      if (action.kind === "add") {
        const added = await invoke("subjects.add", { name: action.name });
        onChange(added.name); setName("");
      } else if (action.kind === "remove") {
        await invoke("subjects.remove", { id: action.item.id });
        if (value === action.item.name) onChange("");
      } else await invoke("subjects.reorder", { ids: action.ids });
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["subjects"] }); void client.invalidateQueries({ queryKey: ["plans"] }); },
  });
  const rows = subjects.data ?? [];
  const options = rows.map((row) => ({ value: row.name, label: row.name }));
  if (value && !rows.some((row) => row.name === value)) options.push({ value, label: value });
  return <>
    <div className="subject-picker">
      {!managementOnly ? <><span className="small" id="subject-picker-label">{t("ask.subject")}</span>
      <Select value={value || undefined} onChange={(next) => onChange(next ?? "")} aria-labelledby="subject-picker-label" showSearch allowClear disabled={disabled} options={options} placeholder={t("ask.chooseSubject")} /></> : null}
      <Button type="text" disabled={disabled} onClick={() => { change.reset(); setOpen(true); }}>{t("ask.manageSubjects")}</Button>
    </div>
    <Modal open={open} onCancel={() => setOpen(false)} title={t("ask.manageSubjects")} footer={null}>
      <p className="small">{t("ask.subjectOrderHelp")}</p>
      {subjects.isError || change.isError ? <Notice tone="danger">{t("ask.subjectSaveFailed")}</Notice> : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} accessibility={{ screenReaderInstructions: { draggable: t("ask.subjectDragInstructions") }, announcements: {
        onDragStart: ({ active }) => t("ask.subjectPicked", { name: rows.find((row) => row.id === active.id)?.name ?? "" }),
        onDragOver: ({ active, over }) => over ? t("ask.subjectMoved", { name: rows.find((row) => row.id === active.id)?.name ?? "", position: rows.findIndex((row) => row.id === over.id) + 1, count: rows.length }) : undefined,
        onDragEnd: ({ active, over }) => t("ask.subjectDropped", { name: rows.find((row) => row.id === active.id)?.name ?? "", position: rows.findIndex((row) => row.id === (over?.id ?? active.id)) + 1 }),
        onDragCancel: () => t("ask.subjectDragCancelled"),
      } }} onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id || change.isPending) return;
        const from = rows.findIndex((row) => row.id === active.id);
        const to = rows.findIndex((row) => row.id === over.id);
        if (from >= 0 && to >= 0) change.mutate({ kind: "order", ids: arrayMove(rows, from, to).map((row) => row.id) });
      }}>
        <SortableContext items={rows.map((row) => row.id)} strategy={verticalListSortingStrategy}>
          <ul className="subject-manager-list">{rows.map((item) => <SubjectRow key={item.id} item={item} disabled={change.isPending} remove={() => change.mutate({ kind: "remove", item })} />)}</ul>
        </SortableContext>
      </DndContext>
      <form className="subject-manager-add" onSubmit={(event) => { event.preventDefault(); if (name.trim()) change.mutate({ kind: "add", name }); }}>
        <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} aria-label={t("ask.newSubject")} placeholder={t("ask.newSubject")} disabled={change.isPending} />
        <Button htmlType="submit" type="primary" disabled={!name.trim() || change.isPending}>{t("ask.addSubject")}</Button>
      </form>
    </Modal>
  </>;
}
