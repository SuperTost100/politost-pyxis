import { useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Input, Steps, Tree } from "antd";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RequestInput, RequestOutput } from "@shared/ipc";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { Notice } from "../../components/Notice";
import { StepLines } from "../../components/StepLines";
import { Tag } from "../../components/Tag";
import { invoke } from "../../lib/ipc";
import {
  addSubtopic,
  addTopic,
  drop,
  fromProposal,
  isTopic,
  canDrop,
  move,
  remove,
  rename,
  toDraftTopics,
  type DraftNode,
} from "./draftTree";
import { isWizardSeed, seedExamAt, type WizardSeed } from "./wizardSeed";
import "./PlanPage.css";
import "./PlanWizard.css";
import "./GuidedPlan.css";

type Style = "read" | "practice" | "decide";
type Module = { title: string; summary: string };
const periods = ["y1", "y2", "y3", "y4", "y5", "s1", "s2"] as const;
const MAX_TOPICS = 40;

/** The generic internal error says nothing a student can act on; the step's own message points at Settings. */
function errorKey(err: unknown): string {
  const key =
    err && typeof err === "object" && "messageKey" in err
      ? String((err as { messageKey: unknown }).messageKey)
      : "";
  return !key || key === "errors.internal" ? "wizard.guided.failed" : key;
}

/** PLAN-10 to PLAN-12: a fixed sequence of choices, then an editable draft tree. */
export function GuidedPlanPage() {
  const location = useLocation();
  return isWizardSeed(location.state) ? (
    <Guided seed={location.state} />
  ) : (
    <Navigate to="/plans/new" replace />
  );
}

function Guided({ seed }: { seed: WizardSeed }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [language, setLanguage] = useState(seed.language);
  const [modules, setModules] = useState<Module[]>([]);
  const [focus, setFocus] = useState<number[]>([]);
  const [style, setStyle] = useState<Style>("decide");
  const [nodes, setNodes] = useState<DraftNode[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [focusKey, setFocusKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Each model call is tagged so a result that arrives after Back is ignored.
  const call = useRef(0);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    call.current += 1;
    cancel.current?.();
  }, []);
  async function proposal<N extends "plans.proposeModules" | "plans.proposeTree">(
    name: N,
    input: RequestInput<N>,
  ): Promise<RequestOutput<N>> {
    cancel.current?.();
    const handle = window.pyxis.stream(name, input, () => {});
    cancel.current = handle.cancel;
    try {
      return await handle.result as RequestOutput<N>;
    } finally {
      if (cancel.current === handle.cancel) cancel.current = null;
    }
  }
  // What the stored modules and tree were built from; unchanged answers reuse them.
  const built = useRef({ modules: "", tree: "" });

  const labels = periods
    .filter((id) => picked.includes(id))
    .map((id) =>
      t(`wizard.guided.${id[0] === "y" ? "year" : "semester"}`, {
        n: id.slice(1),
      }),
    );
  const subject = seed.subject.trim() || seed.title.trim();

  async function propose() {
    const key = JSON.stringify([labels, language]);
    setError(null);
    if (built.current.modules === key && modules.length) return setStep(2);
    const id = (call.current += 1);
    setStep(1);
    try {
      const result = await proposal("plans.proposeModules", {
        subject,
        semesters: labels,
        language,
      });
      if (id !== call.current) return;
      built.current = { modules: key, tree: "" };
      setModules(result.modules);
      setFocus([]);
      setStep(2);
    } catch (err) {
      if (id === call.current) setError(errorKey(err));
    }
  }

  async function buildTree() {
    const key = JSON.stringify([focus, style, built.current.modules]);
    setError(null);
    if (built.current.tree === key && nodes.length) return setStep(5);
    const id = (call.current += 1);
    setStep(4);
    try {
      const result = await proposal("plans.proposeTree", {
        subject,
        semesters: labels,
        language,
        style,
        modules: modules.map((module, i) => ({
          ...module,
          focus: focus.includes(i),
        })),
      });
      if (id !== call.current) return;
      const tree = fromProposal(result.topics);
      built.current.tree = key;
      setNodes(tree);
      setExpanded(tree.map((node) => node.key));
      setStep(5);
    } catch (err) {
      if (id === call.current) setError(errorKey(err));
    }
  }

  async function create() {
    const topics = toDraftTopics(nodes);
    if (!topics.length || creating) return;
    setCreating(true);
    setError(null);
    try {
      const result = await invoke("plans.create", {
        title: seed.title.trim(),
        subject: seed.subject.trim() || undefined,
        sourceIds: [],
        examAt: seedExamAt(seed),
        target: seed.target / 100,
        language,
        style,
        draftTopics: topics,
      });
      await client.invalidateQueries({ queryKey: ["plans"] });
      navigate(`/plans/new?build=${result.planId}`, { replace: true });
    } catch (err) {
      setError(errorKey(err));
      setCreating(false);
    }
  }

  function back() {
    call.current += 1;
    cancel.current?.();
    setError(null);
    if (step === 0)
      navigate("/plans/new", { state: { wizard: seed, step: 3 } });
    else if (step === 1) setStep(0);
    else if (step === 2) setStep(0);
    else if (step === 3) setStep(2);
    else if (step === 4) setStep(3);
    else setStep(3);
  }

  const loading = step === 1 || step === 4;
  const shown = [0, 0, 1, 2, 2, 3][step]!;
  const primary = loading ? null : step === 0 ? (
    <Button
      type="primary"
      shape="round"
      disabled={!picked.length}
      onClick={() => void propose()}
    >
      {t("wizard.continue")}
    </Button>
  ) : step === 2 ? (
    <Button type="primary" shape="round" onClick={() => setStep(3)}>
      {t("wizard.continue")}
    </Button>
  ) : step === 3 ? (
    <Button type="primary" shape="round" onClick={() => void buildTree()}>
      {t("wizard.continue")}
    </Button>
  ) : (
    <Button
      className="px-wizard-create"
      type="primary"
      shape="round"
      disabled={creating || !toDraftTopics(nodes).length}
      onClick={() => void create()}
    >
      {t("wizard.create")}
    </Button>
  );

  return (
    <FocusLayout
      title={t("wizard.guided.title")}
      progress={(step + 1) / 6}
      secondary={
        <Button type="text" shape="round" onClick={back}>
          {t("nav.back")}
        </Button>
      }
      primary={primary}
    >
      <div className="px-plan-wizard">
        <Steps
          size="small"
          current={shown}
          items={(["period", "modules", "style", "topics"] as const).map(
            (id) => ({
              title: t(`wizard.guided.steps.${id}`),
            }),
          )}
        />
        <h2 className="title-1 px-wizard-question">
          {t(`wizard.guided.questions.${step}`)}
        </h2>
        {loading ? (
          <>
            <StepLines
              label={t(`wizard.guided.questions.${step}`)}
              steps={[
                {
                  id: step === 1 ? "modules" : "tree",
                  label: t(
                    step === 1
                      ? "wizard.guided.proposing"
                      : "wizard.guided.building",
                  ),
                  state: error ? "failed" : "running",
                },
              ]}
            />
            {error ? (
              <Notice
                tone="danger"
                action={{
                  label: t("wizard.retry"),
                  onClick: () => void (step === 1 ? propose() : buildTree()),
                }}
              >
                {t(error, { defaultValue: t("wizard.guided.failed") })}
              </Notice>
            ) : null}
          </>
        ) : null}
        {step === 0 ? (
          <>
            <p className="small ink-muted">{t("wizard.guided.periodHelp")}</p>
            <div
              className="px-guided-pills"
              role="group"
              aria-label={t("wizard.guided.steps.period")}
            >
              {periods.map((id) => {
                const on = picked.includes(id);
                return (
                  <button
                    type="button"
                    key={id}
                    className={on ? "choice is-selected" : "choice"}
                    aria-pressed={on}
                    onClick={() =>
                      setPicked((list) =>
                        on ? list.filter((x) => x !== id) : [...list, id],
                      )
                    }
                  >
                    {t(`wizard.guided.${id[0] === "y" ? "year" : "semester"}`, {
                      n: id.slice(1),
                    })}
                  </button>
                );
              })}
            </div>
            <div className="px-form-field">
              <span className="label" id="guided-language">
                {t("wizard.language")}
              </span>
              <div
                className="px-guided-pills"
                role="group"
                aria-labelledby="guided-language"
              >
                {(["it", "en"] as const).map((id) => (
                  <button
                    type="button"
                    key={id}
                    className={
                      language === id ? "choice is-selected" : "choice"
                    }
                    aria-pressed={language === id}
                    onClick={() => setLanguage(id)}
                  >
                    {t(id === "it" ? "wizard.italian" : "wizard.english")}
                  </button>
                ))}
              </div>
              <p className="small ink-muted">{t("wizard.languageLocked")}</p>
            </div>
          </>
        ) : null}
        {step === 2 ? (
          <>
            <p className="small ink-muted">{t("wizard.guided.moduleHelp")}</p>
            <div className="choice-list">
              {modules.map((module, i) => (
                <label
                  key={`${i}:${module.title}`}
                  className={
                    focus.includes(i) ? "choice is-selected" : "choice"
                  }
                >
                  <span className="px-guided-module">
                    <span className="body-strong">{module.title}</span>
                    <span className="small ink-muted">{module.summary}</span>
                  </span>
                  <Checkbox
                    checked={focus.includes(i)}
                    aria-label={module.title}
                    onChange={() =>
                      setFocus((list) =>
                        list.includes(i)
                          ? list.filter((x) => x !== i)
                          : [...list, i],
                      )
                    }
                  />
                </label>
              ))}
            </div>
          </>
        ) : null}
        {step === 3 ? (
          <div className="choice-list">
            {(["read", "practice", "decide"] as const).map((id) => (
              <button
                type="button"
                key={id}
                className={style === id ? "choice is-selected" : "choice"}
                aria-pressed={style === id}
                onClick={() => setStyle(id)}
              >
                <span className="body-strong">{t(`wizard.${id}`)}</span>
                <span className="small">{t(`wizard.styleHelp.${id}`)}</span>
              </button>
            ))}
          </div>
        ) : null}
        {step === 5 ? (
          <>
            <Notice tone="warning">{t("plans.draft")}</Notice>
            <p className="small ink-muted">{t("wizard.guided.treeHelp")}</p>
            <TreeEditor
              nodes={nodes}
              expanded={expanded}
              focusKey={focusKey}
              onExpand={setExpanded}
              onChange={setNodes}
              onAdd={(key, parent) => {
                setFocusKey(key);
                if (parent)
                  setExpanded((list) => [...new Set([...list, parent])]);
              }}
            />
            {error ? (
              <p className="small" role="alert">
                {t(error, { defaultValue: t("wizard.guided.failed") })}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </FocusLayout>
  );
}

function TreeEditor({
  nodes,
  expanded,
  focusKey,
  onExpand,
  onChange,
  onAdd,
}: {
  nodes: DraftNode[];
  expanded: string[];
  focusKey: string;
  onExpand: (keys: string[]) => void;
  onChange: (nodes: DraftNode[]) => void;
  onAdd: (key: string, parent?: string) => void;
}) {
  const { t } = useTranslation();
  const titleOf = (key: string) =>
    nodes
      .flatMap((node) => [node, ...node.subtopics])
      .find((item) => item.key === key)?.title ?? "";
  return (
    <div className="px-guided-tree">
      <Tree
        blockNode
        selectable={false}
        draggable={{ icon: false }}
        expandedKeys={expanded}
        onExpand={(keys) => onExpand(keys.map(String))}
        treeData={nodes.map((node) => ({
          key: node.key,
          title: node.title,
          children: node.subtopics.map((sub) => ({
            key: sub.key,
            title: sub.title,
          })),
        }))}
        allowDrop={({ dragNode, dropNode, dropPosition }) =>
          canDrop(
            nodes,
            String(dragNode.key),
            String(dropNode.key),
            dropPosition,
          )
        }
        onDrop={(info) => {
          const relative = info.dropToGap
            ? info.dropPosition - Number(info.node.pos.split("-").at(-1))
            : 0;
          const position = relative === 0 ? 0 : relative > 0 ? 1 : -1;
          onChange(
            drop(
              nodes,
              String(info.dragNode.key),
              String(info.node.key),
              position,
            ),
          );
        }}
        titleRender={(item) => {
          const key = String(item.key);
          const topic = isTopic(nodes, key);
          const title = titleOf(key);
          return (
            <div className="px-guided-node">
              <Input
                variant="borderless"
                maxLength={160}
                autoFocus={key === focusKey}
                value={title}
                aria-label={t(
                  topic
                    ? "wizard.guided.topicName"
                    : "wizard.guided.subtopicName",
                )}
                placeholder={t(
                  topic
                    ? "wizard.guided.topicName"
                    : "wizard.guided.subtopicName",
                )}
                onChange={(event) =>
                  onChange(rename(nodes, key, event.target.value))
                }
                // Arrow keys and Space belong to the text field, not to tree navigation.
                onKeyDown={(event) => event.stopPropagation()}
              />
              <Tag>{t("components.tags.ai")}</Tag>
              <span className="px-guided-actions">
                <Button
                  type="text"
                  size="small"
                  aria-label={t("wizard.guided.moveUp", { title })}
                  icon={<ArrowUp size={14} />}
                  onClick={() => onChange(move(nodes, key, -1))}
                />
                <Button
                  type="text"
                  size="small"
                  aria-label={t("wizard.guided.moveDown", { title })}
                  icon={<ArrowDown size={14} />}
                  onClick={() => onChange(move(nodes, key, 1))}
                />
                {topic ? (
                  <Button
                    type="text"
                    size="small"
                    aria-label={t("wizard.guided.addSubtopic", { title })}
                    icon={<Plus size={14} />}
                    onClick={() => {
                      const next = addSubtopic(nodes, key);
                      onChange(next.nodes);
                      onAdd(next.key, key);
                    }}
                  />
                ) : null}
                <Button
                  type="text"
                  size="small"
                  danger
                  aria-label={t("wizard.guided.delete", { title })}
                  icon={<Trash2 size={14} />}
                  onClick={() => onChange(remove(nodes, key))}
                />
              </span>
            </div>
          );
        }}
      />
      <Button
        shape="round"
        icon={<Plus size={14} />}
        disabled={nodes.length >= MAX_TOPICS}
        onClick={() => {
          const next = addTopic(nodes);
          onChange(next.nodes);
          onAdd(next.key);
        }}
      >
        {t("wizard.guided.addTopic")}
      </Button>
    </div>
  );
}
