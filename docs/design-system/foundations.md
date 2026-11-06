# Foundations

Pyxis is a free, open-source study app that runs on the student's own computer. The 0.5 interface is calm and bookish: a paper or night ground, one centred column, Young Serif titles, teal for the next step, star gold for where you are and where you aim, and green for what you have mastered.

## Principles

- **One next step.** A screen has at most one `primary` action, and it moves the student forward.
- **Each element once.** Nothing appears twice on a screen: Home is the greeting and the composer, and the top bar's doors are not repeated below it.
- **Show the source.** Generated content says where it came from: numbered citations for grounded answers, a tag for general knowledge.
- **Calm, not gamified.** No streaks, medals, confetti or mascots. Progress is mastery against a target.
- **Native where it exists.** Context menus, file pickers and dialogs that the system already draws come from Electron. Pyxis draws its own only where the system can't, such as a red Delete button.
- **Local and honest.** Status and errors are plain sentences with the fix.

## Copy

- Two interface languages, Italian and English. Write Italian first; it runs about 20% longer, so layouts must allow it.
- Address the student as **tu** / **you**.
- Sentence case everywhere: "Nuova chat", "Inizia a studiare". No uppercase labels.
- Short and concrete: "Imposta le ore a settimana per vedere quando studierai ogni argomento." Never "AI-powered magic".
- The word is "flashcard", never "schede". AI tools are named Claude, ChatGPT, Gemini and Cursor in what the student reads.
- No emoji in UI copy.

## Colour

Both themes are designed; set `data-theme="dark|light"` on `<html>`. The values live in `tokens.json` and `tokens.css`.

| Token                                                | Use                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `bg`                                                 | The page ground, the top bar and the chat sidebar                               |
| `surface`, `surface-overlay`                         | Cards, the composer, the doors card, menus and dialogs                          |
| `surface-raised`                                     | Hover, the student's messages, soft buttons and the selected chat row           |
| `surface-sunken`                                     | Wells inside a card                                                             |
| `ink`, `ink-muted`, `ink-subtle`                     | Content, metadata, placeholders. All three hold 4.5:1 on every surface          |
| `primary` (`#14807a` dark, `#0f6e66` light)          | The one primary button and the selected option                                  |
| `primary-text`, `primary-soft`                       | Links and citations; the selected door and tinted notices                       |
| `star`, `star-text`, `star-soft`                     | Position and ambition only: the target mark, the current path node, Consigliato |
| `mastery`, `ok` and their `-soft` forms              | Progress fills, done nodes, right answers                                       |
| `danger`, `danger-soft`                              | Wrong answers and destructive actions, always with a word or an icon            |
| `ring-prep`, `ring-path`, `ring-today`, `ring-track` | The exam page's three rings                                                     |
| `border`, `border-control`                           | Hairlines; outlines of anything the student operates (3:1)                      |
| `focus-ring`                                         | A 2px outline, 2px offset, on every focusable element                           |
| `scrim`                                              | Behind dialogs and full-screen tools                                            |

No gradients. The one glow, `glow-star`, marks the current path node.

## Type

Four bundled families, all under the OFL: **Young Serif** for titles, **Figtree** for the interface and for reading, **Source Serif 4** for long reading where a screen asks for it, and **JetBrains Mono** for values and code.

| Style                 | Font              | Size  | Use                                                              |
| --------------------- | ----------------- | ----- | ---------------------------------------------------------------- |
| `display`             | Young Serif 400   | 40/44 | The Home greeting, at 46px on Home                               |
| `title-1`             | Young Serif 400   | 28/34 | Page titles                                                      |
| `title-2`             | Young Serif 400   | 22/28 | Sections                                                         |
| `title-3`             | Figtree 600       | 17/24 | Card titles                                                      |
| `reading`             | Figtree 400       | 17/28 | Answers, lessons, flashcards; at most about 68 characters a line |
| `body`, `body-strong` | Figtree 400 / 600 | 15/22 | Interface text                                                   |
| `small`               | Figtree 400       | 13/18 | Metadata                                                         |
| `label`               | Figtree 600       | 13    | Field labels and eyebrows, sentence case                         |
| `stat`                | Figtree 600       | 56/56 | The one big number on a page                                     |

- Every size scales with the student's text size through `--text-scale`.
- Mono is for values only: grades, dates, durations, model ids and code.
- The dyslexia-friendly mode adds letter and word spacing and a taller line height to reading text.
- Formulas render with KaTeX in its own fonts, sized to the surrounding text.

## Spacing, radius and size

- A 4px base: `space-1` to `space-16`. Cards pad `space-6` (`space-4` when compact); sections sit `space-8` apart.
- Content lives in one centred column of `content-width` (768px). Settings takes 960px from a 960px window, for its section list. Chiedi runs edge to edge: the chat sidebar (264px, 232px under 1100px) at the left edge, the chat's header across the rest, and the conversation in the 768px column.
- The top bar is 60px high. On macOS it leaves 116px at the left for the traffic lights and the 48px after them.

| Radius                     | Value       | Use                                           |
| -------------------------- | ----------- | --------------------------------------------- |
| `radius-sm`                | 8px         | Menu items, rows, small icon buttons          |
| `radius-field`             | 10px        | Buttons, inputs, selects, segmented controls  |
| `radius-md`                | 12px        | Tiles, options, the doors card                |
| `radius-card`              | 14px        | Cards and the composer                        |
| `radius-lg`                | 16px        | Dialogs and side panels                       |
| `radius-xl`, `radius-pill` | 24px, 999px | Older screens only; new work doesn't use them |

Control heights are `control-sm` 32, `control-md` 40 (the default) and `control-lg` 48.

## Elevation and motion

- `shadow-raised` lifts the doors card and cards that float on the ground. `shadow-card` is the resting card shadow, `shadow-overlay` the one for menus and dialogs.
- Motion is short: 150ms for colour and background, 200ms for sheets. No bounce. Everything respects `prefers-reduced-motion`.
- Long AI work shows the Pyxis mark turning and a line that says what it does, never a blank spinner.

## Icons

- **Lucide** line icons, 1.75 stroke, `currentColor`, through `lucide-react` or the `Icon` component.
- One icon per concept, the same everywhere: Library `book-open`, Attività `clock`, Settings `settings`, the sidebar fold `panel-left`, New chat `square-pen`.
- No emoji as icons, no filled icons, and no icons from Ant Design's set.

## Logo

The mark is **star trails**: three trails circling the pole star, the fixed point you steer by.

- The top bar shows the mark at 24px beside "Pyxis" in Young Serif 20px. The brand opens Home.
- Mark files: `pyxis-mark-dark.svg` on dark grounds, `pyxis-mark-light.svg` on light, `pyxis-mark-mono.svg` for one colour.
- App icon: white trails and a gold star on a teal (`#14807a`) rounded square, `pyxis-app-icon.svg`. Below 32px use `pyxis-app-icon-small.svg`, which keeps two thicker trails. `build/icon.png` is its 1024px render.
- Never recolour the star, add trails or rotate the mark.

## Building screens

- Screens use Pyxis's own components where they exist (see [Components](components.md)), then Ant Design v6 themed by `pyxis-theme.ts`. Ant Design goes away screen by screen during 0.5, and a screen that has moved imports nothing from `antd`.
- The shell is Pyxis's own top bar (`app/layouts/Shell.tsx`): the brand, the Chiedi · Esami · Mappe doors, then Library, Attività and Settings at the right.
- Accessibility: every control reachable by keyboard, every icon-only button labelled, state never shown by colour alone, and the contrast the tests above check.
