# Foundations

Colour, type, spacing, corners, depth, icons and numbers. Every screen is built from these, and a screen that needs a new value adds a token first. The values live in [`tokens.css`](../../src/renderer/src/design-system/tokens/tokens.css) and [`tokens.json`](../../src/renderer/src/design-system/tokens/tokens.json); this page gives their names and what each is for.

## Colour

Teal is the one accent. The ring colours belong to the exam rings and their legend, and nothing else uses them. Both themes are designed: set `data-theme="dark"` or `data-theme="light"` on `<html>`, or on any element that should show the other theme, such as a theme preview.

Targets are measured against the weakest ground a colour sits on: 4.5:1 for text, 3:1 for control edges, focus and rings.

| Token                                                              | Use                                                                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `--bg`                                                             | The ground behind every screen                                                                              |
| `--surface`                                                        | Cards, the side panel, settings lists                                                                       |
| `--surface-raised`                                                 | Soft fills: secondary buttons, hover, the student's chat messages, fields in a row                          |
| `--surface-sunken`                                                 | Panels inside a card: a formula, a graph, code                                                              |
| `--surface-overlay`                                                | Popovers, menus and dialogs, always with `--shadow-overlay`                                                 |
| `--border`                                                         | Hairlines between rows and groups. Decorative, so it has no contrast target                                 |
| `--border-control`                                                 | The edge of a text field, the stepper, the tags field and the switch track (3:1)                            |
| `--ink`                                                            | Titles, body text, icons that mean something                                                                |
| `--ink-muted`                                                      | Secondary text: the line under a title, ghost buttons                                                       |
| `--ink-subtle`                                                     | Descriptions, times, group labels, placeholders                                                             |
| `--primary`                                                        | The one primary button, a checked switch, radio or box. Its label is `--on-primary`                         |
| `--primary-text`                                                   | Links, the current item, the ring around a chosen preview tile, progress                                    |
| `--primary-soft`                                                   | Behind citations and counts, and the selected segment in dark                                               |
| `--focus-ring`                                                     | A 2px outline, 2px away, on everything focusable                                                            |
| `--ok`, `--mastery`                                                | A right answer, a finished step, "Aggiunta". Always with a check or a word                                  |
| `--danger`                                                         | A wrong answer, an error line, the label of a destructive button                                            |
| `--star`, `--star-text`                                            | The star in the mark and the app icon                                                                       |
| `--ring-prep`, `--ring-path`, `--ring-today`                       | The three exam rings and their legend                                                                       |
| `--cover-1` to `--cover-6`, `--on-cover`                           | A subject's book covers in the Library, picked from the subject's id, and the title printed on them (4.5:1) |
| `--cover-none`                                                     | A book or handout with no subject yet                                                                       |
| `--kind-slides`, `--kind-exam`, `--kind-notes`, `--kind-exercises` | The colour of each kind of file's cover, with `--on-cover` marks on it (3:1)                                |
| `--kind-board`                                                     | The blackboard in a photo's cover                                                                           |
| `--paper`, `--paper-edge`, `--paper-line`, `--staple`, `--spiral`  | The sheets, lines, staples and notebook spiral drawn on covers. Decorative                                  |
| `--scrollbar-thumb`, `--scrollbar-thumb-hover`                     | The scrollbar thumb at rest and on hover (see [Layout](layout.md#scroll-areas))                             |

No gradients and no glass. State is never shown by colour alone.

## Type

Young Serif for titles, Figtree for everything else, all bundled under the OFL. Every size scales with the text size in Impostazioni through `--text-scale`. Italics are for maths only, in Source Serif 4, and never stress a word.

| Class          | Font and size                  | Use                                                                               |
| -------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| `.display`     | Young Serif 40/44              | The Home greeting and the exam name                                               |
| `.title-1`     | Young Serif 36/40              | Page titles                                                                       |
| `.title-2`     | Young Serif 22/28              | Sections, popovers, the side panel                                                |
| `.title-3`     | Figtree 650, 15.5/20           | The title over a group of settings                                                |
| `.body-strong` | Figtree 600, 14.5/20           | Row and list item names                                                           |
| `.reading`     | Figtree 16/1.65                | Lessons, about 87 characters a line. The chat is 15.5/1.6, quiz questions 18/1.55 |
| `.body`        | Figtree 14/20                  | Buttons, fields, menus                                                            |
| `.small`       | Figtree 13/18                  | Descriptions, times, counts                                                       |
| `.label`       | Figtree 600, 13/18             | The one label style: sentence case, never capitals                                |
| `.meta`        | Figtree 12/16, tabular figures | Values in a row: grades, dates, counts, model names                               |
| `.code`        | JetBrains Mono 13/20           | Raw input and paths only                                                          |

- **Mono is for text that is code**: the raw input of the formula field, a folder path in Dati e privacy, token names in docs. Grades, dates, times, counts and model names stay in Figtree with tabular figures.
- **Headlines** say what is on the screen ("Come ti spiega", not "Impostazioni generali") and wrap with `text-wrap: balance`, so a two-line title never leaves one word alone.
- The dyslexia-friendly mode adds letter and word spacing and a taller line to reading text.
- Formulas render with KaTeX in its own fonts, sized to the text around them.

## Spacing

A 4px base, from `--space-1` (4) through `--space-2` (8), `--space-3` (12), `--space-4` (16), `--space-5` (20), `--space-6` (24) and `--space-8` (32) to `--space-12` (48) and `--space-16` (64). Group with space first: things that belong together sit close and groups sit far apart, so a screen needs few lines and boxes.

| Between                                              | Space      |
| ---------------------------------------------------- | ---------- |
| A title and the line under it                        | 2 to 4px   |
| Items of one group, and a group's title and its card | 8 to 12px  |
| Inside a row                                         | 12 to 16px |
| Inside a card that holds text                        | 24px       |
| Groups on a page                                     | 30 to 32px |
| Sections of a long page                              | 48 to 64px |

## Corners

Moderate corners, 8 to 16px. Circles only where the thing is round: the radio, the switch, a tag, the avatar, the rings and the path markers. Buttons are never pills.

| Token            | Value | Use                                     |
| ---------------- | ----- | --------------------------------------- |
| `--radius-sm`    | 8px   | Rows, icon buttons, nav items           |
| `--radius-field` | 10px  | Buttons, fields, segmented controls     |
| `--radius-md`    | 12px  | Panels inside a card                    |
| `--radius-card`  | 14px  | Cards, popovers, the composer           |
| `--radius-lg`    | 16px  | The side panel, the quiz sheet, dialogs |

**Nested corners.** An element inside another takes the outer radius minus the padding between them, rounded to the nearest radius token and never larger than the outer one. A card of 14 with 6px of padding holds rows of 8. A card of 14 holding rows of 14 looks swollen.

`--radius-xl` and `--radius-pill` remain for screens not yet moved to this look. New work doesn't use them.

## Depth

Separate with space first, then a fill, then a shadow; a border comes last. Shadows mean height. In dark the surfaces get lighter as they rise, with a faint rim in place of the soft shadow.

| Token              | Use                                                                 |
| ------------------ | ------------------------------------------------------------------- |
| `--shadow-card`    | Resting: the selected segment, small chips                          |
| `--shadow-raised`  | Cards on the ground: settings lists, the side panel, the quiz sheet |
| `--shadow-overlay` | Above everything: popovers, menus, dialogs, the command palette     |
| `--shadow-cover`   | A filter, not a box shadow: lifts a drawn file cover off its card   |

- Never a card inside a card. A group inside a card is rows split by hairlines.
- Nothing is pressed in, inset or glowing. The one glow, `--glow-star`, marks the current path node.

## Icons

Lucide only, at a 1.75 stroke, in `currentColor`, through `lucide-react` or the `Icon` component. One icon per idea, the same everywhere, and never an emoji.

| Idea              | Icon             |
| ----------------- | ---------------- |
| Nuova chat        | `square-pen`     |
| Cerca             | `search`         |
| Esami             | `graduation-cap` |
| Mappe             | `network`        |
| Libreria          | `book-open`      |
| Attività          | `clock`          |
| Impostazioni      | `settings`       |
| Fold the sidebar  | `panel-left`     |
| Stop              | `square`         |
| Undo the last one | `undo-2`         |
| Needs you         | `circle-alert`   |
| Done              | `circle-check`   |

Sizes: 14px in small buttons, 16px by default, 18px in the sidebar and toolbars, 20px for the mark of a job row.

## Numbers

Tabular figures (`font-variant-numeric: tabular-nums`) wherever a number changes or lines up: counts, scores, times, the stepper, the question grid. With proportional figures a counting number shakes the words after it.

Italian numbers use a decimal comma and a space before the unit: 2,4 GB, 18,5 px. Counts read "12 di 37", not "12/37".

## Logo

The mark is star trails: three trails circling the pole star, the fixed point you steer by. With `<Logo working />` the trails turn, which is the [working mark](feedback.md#the-working-mark).

- Mark files: `pyxis-mark-dark.svg` on dark grounds, `pyxis-mark-light.svg` on light, `pyxis-mark-mono.svg` for one colour.
- App icon: white trails and a gold star on a teal (`#14807a`) rounded square, `pyxis-app-icon.svg`. Below 32px use `pyxis-app-icon-small.svg`, which keeps two thicker trails. `build/icon.png` is its 1024px render.
- Never recolour the star, add trails or rotate the mark.
