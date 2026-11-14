import { useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Button, Dropdown, Input, Radio, type MenuProps } from "antd";
import { ChevronDown, PencilLine, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { smartSections } from "@shared/smart-text";
import { Dialog, useConfirm } from "../../components/Dialog";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { Notice } from "../../components/Notice";
import { useEngineError } from "../../lib/engineError";
import { invoke } from "../../lib/ipc";
import { refreshPlan } from "../../lib/refreshPlan";
import { jobErrorEngine, jobErrorKey } from "../jobs/jobErrors";
import { sectionFailedKey, stoppedTone, type PartData } from "./partPage";
import { ReaderProgress } from "./Reader";

// The level of a part and its rewrites, as an old lesson has them: "Livello" in the bar, and "Riscrivi questa parte" and
// "Riscrivi una sezione" in the part's menu, with the same menu, the same dialogs and the same words where they mean
// the same. A level or a rewrite of the whole part runs as the part's job, so the page shows it in place over the text
// the part has now, which stays readable, and the new text arrives in its place.

type Wording = "simple" | "balanced" | "technical";
const wordings: Wording[] = ["simple", "balanced", "technical"];

/** What the working block, the failure and the confirmation name: the part with its number, the recap, or a topic's one lesson. */
function partNoun(data: PartData): "part" | "recap" | "lesson" {
  const part = data.outline?.parts.find((entry) => entry.position === data.position);
  if (part?.kind === "recap") return "recap";
  return (data.outline?.parts.length ?? 0) <= 1 ? "lesson" : "part";
}

/**
 * "Livello" on a part: the old lesson's menu, with one line on what it applies to, since a level chosen on a part is
 * kept for the parts after it.
 */
function LevelMenu({ wording, disabled, onChoose }: { wording: Wording; disabled: boolean; onChoose: (value: Wording) => void }) {
  const { t } = useTranslation();
  const hintId = useId();
  return (
    <>
      <Dropdown
        trigger={["click"]}
        disabled={disabled}
        autoFocus
        // The menu is drawn in the document's body, so it sits in a landmark named like the setting it changes.
        popupRender={(menu) => (
          <div role="region" aria-label={t("lesson.wording.label")}>
            {menu}
          </div>
        )}
        menu={{
          selectable: true,
          selectedKeys: [wording],
          items: [
            {
              type: "group",
              key: "applies",
              label: <span className="px-part-level-hint">{t("lesson.partLevelHint")}</span>,
              children: wordings.map((value) => ({ key: value, label: t(`lesson.wording.${value}`) })),
            },
          ],
          onClick: ({ key }) => onChoose(key as Wording),
        }}
      >
        <Button type="text" className="px-studybar-action" icon={<SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden />} aria-describedby={hintId}>
          <span className="px-reader-level">
            <span className="ink-muted">{t("lesson.level")}</span>
            {t(`lesson.wording.${wording}`)}
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
          </span>
        </Button>
      </Dropdown>
      {/* The visible "Livello Bilanciato" names the button (WCAG 2.5.3); the full name of the setting is its description. */}
      <span id={hintId} className="visually-hidden">
        {t("lesson.wording.label")}
      </span>
    </>
  );
}

/**
 * Everything the part page needs for a part's level and rewrites: the "Livello" menu, the items for the part's menu
 * and what they do, the working block and failure shown over the text, and the dialogs. `written`: the part shows its
 * text. `onArrived` is called when a rewrite that was writing ends with the new text, for the block to close.
 */
export function usePartRewrites({
  planId,
  topicId,
  data,
  query,
  queryKey,
  written,
}: {
  planId: string;
  topicId: string;
  data: PartData;
  query: UseQueryResult;
  queryKey: readonly unknown[];
  written: boolean;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const confirm = useConfirm();
  const describeEngineError = useEngineError();
  const [sectionOpen, setSectionOpen] = useState(false);
  const [section, setSection] = useState(0);
  const [note, setNote] = useState("");
  const lesson = data.lesson;
  const wording: Wording = lesson?.wording ?? "balanced";
  const rewrite = data.rewrite;
  const sections = useMemo(() => (written && lesson ? smartSections(lesson.markdown) : []), [written, lesson]);

  // A level or a rewrite of the whole part: `study.part` starts the part's job, or shows the part's text at that level
  // at once when one was written before.
  const choose = useMutation({
    mutationFn: (input: { wording?: Wording; regenerate?: boolean }) =>
      invoke("study.part", { planId, topicId, position: data.position, ...input }),
    onSuccess: async (next) => {
      client.setQueryData(queryKey, next);
      void client.invalidateQueries({ queryKey: ["jobs"] });
      await refreshPlan(client, planId);
    },
  });
  const keep = useMutation({
    mutationFn: (jobId: string) => invoke("jobs.dismiss", { jobId }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["jobs"] });
      void query.refetch();
    },
  });
  const rewriteSection = useMutation({
    mutationFn: () =>
      invoke("study.lessonSection", {
        planId,
        topicId,
        position: data.position,
        section,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: async () => {
      setSectionOpen(false);
      setNote("");
      // The part's summary and minutes change with its text, so the part is read again.
      await query.refetch();
      void client.invalidateQueries({ queryKey: ["parts", planId, topicId] });
    },
    // Another rewrite saved the part meanwhile: the page reads the text it has now, which a new try starts from.
    onError: (error) => {
      if (sectionFailedKey(error, "part") === "lesson.rewritePartSectionChanged") void query.refetch();
    },
  });

  // A choice on its way to core writes the part again unless it names the level the text already has, which only
  // keeps that level for the parts after this one.
  const changing =
    choose.isPending && (choose.variables?.regenerate === true || choose.variables?.wording !== wording);
  const writing = rewrite?.state === "writing" || changing;
  const noun = partNoun(data);
  const named = t(`lesson.rewriteWhat.${noun}`, { n: data.position });
  const busy = writing || rewriteSection.isPending;
  const noEngine = data.state === "book";
  const unavailable = noEngine ? <span className="px-part-other-detail">{t("lesson.rewriteNeedsEngine")}</span> : null;
  const withDetail = (label: string): ReactNode =>
    unavailable ? (
      <span className="px-part-other">
        <span>{label}</span>
        {unavailable}
      </span>
    ) : (
      label
    );

  const menuItems: NonNullable<MenuProps["items"]> = [
    {
      key: "rewrite-part",
      icon: <RefreshCw size={16} aria-hidden />,
      label: withDetail(t("lesson.rewriteThisPart")),
      disabled: busy || !written,
    },
    {
      key: "rewrite-section",
      icon: <PencilLine size={16} aria-hidden />,
      label: withDetail(t("lesson.rewriteSection")),
      disabled: busy || !written || sections.length === 0,
    },
  ];
  /** Runs a menu item of this block; false for any other key. */
  const onMenu = (key: string): boolean => {
    if (key === "rewrite-part") {
      void confirm({
        title: t(`lesson.rewriteConfirm.${noun}`),
        body: t("lesson.rewritePartNote"),
        confirm: t("lesson.regenerate"),
        // The dialog stays, busy, until core has taken the request; a refusal shows through `choose`, as before.
        run: () => choose.mutateAsync({ regenerate: true }).catch(() => undefined),
      });
      return true;
    }
    if (key === "rewrite-section") {
      setSection(0);
      rewriteSection.reset();
      setSectionOpen(true);
      return true;
    }
    return false;
  };

  // The level the new text is written at, named only while it is written: the job's, or the one just chosen. After a
  // failure the menu names the level of the text on screen, and the failure names the level that failed.
  const toLevel =
    rewrite?.state === "writing"
      ? rewrite.rewrite === "level"
        ? rewrite.wording
        : undefined
      : changing
        ? choose.variables?.wording
        : undefined;
  const copy: { title: [string, Record<string, unknown>?]; line: [string, Record<string, unknown>?] | null } = {
    title: ["lesson.rewritingTitle", { what: named }],
    line: toLevel ? ["lesson.rewritingLevelLine", { level: t(`lesson.wording.${toLevel}`) }] : ["lesson.rewritingAgainLine"],
  };

  // While a level is written, the button names it, as the old lesson's does from the moment it is chosen.
  const levelMenu = written ? (
    <LevelMenu
      wording={toLevel ?? wording}
      disabled={busy}
      // The level the text already has is a choice too: core keeps it for the parts after this one, with no call.
      onChoose={(value) => choose.mutate({ wording: value })}
    />
  ) : null;

  // The failure of the last rewrite, over the text it left as it was: Riprova sends the same choice again, and "Tieni
  // questa versione" puts the failure away.
  const error = rewrite?.state === "failed" ? (rewrite.error ?? "") : "";
  const engineError =
    error && !error.includes("lesson-part-invalid") ? describeEngineError(jobErrorKey(error), jobErrorEngine(error)) : undefined;
  const level = rewrite ? t(`lesson.wording.${rewrite.wording}`) : "";
  const failedText =
    engineError && jobErrorKey(error) !== "jobs.failedGeneral"
      ? engineError.text
      : t(rewrite?.rewrite === "level" ? "lesson.rewriteFailedLevel" : "lesson.rewriteFailed", {
          what: named,
          level,
        });
  const failure =
    rewrite?.state === "failed" && !choose.isPending ? (
      <div className="px-reader-note">
        <Notice
          tone={stoppedTone(error)}
          action={{
            label: t("lesson.partRetry"),
            onClick: () =>
              choose.mutate(rewrite.rewrite === "level" ? { wording: rewrite.wording } : { regenerate: true }),
          }}
          secondary={engineError?.action ?? { label: t("lesson.keepVersion"), onClick: () => keep.mutate(rewrite.jobId) }}
          details={error.trim() ? error.trim().slice(0, 2000) : undefined}
        >
          {failedText}
        </Notice>
      </div>
    ) : null;

  const sectionProgress = rewriteSection.isPending ? (
    <ReaderProgress label={t("lesson.rewritingSection", { title: sections[section]?.title ?? "" })} empty={false} />
  ) : null;

  const dialogs = (
    <>
      <Dialog
        open={sectionOpen}
        width="md"
        title={t("lesson.rewriteSectionTitle")}
        busy={rewriteSection.isPending}
        onClose={() => setSectionOpen(false)}
        actions={[
          { label: t("lesson.regenerate"), working: rewriteSection.isPending, onClick: () => rewriteSection.mutate() },
        ]}
      >
        <div className="px-reader-section">
          <p className="small ink-muted">
            {t(noun === "lesson" ? "lesson.rewriteSectionHint" : "lesson.rewritePartSectionHint")}
          </p>
          <Radio.Group
            value={section}
            onChange={(event) => setSection(event.target.value as number)}
            disabled={rewriteSection.isPending}
            aria-label={t("lesson.rewriteSectionTitle")}
          >
            {sections.map((entry, index) => (
              <Radio key={index} value={index}>
                <InlineMarkdown>{entry.title}</InlineMarkdown>
              </Radio>
            ))}
          </Radio.Group>
          <Input.TextArea
            value={note}
            maxLength={500}
            rows={3}
            disabled={rewriteSection.isPending}
            aria-label={t("lesson.rewriteSectionNote")}
            placeholder={t("lesson.rewriteSectionNote")}
            onChange={(event) => setNote(event.target.value)}
          />
          {rewriteSection.isError ? (
            <Notice tone="danger">{t(sectionFailedKey(rewriteSection.error, noun === "lesson" ? "lesson" : "part"))}</Notice>
          ) : null}
        </div>
      </Dialog>
    </>
  );

  return {
    levelMenu,
    menuItems,
    onMenu,
    /** The part is written again now: the working block shows over its text, and its question takes no answer. */
    writing,
    /** The working block's copy, in the shape the page's working block takes. */
    copy,
    failure,
    sectionProgress,
    dialogs,
  };
}

/**
 * Whether a rewrite of the part on screen has just ended with its new text, for the working block to close over it
 * and the text to fade in, as a part that was written while the student waited does; reduced motion skips that.
 * `onArrive` runs as the text arrives, with or without motion, so the page can move the focus.
 */
export function useRewriteArrival(data: PartData, writing: boolean, reduced: boolean, onArrive: () => void): boolean {
  const [arrived, setArrived] = useState(false);
  const before = useRef<{ position: number; writing: boolean } | null>(null);
  const arrive = useRef(onArrive);
  arrive.current = onArrive;
  useEffect(() => {
    const last = before.current;
    before.current = { position: data.position, writing };
    if (last?.position === data.position && last.writing && !writing && data.rewrite === null) {
      arrive.current();
      if (!reduced) setArrived(true);
    } else if (last?.position !== data.position) setArrived(false);
  }, [data.position, data.rewrite, writing, reduced]);
  useEffect(() => {
    if (!arrived) return;
    // Ends the closing when no transition runs, as in a hidden window.
    const timer = setTimeout(() => setArrived(false), 400);
    return () => clearTimeout(timer);
  }, [arrived]);
  return arrived;
}
