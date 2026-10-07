import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BuildingMark } from "../../components/BuildingMark";
import { Button } from "../../components/Button";
import { ChatMessage } from "../../components/ChatMessage";
import { CheckBadge } from "../../components/CheckBadge";
import { Chip } from "../../components/Chip";
import { CitationChip } from "../../components/CitationChip";
import { Composer } from "../../components/Composer";
import { ContextBlock } from "../../components/ContextBlock";
import { Dock } from "../../components/Dock";
import { EngineRow } from "../../components/EngineRow";
import { Flashcard } from "../../components/Flashcard";
import { FocusBar } from "../../components/FocusBar";
import { GapItem } from "../../components/GapItem";
import { Icon } from "../../components/Icon";
import { ICON_MAP, type IconName } from "../../components/iconMap";
import { IconButton } from "../../components/IconButton";
import { LessonTile } from "../../components/LessonTile";
import { Logo } from "../../components/Logo";
import { MarkdownView } from "../../components/MarkdownView";
import { MasteryBar } from "../../components/MasteryBar";
import { Notice } from "../../components/Notice";
import { PathNode } from "../../components/PathNode";
import { PlanCard } from "../../components/PlanCard";
import { QuizOption } from "../../components/QuizOption";
import { SegmentedTabs } from "../../components/SegmentedTabs";
import { StatTile } from "../../components/StatTile";
import { StepLines } from "../../components/StepLines";
import { Tag } from "../../components/Tag";
import { TextField } from "../../components/TextField";

function Section({
  eyebrow,
  title,
  hint,
  children,
  layout = "row",
}: {
  eyebrow: string;
  title: string;
  hint?: string;
  children: ReactNode;
  layout?: "row" | "col" | "grid2";
}) {
  const bodyClass =
    layout === "col"
      ? "gallery-col"
      : layout === "grid2"
        ? "gallery-grid2"
        : "gallery-row";
  return (
    <section className="gallery-card">
      <div className="gallery-card-head">
        <span className="label">{eyebrow}</span>
        <h2 className="title-3">{title}</h2>
        {hint ? <p className="small">{hint}</p> : null}
      </div>
      <div className={`gallery-card-body ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function ComponentGallery() {
  const { t } = useTranslation();
  const iconNames = Object.keys(ICON_MAP) as IconName[];

  return (
    <>
      <Section eyebrow={t("gallery.sections.foundations")} title="Logo">
        <Logo size={64} />
        <Logo size={44} wordmark />
        <span
          style={{
            display: "grid",
            placeItems: "center",
            width: 88,
            height: 88,
            borderRadius: 20,
            background: "var(--primary)",
          }}
        >
          <Logo size={60} inverse />
        </span>
        <Logo size={20} />
      </Section>

      <Section eyebrow={t("gallery.sections.foundations")} title="Icon">
        <div
          className="gallery-row"
          style={{ color: "var(--ink-muted)", gap: 20 }}
        >
          {iconNames.map((name) => (
            <span key={name} title={name}>
              <Icon name={name} size={22} />
            </span>
          ))}
        </div>
      </Section>

      <Section eyebrow={t("gallery.sections.actions")} title="Button">
        <Button>{t("components.buttons.continue")}</Button>
        <Button variant="secondary" icon="plus">
          {t("components.buttons.newPlan")}
        </Button>
        <Button variant="ghost">{t("components.buttons.cancel")}</Button>
        <Button variant="danger" size="sm">
          {t("components.buttons.deletePlan")}
        </Button>
        <Button size="lg">{t("components.buttons.generatePath")}</Button>
        <Button disabled>{t("components.buttons.disabled")}</Button>
      </Section>

      <Section eyebrow={t("gallery.sections.actions")} title="IconButton">
        <IconButton icon="arrow-left" label={t("nav.back")} />
        <IconButton icon="settings" label={t("nav.settings")} variant="ghost" />
        <IconButton
          icon="send"
          label={t("components.composer.send")}
          variant="primary"
          size="sm"
        />
        <IconButton icon="x" label={t("nav.close")} size="sm" />
      </Section>

      <Section
        eyebrow={t("gallery.sections.navigation")}
        title="SegmentedTabs"
        layout="col"
      >
        <SegmentedTabs
          label={t("doors.exams")}
          items={[
            { value: "ask", label: t("doors.ask"), icon: "message-circle" },
            { value: "exams", label: t("doors.exams"), icon: "graduation-cap" },
          ]}
          value="exams"
        />
        <SegmentedTabs
          label={t("exams.plans")}
          items={[
            { value: "path", label: t("gallery.tabs.path") },
            { value: "topics", label: t("gallery.tabs.topics") },
            { value: "src", label: t("exams.sources") },
            { value: "prog", label: t("gallery.tabs.progress"), badge: "23 %" },
          ]}
        />
      </Section>

      <Section
        eyebrow={t("gallery.sections.forms")}
        title="TextField"
        layout="col"
      >
        <TextField icon="search" placeholder={t("settings.title")} />
        <TextField size="lg" placeholder="Analisi 2" defaultValue="Analisi 2" />
      </Section>

      <Section eyebrow={t("gallery.sections.actions")} title="Chip">
        <Chip>{t("components.chips.q1")}</Chip>
        <Chip>{t("components.chips.q2")}</Chip>
        <Chip icon="sigma">{t("components.chips.q3")}</Chip>
      </Section>

      <Section eyebrow={t("gallery.sections.status")} title="Tag">
        <Tag tone="smartbook">{t("components.tags.smartbook")}</Tag>
        <Tag>{t("components.tags.ai")}</Tag>
        <Tag tone="general">{t("components.tags.general")}</Tag>
        <Tag tone="mastered">{t("components.tags.mastered")}</Tag>
        <Tag tone="severe">{t("components.tags.severe")}</Tag>
        <Tag tone="recommended">{t("components.tags.recommended")}</Tag>
      </Section>

      <Section eyebrow={t("gallery.sections.status")} title="CitationChip">
        <p className="px-msg-text" style={{ maxWidth: 560 }}>
          {t("components.citationSamples.sentence")}{" "}
          <CitationChip>{t("components.citationSamples.sb")}</CitationChip>{" "}
          <CitationChip kind="pdf">
            {t("components.citationSamples.pdf")}
          </CitationChip>
        </p>
      </Section>

      <Section
        eyebrow={t("gallery.sections.progress")}
        title="MasteryBar"
        layout="col"
      >
        <MasteryBar value={23} target={75} label={t("progress.preparation")} />
        <MasteryBar value={82} target={75} label={t("progress.preparation")} />
        <MasteryBar
          value={23}
          target={80}
          tone="primary"
          showValue={false}
          label={t("progress.preparation")}
        />
      </Section>

      <Section eyebrow={t("gallery.sections.content")} title="PlanCard">
        <PlanCard
          subject="Fisica"
          title="Fondamenti di Fisica Generale"
          mastery={23}
          target={75}
          meta={t("components.planCards.meta1")}
          cta={t("components.plan.continue")}
        />
        <PlanCard
          subject="Matematica"
          title="Analisi 2: serie e integrali multipli"
          mastery={61}
          target={80}
          meta={t("components.planCards.meta2")}
          cta={t("components.plan.continue")}
        />
      </Section>

      <Section
        eyebrow={t("gallery.sections.progress")}
        title="StatTile"
        layout="col"
      >
        <div style={{ width: "100%", maxWidth: 640 }}>
          <StatTile
            label={t("components.stat.label")}
            value={23}
            target={80}
            pills={[t("components.stat.pill1"), t("components.stat.pill2")]}
            stats={[
              { value: "0 / 9", label: t("components.stat.stat1") },
              { value: "23", label: t("components.stat.stat2") },
            ]}
          />
        </div>
      </Section>

      <Section
        eyebrow={t("gallery.sections.content")}
        title="LessonTile"
        layout="grid2"
      >
        <LessonTile icon="pencil-line" label={t("components.path.exercises")} />
        <LessonTile icon="list-checks" label={t("gallery.lessonQuiz")} />
        <LessonTile
          icon="square-split-horizontal"
          label={t("gallery.trueFalse")}
        />
        <LessonTile
          icon="repeat"
          label={t("components.path.review")}
          recommended
          recommendedLabel={t("components.lesson.recommended")}
          count={1}
        />
      </Section>

      <Section eyebrow={t("gallery.sections.studyPath")} title="PathNode">
        <PathNode
          icon="book-open"
          label={t("components.path.intro")}
          state="done"
        />
        <PathNode
          icon="pencil-line"
          label={t("components.path.exercises")}
          state="available"
        />
        <PathNode
          icon="repeat"
          label={t("components.path.review")}
          state="current"
        />
        <PathNode
          icon="file-pen"
          label={t("components.path.sim")}
          state="planned"
        />
      </Section>

      <Section
        eyebrow={t("gallery.sections.progress")}
        title="GapItem"
        layout="col"
      >
        <GapItem
          severity="severe"
          topic={t("components.gapSamples.topic1")}
          onFill={() => {}}
          fillLabel={t("components.gap.fill")}
          severitySevereLabel={t("components.gap.severe")}
          severityMinorLabel={t("components.gap.minor")}
        >
          {t("components.gapSamples.severe")}
        </GapItem>
        <GapItem
          severity="minor"
          topic={t("components.gapSamples.topic2")}
          onFill={() => {}}
          fillLabel={t("components.gap.fill")}
          severitySevereLabel={t("components.gap.severe")}
          severityMinorLabel={t("components.gap.minor")}
        >
          {t("components.gapSamples.minor")}
        </GapItem>
      </Section>

      <Section
        eyebrow={t("gallery.sections.ask")}
        title="Composer"
        layout="col"
      >
        <Composer subject="Fisica" sources={["Fisica 1"]} />
        <Composer streaming />
      </Section>

      <Section
        eyebrow={t("gallery.sections.ask")}
        title="ChatMessage"
        layout="col"
      >
        <ChatMessage role="user">
          {t("components.chatSamples.user")}
        </ChatMessage>
        <ChatMessage
          engine="claude-code · claude-sonnet-4-6"
          suggestions={[
            t("components.chatSamples.s1"),
            t("components.chatSamples.s2"),
          ]}
        >
          {t("components.chatSamples.tutor")}{" "}
          <CitationChip>{t("components.chatSamples.cite")}</CitationChip>
        </ChatMessage>
        <ChatMessage general>{t("components.chatSamples.tutor")}</ChatMessage>
      </Section>

      <Section
        eyebrow={t("gallery.sections.practice")}
        title="QuizOption"
        layout="col"
      >
        <QuizOption letter="A">{t("components.quizSamples.a")}</QuizOption>
        <QuizOption letter="B" state="selected">
          {t("components.quizSamples.b")}
        </QuizOption>
        <QuizOption letter="C" state="correct">
          {t("components.quizSamples.c")}
        </QuizOption>
        <QuizOption letter="D" state="wrong">
          {t("components.quizSamples.d")}
        </QuizOption>
      </Section>

      <Section
        eyebrow={t("gallery.sections.practice")}
        title="Flashcard"
        layout="col"
      >
        <Flashcard
          flipped
          front={t("components.flashcardSample.front")}
          back={t("components.flashcardSample.back")}
          source={t("components.flashcardSample.source")}
        />
      </Section>

      <Section
        eyebrow={t("gallery.sections.engine")}
        title="EngineRow"
        layout="col"
      >
        <EngineRow
          kind="cli"
          name="Claude Code"
          model="claude-sonnet-4-6"
          status="ok"
          isDefault
        />
        <EngineRow kind="cli" name="Codex" model="gpt-5-codex" status="warn" />
        <EngineRow
          kind="local"
          name="Ollama"
          model="qwen3:14b"
          status="ok"
          statusText={t("components.engine.statusIdle")}
        />
        <EngineRow
          kind="remote"
          name="LM Studio"
          model="http://192.168.1.20:1234/v1"
          status="error"
        />
      </Section>

      <Section
        eyebrow={t("gallery.sections.layout")}
        title="FocusBar"
        layout="col"
      >
        <FocusBar
          title={t("gallery.focusTitle")}
          meta={t("gallery.focusMeta")}
          closeLabel={t("nav.close")}
          backLabel={t("nav.back")}
          progress={30}
          actions={[{ icon: "settings", label: t("nav.settings") }]}
        />
      </Section>

      <Section eyebrow={t("gallery.sections.layout")} title="Dock" layout="col">
        <Dock
          eyebrow={t("gallery.dockEyebrow")}
          title={t("gallery.dockTitle")}
          reason={t("gallery.dockReason")}
          continueLabel={t("gallery.dockContinue")}
          anotherLabel={t("gallery.dockAnother")}
        />
      </Section>

      <Section
        eyebrow={t("gallery.sections.layout")}
        title="Notice"
        layout="col"
      >
        <Notice tone="info">{t("gallery.noticeInfo")}</Notice>
        <Notice tone="warning">{t("gallery.noticeWarn")}</Notice>
        <Notice
          tone="danger"
          action={{ label: t("gallery.noticeFix"), onClick: () => {} }}
          details={t("gallery.noticeDetails")}
        >
          {t("gallery.noticeDanger")}
        </Notice>
      </Section>

      <Section
        eyebrow={t("gallery.sections.layout")}
        title="StepLines"
        layout="col"
      >
        <div className="gallery-mark-wrap">
          <BuildingMark inner={1} middle={0.4} outer={0} />
          <h2 className="title-2">{t("gallery.buildingTitle")}</h2>
          <StepLines
            label={t("gallery.buildingTitle")}
            steps={[
              {
                id: "1",
                label: t("components.steps.read"),
                state: "done",
                meta: t("components.steps.metaRead"),
              },
              {
                id: "2",
                label: t("components.steps.topics"),
                state: "running",
              },
              { id: "3", label: t("components.steps.link"), state: "pending" },
              { id: "4", label: t("components.steps.path"), state: "pending" },
              {
                id: "5",
                label: t("components.steps.lessons"),
                state: "pending",
              },
            ]}
          />
        </div>
        <BuildingMark inner={1} middle={1} outer={1} done />
        <StepLines
          steps={[
            { id: "f", label: t("components.steps.topics"), state: "failed" },
          ]}
        />
      </Section>

      <Section eyebrow={t("gallery.sections.layout")} title="BuildingMark">
        <BuildingMark inner={1} middle={0.5} outer={0} />
        <BuildingMark inner={1} middle={1} outer={1} done />
        <BuildingMark inner={0.6} middle={0} outer={0} failedTrail={0} />
      </Section>

      <Section eyebrow={t("gallery.sections.layout")} title="CheckBadge">
        <CheckBadge
          state="verified"
          verifiedLabel={t("gallery.checkVerified")}
          failedLabel={t("gallery.checkFailed")}
        />
        <CheckBadge
          state="failed"
          reason={t("gallery.checkReason")}
          verifiedLabel={t("gallery.checkVerified")}
          failedLabel={t("gallery.checkFailed")}
        />
        <CheckBadge
          state="none"
          verifiedLabel={t("gallery.checkVerified")}
          failedLabel={t("gallery.checkFailed")}
        />
      </Section>

      <Section
        eyebrow={t("gallery.sections.layout")}
        title="ContextBlock"
        layout="col"
      >
        <ContextBlock
          excerpt={t("gallery.contextExcerpt")}
          removeLabel={t("nav.close")}
        />
      </Section>

      <Section
        eyebrow={t("gallery.sections.rendering")}
        title="MarkdownView"
        layout="col"
      >
        <MarkdownView
          citationResolver={(id) =>
            id === 1
              ? t("components.citationSamples.sb")
              : t("components.citationSamples.pdf")
          }
          runnable
        >
          {t("gallery.markdownSample")}
        </MarkdownView>
      </Section>
    </>
  );
}
