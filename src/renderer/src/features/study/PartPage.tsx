import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { MenuProps } from "antd";
import { Clock, Download, Network } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useNavigationType } from "react-router";
import { parseSmartText, partQuestions } from "@shared/smart-text";
import { returnTo, type BackTarget } from "../../app/usePlace";
import { Button } from "../../components/Button";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { MenuButton, useItemMenu } from "../../components/ItemMenu";
import { Logo } from "../../components/Logo";
import { Notice } from "../../components/Notice";
import { Popover } from "../../components/Popover";
import { SelectionMenu } from "../../components/SelectionMenu";
import { SmartText } from "../../components/SmartText";
import { openSourceViewer } from "../../components/SourceViewer";
import { Tag } from "../../components/Tag";
import { useEngineError } from "../../lib/engineError";
import { invoke } from "../../lib/ipc";
import { recommendQuery, usePlan } from "../../lib/queries";
import { refreshPlan } from "../../lib/refreshPlan";
import { jobErrorEngine, jobErrorKey } from "../jobs/jobErrors";
import { stepPath } from "../plans/reopen";
import { ExportButton } from "../share/ExportButton";
import { useActiveTime } from "./activeTime";
import { PartFoot, type OtherChoice } from "./PartFoot";
import { focusFollowsAnswer, lessonLine, oldLessonView, pageMove, startsOnOpen, stoppedTone, withAnswer, workingCopy, type PartData } from "./partPage";
import { PartsList } from "./PartsList";
import { usePartRewrites, useRewriteArrival } from "./PartRewrite";
import { ReaderEnd, ReaderLayout, ReaderLoading, SourcesFooter, useOpenNext } from "./Reader";
import "./PartPage.css";

const NARROW = "(max-width: 1099px)";

export function partKey(planId: string, topicId: string, position: number | undefined, itemId: string | undefined) {
  return ["part", planId, topicId, position ?? null, itemId ?? null] as const;
}

/**
 * Reads `study.part` for the lesson page. The first read of a part that nothing is writing starts its job (`write`),
 * resuming one stopped by a quit; a part whose job failed shows its error until the student presses Riprova, also once
 * that job is dismissed, so a failing call never repeats on its own. While the part is planned or written the page
 * reads it again every second, and a job's updates make it read at once (`staleFamilies`). Moving to another part of
 * the same topic keeps the part on screen until the next one is read, so the page changes without a blank.
 */
export function usePartQuery(planId: string, topicId: string, position: number | undefined, itemId: string | undefined) {
  const opened = useRef(new Set<string>());
  const key = partKey(planId, topicId, position, itemId);
  return useQuery({
    queryKey: key,
    enabled: Boolean(planId && topicId),
    retry: false,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === planId && previousQuery.queryKey[2] === topicId ? previous : undefined,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.mode === "parts" &&
        (data.state === "planning" || data.state === "writing" || data.rewrite?.state === "writing")
        ? 1000
        : false;
    },
    queryFn: async () => {
      const input = {
        planId,
        topicId,
        ...(position ? { position } : {}),
        ...(itemId ? { itemId } : {}),
      };
      const read = await invoke("study.part", input);
      const id = JSON.stringify(key);
      const first = !opened.current.has(id);
      opened.current.add(id);
      return first && startsOnOpen(read) ? invoke("study.part", { ...input, write: true }) : read;
    },
  });
}

/** Whether the window is too narrow for the parts column, which the bar's title then opens as a popover. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const media = window.matchMedia(NARROW);
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return narrow;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * One part of a topic's lesson (`mode: "parts"` of `study.part`): the bar with the topic and "Parte 3 di 8", the parts
 * column, the sheet with only this part and its final question, and the foot that names the next part. A part not
 * written yet shows the working block in the sheet, with the page's shape under it, until it is written; then the block
 * closes and the text fades in under the title. A topic of one part has no column and no part number.
 */
export function PartPage({
  planId,
  topicId,
  data,
  query,
  queryKey,
  back,
}: {
  planId: string;
  topicId: string;
  data: PartData;
  query: UseQueryResult;
  queryKey: readonly unknown[];
  back: BackTarget | null;
}) {
  const { t } = useTranslation();
  useActiveTime(planId, topicId);
  const navigate = useNavigate();
  const client = useQueryClient();
  const plan = usePlan(planId);
  const guide = useQuery(recommendQuery(planId));
  const describeEngineError = useEngineError();
  const narrow = useNarrow();
  const [listOpen, setListOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const titleButton = useRef<HTMLButtonElement>(null);
  const continueRef = useRef<HTMLDivElement>(null);
  const workRef = useRef<HTMLDivElement>(null);

  const outline = data.outline;
  const part = outline?.parts.find((entry) => entry.position === data.position) ?? null;
  const many = (outline?.parts.length ?? 0) > 1;
  const recap = part?.kind === "recap";
  const topic = plan.data?.topics.find((item) => item.id === topicId);
  const topicTitle = topic?.title ?? t("lesson.title");
  const lesson = data.lesson;
  const written = data.state === "written" && lesson !== null;
  const href = (position: number) => `/plans/${planId}/lesson/${topicId}?part=${position}`;
  // "Torna al percorso" goes back the way the bar does when the bar leads to the exam, and opens the exam otherwise.
  const toPath = () => returnTo(back, `/plans/${planId}`, navigate);

  useEffect(() => {
    if (!narrow || !many) setListOpen(false);
  }, [narrow, many]);

  // What finishes the part: the last check, or the recap's three questions. A part without one is finished with Fatto.
  const questions = useMemo(
    () => (written && lesson ? partQuestions(parseSmartText(lesson.markdown), recap ? "recap" : "part") : []),
    [written, lesson, recap],
  );
  const answered = questions.length > 0 && questions.every((id) => lesson?.answers[id] !== undefined);
  const active = Boolean(part?.done) || answered;

  // Moves the page as `pageMove` decides, the one rule for where the page scrolls and what takes the focus when a part
  // opens or arrives and when a rewrite starts or ends. The working block gives the focus to its way back itself, as it
  // appears.
  const place = (move: ReturnType<typeof pageMove>) => {
    if (move.scroll === "top") window.scrollTo({ top: 0, behavior: "instant" });
    if (move.scroll === "block")
      workRef.current?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    const title = () => document.querySelector<HTMLElement>(".px-reader-head h1");
    if (move.focus === "title" && move.scroll === "title") requestAnimationFrame(() => title()?.focus({ preventScroll: false }));
    else if (move.focus === "title") title()?.focus({ preventScroll: true });
  };
  /** Whether the focus is in the working block that is going, or nowhere. */
  const focusInBlock = () => {
    const active = document.activeElement;
    return !active || active === document.body || Boolean(workRef.current?.contains(active));
  };
  const navigation = useNavigationType();

  // Old lessons in parts: a lesson written before parts being rewritten, until its first part is written.
  const rewritingOld = oldLessonView(data) === "rewriting";

  // The block that closes as the part it waited for arrives, and the text that fades in under it.
  const [arriving, setArriving] = useState<{
    position: number;
    state: "planning" | "writing";
    rewriting: boolean;
  } | null>(null);
  const seen = useRef<{ position: number; state: PartData["state"]; rewriting: boolean } | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = { position: data.position, state: data.state, rewriting: rewritingOld };
    if (
      before?.position === data.position &&
      (before.state === "writing" || before.state === "planning") &&
      data.state === "written"
    ) {
      const inBlock = focusInBlock();
      if (!reducedMotion()) setArriving({ position: before.position, state: before.state, rewriting: before.rewriting });
      place(pageMove("arrived", { back: false, working: false, focusInBlock: inBlock }));
    } else if (before && before.position !== data.position) setArriving(null);
  }, [data.position, data.state, rewritingOld]);
  useEffect(() => {
    if (!arriving) return;
    // Ends the closing when no transition runs, as in a hidden window.
    const timer = setTimeout(() => setArriving(null), 400);
    return () => clearTimeout(timer);
  }, [arriving]);

  // A page change between parts of a topic is a short cross-fade; the first part the page opens with is not.
  const firstPosition = useRef(data.position);
  const turned = useRef(false);
  if (data.position !== firstPosition.current) turned.current = true;

  // Saving an answer to the part's text. The answer that finishes the part moves the focus to Continua, unless the
  // student moved it on meanwhile.
  async function answer(blockId: string, pick: number) {
    const itemId = lesson?.itemId;
    if (!itemId) return;
    const before = document.activeElement;
    const result = await invoke("study.lessonAnswer", { planId, itemId, blockId, pick });
    client.setQueryData<PartData>(queryKey, (current) => withAnswer(current, itemId, blockId, result.pick));
    void client.invalidateQueries({ queryKey: ["series", planId] });
    if (result.partDone || result.finished) {
      await refreshPlan(client, planId);
      void query.refetch();
    }
    if (result.partDone) moveToContinue(before);
  }
  function moveToContinue(before: Element | null) {
    requestAnimationFrame(() => {
      if (focusFollowsAnswer(before, document.activeElement, document.body))
        continueRef.current?.querySelector<HTMLElement>("button")?.focus();
    });
  }

  const finish = useMutation({
    mutationFn: () => invoke("study.partDone", { planId, topicId, position: data.position }),
    onSuccess: async () => {
      const before = document.activeElement;
      await refreshPlan(client, planId);
      await query.refetch();
      moveToContinue(before);
    },
  });
  const retry = useMutation({
    mutationFn: () => invoke("study.part", { planId, topicId, position: data.position, write: true }),
    onSuccess: (next) => {
      client.setQueryData(queryKey, next);
      void client.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
  // A topic's lesson read before any part could be planned (no AI tool) is finished as today's book text is.
  const read = plan.data?.steps.some((step) => step.activity === "lesson" && step.topicId === topicId);
  const openNext = useOpenNext(planId);
  const markRead = useMutation({
    mutationFn: async (then: "done" | "continue") => {
      if (!read) await invoke("plans.complete", { planId, activity: "lesson", topicId });
      return then;
    },
    onSuccess: async (then) => {
      await refreshPlan(client, planId);
      if (then === "continue") await openNext();
      else toPath();
    },
  });

  // Where Continua goes after the last part: the plan's next step, named; back to the exam while the lesson itself is
  // still the suggestion.
  const next = guide.data?.next ?? null;
  const pathNext = next && !(next.activity === "lesson" && next.topicId === topicId) ? next : null;
  const pathNextTitle = pathNext
    ? pathNext.topicId && pathNext.topicId !== topicId
      ? t("examPage.nowTitle", {
          activity: t(`plans.path.activity.${pathNext.activity}`),
          topic: plan.data?.topics.find((item) => item.id === pathNext.topicId)?.title ?? "",
        })
      : t(`plans.path.activity.${pathNext.activity}`)
    : null;
  const continueLabel = data.next ? (
    <InlineMarkdown>
      {t("lesson.partContinue", { title: data.next.kind === "recap" ? t("lesson.recapTitle") : data.next.title })}
    </InlineMarkdown>
  ) : pathNextTitle ? (
    t("lesson.partContinue", { title: pathNextTitle })
  ) : (
    t("lesson.backToPath")
  );
  const goOn = () => {
    // The next part is a move inside the page, so it takes this entry's place in history: one Back leaves the lesson.
    if (data.next) {
      navigate(href(data.next.position), { replace: true });
      return;
    }
    const to = pathNext ? stepPath(planId, pathNext.activity, pathNext.topicId) : null;
    if (to) navigate(to);
    else toPath();
  };

  // "Scegli altro": the topic's exercises and flashcards with their counts, and a part to reread.
  const footShown = written || data.state === "book";
  const exercises = useQuery({
    queryKey: ["exercises", planId, topicId],
    enabled: footShown,
    queryFn: () => invoke("study.exercises", { planId, topicId }),
  });
  const cards = useQuery({
    queryKey: ["card-queue", planId, topicId],
    enabled: footShown,
    queryFn: () => invoke("study.queue", { planId, topicId }),
  });
  const cardsTotal = cards.data ? cards.data.fresh + cards.data.learning + cards.data.mastered : null;
  const reread = Boolean(outline?.parts.some((entry) => entry.done && entry.position !== data.position));
  const onOther = (choice: OtherChoice) => {
    if (choice === "practice") navigate(stepPath(planId, "practice", topicId)!);
    if (choice === "cards") navigate(stepPath(planId, "cards", topicId)!);
    if (choice === "reread") {
      if (narrow) return setListOpen(true);
      document.querySelector<HTMLElement>(".px-reader-side li[data-done] a")?.focus();
    }
  };

  // The part's level and rewrites: "Livello" in the bar, the rewrites in the part's menu, and their states over the text.
  const rewrites = usePartRewrites({ planId, topicId, data, query, queryKey, written });
  const rewriting = written && rewrites.writing;
  const rewriteArrived = useRewriteArrival(data, rewriting, reducedMotion(), () =>
    place(pageMove("rewriteEnded", { back: false, working: false, focusInBlock: focusInBlock() })),
  );

  // A part the page shows from its own read opens at its title, however the student came to it: Continua, the parts
  // column or its popover, Rileggi una parte, a link. A part planned or written, or one being rewritten, opens at its
  // working block instead.
  const presented = useRef<number | null>(null);
  useEffect(() => {
    if (query.isPlaceholderData || presented.current === data.position) return;
    presented.current = data.position;
    const working = data.state === "planning" || data.state === "writing" || rewriting;
    place(pageMove("opened", { back: navigation === "POP", working, focusInBlock: false }));
  }, [data.position, data.state, query.isPlaceholderData, navigation, rewriting]);

  // A rewrite starts from the bar or the part's menu, wherever the student is in the part: the page moves to the block
  // that shows it, over the text that is about to change. A part opened while its rewrite runs is placed as it opens.
  const wasRewriting = useRef({ position: data.position, rewriting });
  useEffect(() => {
    const last = wasRewriting.current;
    wasRewriting.current = { position: data.position, rewriting };
    if (rewriting && !last.rewriting && last.position === data.position)
      place(pageMove("rewriteStarted", { back: false, working: true, focusInBlock: false }));
  }, [data.position, rewriting]);

  // The part's menu: the dots in the bar, and a right-click or the menu keys on the part's head.
  const menu: MenuProps = {
    items: [
      ...rewrites.menuItems,
      { type: "divider" },
      { key: "map", icon: <Network size={16} aria-hidden />, label: t("map.title") },
      { key: "export", icon: <Download size={16} aria-hidden />, label: t("export.title"), disabled: !written },
    ],
    onClick: ({ key }) => {
      if (rewrites.onMenu(key)) return;
      if (key === "map") navigate(`/plans/${planId}/map/${topicId}`);
      if (key === "export") setExportOpen(true);
    },
  };
  const headMenu = useItemMenu({ menu, region: t("lesson.more") });

  // Above the title, what the part was written from: its first two sources and how many more.
  const sourceTitles = (lesson?.sources ?? []).map((source) => source.title);
  const sourceLine = written
    ? sourceTitles.length
      ? t("lesson.fromSources", {
          list:
            sourceTitles.length > 2
              ? t("lesson.sourcesMore", { first: sourceTitles.slice(0, 2).join(", "), count: sourceTitles.length - 2 })
              : sourceTitles.join(t("lesson.sourcesAnd")),
        })
      : undefined
    : undefined;

  const title = !outline
    ? topicTitle
    : recap
      ? t("lesson.recapTitle")
      : part && many
        ? part.title
        : topicTitle;
  const minutes = part?.minutes;
  const meta =
    (written || data.state === "book") && minutes ? (
      <p className="px-part-meta">
        <Clock size={14} strokeWidth={1.75} aria-hidden />
        {questions.length === 0
          ? t("lesson.partMinutes", { count: minutes })
          : recap
            ? t("lesson.recapMeta", { count: minutes })
            : t("lesson.partMeta", { count: minutes })}
      </p>
    ) : null;
  const barSubtitle = lessonLine(t, {
    many,
    recap,
    position: data.position,
    parts: outline?.teaching ?? 0,
    minutes: written || data.state === "book" ? minutes : null,
  });
  const footHeading = !many ? t("lesson.lessonEnd") : recap ? t("lesson.chapterEnd") : t("lesson.partEnd", { n: data.position });

  const working = data.state === "planning" || data.state === "writing" || retry.isPending;
  // While an old lesson is rewritten, the block says so and keeps the way to the version the student had.
  const rewritingCopy: ReturnType<typeof workingCopy> = { title: ["lesson.rewritingOld"], line: ["lesson.rewritingOldLine"] };
  const readEarlier = data.replaces
    ? () =>
        navigate(`/plans/${planId}/lesson/${topicId}?item=${encodeURIComponent(data.replaces!.itemId)}`, { replace: true })
    : undefined;
  const block = working ? (
    <WorkingBlock
      copy={
        rewritingOld
          ? rewritingCopy
          : workingCopy({
              state: data.state === "planning" || !outline ? "planning" : "writing",
              position: data.position,
              kind: part?.kind ?? null,
              many,
            })
      }
      onEarlier={rewritingOld ? readEarlier : undefined}
    />
  ) : arriving?.position === data.position ? (
    <WorkingBlock
      copy={
        arriving.rewriting
          ? rewritingCopy
          : workingCopy({ state: arriving.state, position: data.position, kind: part?.kind ?? null, many })
      }
      onEarlier={arriving.rewriting ? readEarlier : undefined}
      still
    />
  ) : rewriting || rewriteArrived ? (
    <WorkingBlock copy={rewrites.copy} still={!rewriting} />
  ) : null;

  const error = data.error ?? "";
  const engineError =
    data.state === "failed" && error && !error.includes("lesson-part-invalid")
      ? describeEngineError(jobErrorKey(error), jobErrorEngine(error))
      : undefined;
  const failedText =
    engineError && jobErrorKey(error) !== "jobs.failedGeneral"
      ? engineError.text
      : !outline || !many
        ? t("lesson.planFailed")
        : recap
          ? t("lesson.recapFailed")
          : t("lesson.partFailed", { n: data.position });
  const bookError = lesson?.fallbackReason ? describeEngineError(lesson.fallbackReason, lesson.fallbackProvider) : undefined;

  return (
    <ReaderLayout
      eyebrow={sourceLine}
      title={<InlineMarkdown>{title}</InlineMarkdown>}
      titleFocusable
      meta={meta}
      headProps={headMenu.bind}
      back={back}
      barTitle={topicTitle}
      barSubtitle={barSubtitle}
      barMenu={
        narrow && outline && many
          ? { anchor: titleButton, open: listOpen, onToggle: () => setListOpen((open) => !open), controls: "px-parts-popover" }
          : undefined
      }
      side={outline && many ? <PartsList outline={outline} current={data.position} href={href} /> : undefined}
      tools={rewrites.levelMenu}
      menu={<MenuButton rightClick menu={menu} label={t("lesson.more")} region={t("lesson.more")} />}
      sheetClassName="px-part-sheet"
    >
      {headMenu.popup}
      {rewrites.dialogs}
      {outline && many ? (
        <Popover
          open={listOpen}
          anchor={titleButton}
          onClose={() => setListOpen(false)}
          label={t("lesson.partsTitle")}
          id="px-parts-popover"
          className="px-parts-popover"
        >
          <PartsList
            outline={outline}
            current={data.position}
            href={href}
            heading={false}
            onPick={() => setListOpen(false)}
          />
        </Popover>
      ) : null}
      <div key={data.position} className={turned.current ? "px-part-body is-turned" : "px-part-body"}>
        {block ? (
          <div
            ref={workRef}
            className={[
              "px-part-work",
              working || rewriting ? "" : "is-closing",
              !working && (rewriting || rewriteArrived) ? "is-rewrite" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-hidden={working || rewriting ? undefined : true}
          >
            <div>{block}</div>
          </div>
        ) : null}
        {working ? <PageShape /> : null}
        {data.state === "failed" && !retry.isPending ? (
          <div className="px-reader-note">
            <Notice
              tone={stoppedTone(error)}
              action={{ label: t("lesson.partRetry"), onClick: () => retry.mutate() }}
              secondary={engineError?.action}
              details={error.trim() ? error.trim().slice(0, 2000) : undefined}
            >
              {failedText}
            </Notice>
          </div>
        ) : null}
        {data.state === "book" && lesson ? (
          <div className="px-reader-note">
            <Notice
              tone="warning"
              action={{ label: t("lesson.partRetry"), onClick: () => retry.mutate() }}
              secondary={bookError?.action ?? { label: t("engines.title"), onClick: () => navigate("/settings/engines") }}
            >
              {bookError ? `${t("lesson.sourceFallback")} ${bookError.text}` : t("lesson.sourceFallback")}
            </Notice>
          </div>
        ) : null}
        {rewrites.failure}
        {rewrites.sectionProgress}
        {written && lesson?.general ? (
          <div className="px-reader-note">
            <Tag tone="general">{t("components.tags.general")}</Tag>
            <span className="meta ink-muted">{t("lesson.generalNote")}</span>
          </div>
        ) : null}
        {(written || data.state === "book") && lesson ? (
          <div className={arriving?.position === data.position || rewriteArrived ? "px-part-text is-arriving" : "px-part-text"}>
            <SelectionMenu
              planId={planId}
              topicId={topicId}
              passageIds={lesson.passageIds}
              onAsk={(chatId) => navigate(`/ask/${chatId}`)}
            >
              <SmartText
                figures={lesson.figures}
                answers={lesson.answers}
                onAnswer={written && lesson.itemId && !rewriting && !query.isPlaceholderData ? answer : undefined}
                final={written ? { label: t("lesson.finalCheck"), keys: true } : undefined}
                onCitationClick={(number) => {
                  const passageId = lesson.passageIds[number - 1];
                  if (passageId) openSourceViewer({ passageId });
                }}
                citationResolver={(number) => lesson.citations[number - 1]}
              >
                {lesson.markdown}
              </SmartText>
            </SelectionMenu>
            {outline ? (
              <PartFoot
                heading={footHeading}
                summary={data.summary}
                active={active}
                continueLabel={continueLabel}
                continueMinutes={data.next?.minutes}
                onContinue={goOn}
                busy={finish.isPending ? "done" : undefined}
                done={questions.length === 0 && part ? () => finish.mutate() : undefined}
                other={{
                  topic: topicTitle,
                  practice: exercises.data?.exercises.length ?? null,
                  cardsDue: cards.data?.due ?? null,
                  cardsNone: cardsTotal === 0,
                  reread,
                }}
                onOther={onOther}
                onEnough={() => (back ? back.go() : navigate(`/plans/${planId}`))}
                continueRef={continueRef}
                failed={finish.isError}
              />
            ) : (
              <ReaderEnd
                state={!plan.data || !topic ? "other" : read ? "done" : "current"}
                doneLabel={t("lesson.doneTitle")}
                busy={markRead.isPending ? markRead.variables : undefined}
                failed={markRead.isError}
                onDone={() => markRead.mutate("done")}
                onContinue={() => markRead.mutate("continue")}
              />
            )}
            <SourcesFooter sources={lesson.sources} />
          </div>
        ) : null}
      </div>
      <ExportButton
        planId={planId}
        topicId={topicId}
        kind="lesson"
        open={exportOpen}
        onOpenChange={setExportOpen}
      />
    </ReaderLayout>
  );
}

/**
 * Pyxis at work on the part, in the sheet where its text will appear: the working mark, what it is doing and a line on
 * why. The way out is the bar's back control, so the block's line takes the focus as the block appears. `still` draws
 * it as it closes, after the part arrived, with nothing to announce or focus.
 */
function WorkingBlock({
  copy,
  onEarlier,
  still = false,
}: {
  copy: ReturnType<typeof workingCopy>;
  /** Old lessons in parts: opens the version the rewrite replaces, in place of the note on where the part will be. */
  onEarlier?: () => void;
  still?: boolean;
}) {
  const { t } = useTranslation();
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!still) line.current?.focus({ preventScroll: true });
  }, [still]);
  return (
    <section className="px-part-working" aria-label={t(copy.title[0], copy.title[1])}>
      <div className="px-part-working-status" role={still ? undefined : "status"}>
        <Logo size={36} working decorative />
        <p ref={line} tabIndex={-1}>
          <span className="px-part-working-title">{t(copy.title[0], copy.title[1])}</span>
          {copy.line ? <span className="px-part-working-line">{t(copy.line[0], copy.line[1])}</span> : null}
        </p>
      </div>
      <div className="px-part-working-actions">
        {onEarlier ? (
          <Button variant="ghost" size="sm" onClick={onEarlier} disabled={still}>
            {t("lesson.readEarlier")}
          </Button>
        ) : (
          <span className="px-part-working-ready">{t("lesson.writingReady")}</span>
        )}
      </div>
    </section>
  );
}

/** The shape of a page under the working block: static lines where the text will be, never a pulsing skeleton. */
function PageShape() {
  return (
    <div className="px-part-shape" aria-hidden>
      <span />
      <span />
      <span className="is-short" />
      <span className="is-heading" />
      <span />
      <span />
      <span className="is-short" />
      <span className="is-box" />
      <span />
      <span className="is-short" />
    </div>
  );
}

/** The page while `study.part` is first read from disk: the bar and the sheet's shape, as today's reader shows. */
export function PartLoading({ planId, topicId, back }: { planId: string; topicId: string; back: BackTarget | null }) {
  const { t } = useTranslation();
  const plan = usePlan(planId);
  const topic = plan.data?.topics.find((item) => item.id === topicId)?.title ?? t("lesson.title");
  return (
    <ReaderLayout
      title={topic}
      back={back}
      barTitle={topic}
    >
      <ReaderLoading label={t("lesson.loading")} />
    </ReaderLayout>
  );
}
