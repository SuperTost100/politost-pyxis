# Pyxis design system — foundations

Pyxis is a free, open-source study tutor that runs on the student's own computer. The interface uses a near-black canvas, one centred column, pill controls and small uppercase mono labels. Its identity comes from the night sky it is named after: **cobalt** for the next step, **star gold** for where you are and where you aim, **aurora mint** for what you have mastered.

## Principles

- **One next step.** Every screen has at most one `primary` action, and it moves the student forward (Continua, Genera percorso, Invia).
- **Show the source.** Anything generated says where it came from: a `CitationChip` for grounded content, a `Tag` for AI-generated or general-knowledge content, the engine id on every reply.
- **Calm, not gamified.** No streaks, medals, confetti or mascots. Progress is shown as mastery against a target, nothing else.
- **Local and honest.** Status and errors are plain sentences with the fix. Local engines say that nothing leaves the machine.

## Content fundamentals

- Two interface languages, Italian and English. Write Italian first; it runs about 20% longer, so layouts must allow it.
- Address the student as **tu** / **you**. Pyxis speaks in the first person only inside tutor replies.
- Sentence case everywhere: "Nuovo piano", "Crea lezione". UPPERCASE only through the `label` style (tabs, eyebrows, the Consigliato badge).
- Short, concrete, no hype: "18 giorni all'esame · 0 su 9 argomenti", "Non hai eseguito l'accesso a Codex. Accedi". Never "AI-powered magic".
- Numbers as data: `meta` mono for percentages, dates and model ids ("obiettivo 80 %", "claude-sonnet-4-6").
- No emoji in UI copy or suggestions.

## Color

Dark is the primary theme; light is fully designed, on a warm paper ground. Set `data-theme="dark|light"` on `<html>`.

- Canvas `bg`; cards and the composer on `surface`; tiles, hovers and the student's bubbles on `surface-raised`; menus and modals on `surface-overlay` with `shadow-overlay`.
- Text: `ink` for content, `ink-muted` for metadata and inactive tabs, `ink-subtle` for placeholders and model ids. All three pass 4.5:1 on every surface in both themes.
- `primary` (cobalt) fills the one primary button, the selected option and the preparation meter. Its text form is `primary-text` (links, citations). Selected rows use `primary-soft`.
- `star` gold marks position and ambition only: the target tick, the current path node (`glow-star`), Consigliato badges. `star-text` on `star-soft` for warnings and general-knowledge labels. In light theme gold is never body text.
- `mastery` mint for progress fills, done nodes and correct answers; `mastery-text` on `mastery-soft` for the words.
- `danger` for wrong answers, severe gaps and destructive actions, always with an icon or word.
- Hairlines use `border` (decorative). Anything a user operates (inputs, secondary buttons, chips, quiz options) is outlined in `border-control`, which holds 3:1.
- Focus: a 2px solid `focus-ring` outline, 2px offset, on every focusable element. Gold on dark, cobalt on light; both 3:1+ on every surface.
- Behind modals, the whiteboard and the plan wizard: `scrim`.

No gradients. The defined effect  `glow-star`, used only on the current node.

## Typography

**Figtree** (variable, 300–900) for everything the student reads; **JetBrains Mono** (variable) for labels, data and code. Both are OFL and ship with the app in `fonts/`; nothing loads from the network.

- `display` for the home greeting; `title-1` for plan and wizard titles; `title-2` for sections; `title-3` for cards.
- `reading` (17/28) for tutor replies, smart text and flashcards, max 68ch. `body` (15/22) for UI; `small` (13/18) for metadata.
- `label` is mono UPPERCASE with 0.08em tracking: tabs, section eyebrows ("PREVISIONE PER L'ESAME"), badges. `meta` is lowercase mono for values. `code` for code blocks.
- `stat` (56px) is the one big number of a page.
- Dyslexia-friendly mode (PER-03) adds `letter-spacing: 0.05em`, `word-spacing: 0.16em` and `line-height: 1.8` to chat text, Markdown and source passages. It keeps the selected body text size and font family.
- LaTeX renders with KaTeX in its default fonts, sized to the surrounding text.

## Spacing, radius, size

- 4px base: `space-1` … `space-16`. Cards pad `space-6` (compact `space-4`); sections are `space-8` apart; path nodes `space-16` apart.
- Content lives in one centred column of `content-width` (768px). Header on top: back or wordmark left, doors (SegmentedTabs) centre, settings right.
- Radii: `radius-pill` for every action and tab; `radius-md` for tiles, options and nodes; `radius-lg` for cards and bubbles; `radius-xl` for large panels (composer, plan header, dock).
- Heights: `control-sm` 32, `control-md` 40 (default), `control-lg` 48 (bottom call to action).

## Elevation and motion

- Dark relies on surface steps and `border`; light adds `shadow-card` at rest. Only overlays get `shadow-overlay`.
- Motion is short and functional: 150ms colour and background transitions; 200ms fade/slide for sheets. No bounce, no celebration. Respect `prefers-reduced-motion`.
- Long AI tasks show streamed text or step lines ("Analizzo le fonti…", "Creo gli argomenti…"), never a blank spinner.

## Iconography

- **Lucide** line icons (ISC), 1.75 stroke, `currentColor`. In the app use `lucide-react`; the `Icon` component here mirrors it. The `Icons` asset group holds the core set as SVG files for docs.
- One icon per concept: Chiedi `message-circle`, Esami `graduation-cap`, smartbook `book-marked`, smart text `book-open`, flashcards `layers`, gaps `target`, concept map `network`, exercise `pencil-line`, quiz `list-checks`, true/false `square-split-horizontal`, review `repeat`, written simulation `file-pen`, locked `lock`, whiteboard `signature`, formula `sigma`, engines `terminal` / `key-round` / `hard-drive` / `cloud`, the tutor is the Pyxis mark (see Logo).
- No emoji as icons, no filled or duotone icons, no icons from antd's set mixed in.

## Logo

The mark is **star trails**: three long-exposure trails circling the pole star, the one fixed point you steer by. It says "steady progress around a fixed goal", which is what a study plan is.

- Mark: `ink` trails at 90 / 70 / 50% and a `star` gold four-point star. Use `pyxis-mark-dark.svg` on dark grounds, `pyxis-mark-light.svg` on light, `pyxis-mark-mono.svg` for one-colour print.
- Lockup: mark + "Pyxis" in Figtree 700 (outlined in the files), mark on the left. The header uses the lockup at 28px height.
- App icon: white trails and gold star on a `primary` rounded square (`pyxis-app-icon.svg`, PNG at 1024 for Electron builders). Below 32px use `pyxis-app-icon-small.svg`, which keeps only two thicker trails.
- Clear space is half the mark's height. Never recolour the star, add trails, rotate the mark or put it on a photo.
- The tutor's avatar in chat is the mark at 22px (`Logo` component).

## Building with this system

- UI is **Ant Design Pro** on antd v6: `@ant-design/pro-components` v3 in the Electron + Vite app, themed by `antd/pyxis-theme.ts` (`pyxisTheme` for antd, `pyxisProLayoutToken` for ProLayout). No Umi, no Pro admin template. See the *Ant Design Pro mapping* section.
- The shell is ProLayout in `top` mode with a fixed 768px content column (`antd/AppShell.tsx`): lockup left, Chiedi / Esami doors centred, settings right. No sidebar.
- Pyxis-specific pieces (Logo, PathNode, MasteryBar, LessonTile, Composer, ChatMessage, QuizOption, Flashcard, GapItem, EngineRow, CitationChip) are custom; the previews and `components/bundle.css` are their reference.
- Accessibility (NFR-09): every control reachable by keyboard, every icon-only button labelled, status never by colour alone, and all text pairs in this system at 4.5:1 or better in both themes.
