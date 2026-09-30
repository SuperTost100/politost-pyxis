# Pyxis design system — components

Custom components and their rules. The live versions are in `reference/index.html`; `reference/bundle.css` is the styling reference.

## Logo

The Pyxis mark: star trails circling the pole star, the fixed point you steer by. Use it for the app icon, the header and the tutor's avatar.

**Consumer provides** `size` (px), `wordmark` to add "Pyxis" in Figtree 700, `inverse` on a `primary` fill (the app icon).

- The trails are `ink` at 90 / 70 / 50% strength; the star is always `star` gold. Never recolour the star or add a fourth trail.
- Minimum size 16px; below 32px use the two-trail file `pyxis-app-icon-small.svg`.
- Clear space: half the mark's height on every side. The wordmark sits right of the mark, never below.
- In the header use `wordmark` at 28px height. The tutor avatar uses the mark alone at 22px.
- Files: `assets/Logo/` holds the mark (dark, light, mono), lockups with the wordmark outlined, and the app icon (SVG + 1024px PNG).

## Icon

Line icon from the Lucide set, drawn at a 1.75 stroke in `currentColor`.

**Consumer provides** `name` (a Lucide id), optional `size` (default 20), `strokeWidth`, and `label` when the icon stands alone and means something.

- In the app use `lucide-react` directly (`<GraduationCap size={20} strokeWidth={1.75} />`); this component mirrors it for previews.
- Icons take the colour of their text: `ink` for actions, `ink-muted` for decoration, a status token only next to a status word.
- Sizes: 16 in chips and small buttons, 18–20 in controls, 32 in study-path nodes. Never mix stroke widths on one screen.
- Don't use icons as decoration in cards or emoji instead of icons.

## Button

Pill-shaped action button; maps to antd `Button` with `shape="round"`.

**Consumer provides** the label (children), `variant` (`primary` | `secondary` | `ghost` | `danger`), `size` (`sm` 32px | `md` 40px | `lg` 48px), optional `icon`, `block`, and the usual button props.

- One `primary` per view: the next study step (Continua, Genera percorso, Invia). Everything else is `secondary` or `ghost`.
- `lg` is for the single call to action at the bottom of a flow (the recommended-lesson dock, wizard steps).
- `danger` only for destructive actions, always behind a confirm (Elimina piano, Elimina chat).
- Labels are verbs in the interface language, sentence case: "Nuovo piano", not "NUOVO PIANO".
- antd: `<Button type="primary" shape="round">`, `type="default"` for secondary, `type="text"` for ghost, `danger` for danger.

## IconButton

Circular icon-only button for the header, the composer toolbar and message actions.

**Consumer provides** `icon`, `label` (required: becomes `aria-label` and tooltip), optional `variant` (default `secondary`), `size`.

- Use for well-known actions only (back, close, settings, send, copy). Anything ambiguous gets a text `Button`.
- The label is always set; screen readers depend on it (NFR-09).
- antd: `<Button shape="circle" icon={<X/>} aria-label="Chiudi" />`.

## SegmentedTabs

Pill tab switcher with UPPERCASE mono labels: the signature Astra-style navigation.

**Consumer provides** `items` (`{value, label, icon?, badge?}`), `value` or uncontrolled default, `onChange`, and a `label` for the tablist.

- Use for the header doors (Chiedi / Esami), plan pages (Percorso di studio / Argomenti / Fonti / Progressi), the Create lesson groups (Impara / Esercitati / Esame) and Progress tabs.
- 2–5 items. The active item is an `ink` pill with `on-ink` text in both themes.
- Labels are written in sentence case in code and uppercased by the style (`label` type style); keep them to one or two words.
- antd: `<Segmented shape="round" options={…} />` themed through the `Segmented` component token block in `antd/pyxis-theme.ts`.

## TextField

Pill input with an optional leading icon, for search and short single-line entries.

**Consumer provides** `placeholder`, `value`/`onChange` or `defaultValue`, optional `icon`, `size` (`md` | `lg`), `label` when there is no visible label.

- Search fields always carry the `search` icon; wizard fields use `lg`.
- Multi-line input is the `Composer` or antd `Input.TextArea` with `radius-md`, never a pill.
- The outline is `border-control`; focus draws the 2px `focus-ring`.
- antd: `<Input variant="outlined" prefix={<Search/>} />` with `Input.activeBorderColor` set in the theme.

## Chip

Suggested follow-up question shown under a tutor reply (ASK-03).

**Consumer provides** the question text and `onClick` (sends it as the next message).

- At most three, right-aligned under the reply, hidden when the user turns suggestions off.
- Text only; no emoji. An icon only when the chip triggers a tool (formula, graph).
- antd: a `Button` with `shape="round"` and `type="default"`, or a `Tag.CheckableTag` if selection is needed.

## Tag

Small mono label that states where content came from or what state it is in.

**Consumer provides** the text and `tone`: `neutral` (AI-generated, imported), `smartbook`, `general` (answer from the model's general knowledge, LES-32), `mastered`, `severe`, `recommended`.

- Origin tags are mandatory on generated items (SB-03, PLAN-11, LES-32): users must always know if content came from their sources.
- Each tone carries an icon so meaning never relies on colour.
- Lowercase text, except `recommended`, which is uppercase like Astra's "CONSIGLIATO".
- antd: `<Tag bordered={false} color=…>` with the colours in `antd/pyxis-theme.ts`.

## CitationChip

Inline source reference that opens the cited smartbook section or PDF page in the viewer (SB-05).

**Consumer provides** the short citation text (`Book · chapter`, `file · page`), `kind` (`smartbook` | `pdf`) and `onClick` to open the viewer.

- Place right after the sentence it supports, inside the reply text.
- Keep it short: book or file name, then chapter or page. Full details live in the viewer.
- Every grounded claim gets one; answers without a citation show the `general` Tag instead.

## MasteryBar

Horizontal mastery meter with a gold target marker.

**Consumer provides** `value` (0–100), optional `target` (the plan's target score), `tone` (`mastery` default, `primary` for the preparation header), `showValue`.

- `mastery` mint on plan cards and topic rows; `primary` cobalt only in the big preparation StatTile.
- The `star` gold tick always means "your target". Nothing else uses a gold tick.
- Exposed as `role="meter"` with a label.
- antd: `<Progress percent={23} strokeColor={token.mastery} showInfo={false} />` plus the target tick as an absolutely positioned child.

## PlanCard

A study plan in the home list (PLAN-30): subject, title, mastery against target, days to exam and Continue.

**Consumer provides** `subject`, `title`, `mastery`, `target`, `meta` (a pre-formatted line), `onContinue`, optional `cta` label.

- Two per row in the list at `content-width`; stack on narrow windows.
- The meta line is `days to exam · topics on track`; never more than one line.
- The whole card is not a link; only the button acts, so keyboard users hit one target.
- antd: `<Card>` with `styles.body` padding from the theme, `actions` replaced by the footer row.

## StatTile

The preparation summary at the top of Progress (PRO-01): one big number, target pills, meter and two counts.

**Consumer provides** `label`, `value`, `target`, `pills` (mono data strings), `stats` (two `{value, label}`).

- One per page. The number uses the `stat` style; everything else stays small so the number wins.
- Pills are data in lowercase mono (`meta` style): "obiettivo 80 %", "+4 % questa settimana".
- antd: `<Card>` + `<Statistic>` with `valueStyle` bound to the `stat` style.

## LessonTile

Choice tile in the Create lesson sheet (Impara / Esercitati / Esame).

**Consumer provides** `icon`, `label`, optional `recommended` (star badge) and `count` (items waiting, e.g. due cards).

- Grid of two columns, `space-4` gap. One tile at most is `recommended`, chosen by the scheduler.
- Icons: smart text `book-open`, flashcards `layers`, gaps `target`, map `network`, exercise `pencil-line`, quiz `list-checks`, true/false `square-split-horizontal`, review `repeat`, simulation `file-pen`.
- antd: `<Card hoverable>` inside `<Row gutter={16}>`, or `Radio.Group` with custom `Radio.Button` when it is a form choice.

## PathNode

A stop on the vertical study path (PLAN-21, PLAN-22).

**Consumer provides** `icon`, `label`, `state` (`done` | `current` | `available` | `locked`), `unlockHint` for locked nodes, and the click handler.

- Exactly one `current` node, marked by the gold `glow-star`: the student's position.
- `done` is mint, `locked` is dashed with a lock icon and says what unlocks it.
- Nodes sit `space-16` apart, joined by 1px `border` connectors that zig-zag like Astra's path; connectors to done nodes use `mastery`.
- Custom component; antd has no equivalent (Steps is too rigid).

## GapItem

A knowledge gap in Progress (PRO-02): severity, one plain sentence, topic and a fill action.

**Consumer provides** `severity` (`severe` | `minor`), the sentence (children), `topic`, `onFill`.

- The sentence says what is misunderstood, in second person, one line if possible.
- Severe gaps first. Severity is a dot, a word and a colour together.
- antd: `<List.Item>` with `actions={[<Button>Colma</Button>]}`.

## Composer

The tutor chat input (ASK-01…05): subject pill, scoped sources, text, attach, whiteboard, formula, Solver/Socratic switch, send.

**Consumer provides** `subject`, `sources` (names of scoped sources), `mode` default, `placeholder`, `streaming` (shows Stop instead of Send), and the handlers.

- Sits at the bottom of the chat column at `content-width`, `radius-xl`.
- No microphone and no voice button: voice is out of v1.
- Enter sends, Shift+Enter breaks the line, Esc stops a stream.
- antd: `<Sender>` from `@ant-design/x` is the closest; otherwise `Input.TextArea autoSize` inside a styled container.

## ChatMessage

A turn in the tutor chat: student bubble on the right, tutor reply on the left with actions, engine id and suggestions.

**Consumer provides** `role` (`user` | `tutor`), the content (children: text, CitationChips, rendered LaTeX, code), `engine` (provider · versioned model id, ASK-10), optional `suggestions`, `general` when the answer is not from the sources.

- Tutor text uses the `reading` style (17/28) at max 68ch; dyslexia mode raises letter spacing and line height.
- Actions: copy, thumbs up, thumbs down, regenerate. No read-aloud.
- The engine id is always visible, in `meta` mono, `ink-subtle`.
- antd: `<Bubble>` from `@ant-design/x`, themed with these tokens.

## QuizOption

An answer option in quizzes and true/false (LES-11, LES-12).

**Consumer provides** `letter`, the text, `state` (`idle` | `selected` | `correct` | `wrong`), `onClick`.

- `correct` and `wrong` always show an icon and a word, so they work without colour.
- After feedback, the explanation with citations goes below the options, with "Chiedi al tutor" (LES-14).
- Keys 1–4 or A–D select options.
- antd: `Radio.Group` with `optionType="button"` restyled, or custom as here.

## Flashcard

A flashcard review with queue counters and the four Algor-style ratings (FC-02…FC-07).

**Consumer provides** `front`, `back`, `source`, `counters` (`{nuove, apprendimento, padroneggiate}`), `flipped`, and a rating handler.

- Click or Space flips; keys 1–4 rate: Impossibile, Difficile, Facile, Facilissima.
- Ratings appear only after the flip. The back always carries its citation.
- Custom component.

## EngineRow

An engine in the Engine for AI settings (ENG-10…ENG-17): kind, name, versioned model id, status and one action.

**Consumer provides** `kind` (`cli` | `api` | `local` | `remote`), `name`, `model` (a concrete versioned id, never "latest"), `status` (`ok` | `warn` | `error` | `idle`), optional `statusText`, `isDefault`.

- Status is always a dot and a word. Local engines say that nothing leaves the machine (ENG-21).
- Errors read as the fix: "Accesso richiesto" with an Accedi button, not a stack trace (NFR-05).
- antd: `<List.Item>` with `avatar`, `title`, `description` and `extra`.
