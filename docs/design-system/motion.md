# Motion

Motion shows where something came from and where it went. It grows out of what caused it, and only something with no origin on screen may simply fade in.

## Tokens

The tokens live in `tokens.css`. Use them instead of writing a duration or a curve by hand.

| Token              | Value                             | For                                                  |
| ------------------ | --------------------------------- | ---------------------------------------------------- |
| `--duration-micro` | 120ms                             | Presses, checks, colour, every exit of a small thing |
| `--duration-small` | 200ms                             | Popovers, rows, toasts, items in a list              |
| `--duration-large` | 320ms                             | Side panels, sheets, dialogs                         |
| `--ease-out`       | `cubic-bezier(0.23, 1, 0.32, 1)`  | Everything that enters or leaves                     |
| `--ease-in-out`    | `cubic-bezier(0.77, 0, 0.175, 1)` | Something moving from one place to another on screen |
| `linear`           |                                   | Progress bars and the working mark                   |

The table below gives exact times where a kind needs one; they stay within the token's range (180 to 220ms for small, 280 to 350ms for large).

## What moves, and how

| What               | From where                                                                            | How long                 | Easing      | Reduced motion                   |
| ------------------ | ------------------------------------------------------------------------------------- | ------------------------ | ----------- | -------------------------------- |
| Popover, menu      | Grows from its button: `transform-origin` on the button's edge, scale 0.94 to 1       | 180ms in, 120ms out      | ease-out    | Fades, 120ms                     |
| Side panel, sheet  | Slides in from the edge it belongs to, leaves the same way                            | 320ms in, 220ms out      | ease-out    | Fades, 120ms                     |
| Source panel       | Grows from the cover or citation that opened it, scale 0.94 to 1; leaves to the right | 320ms in, 220ms out      | ease-out    | Fades, 120ms                     |
| A row that expands | Grows in place, the height first; the rows below move down                            | 200ms                    | ease-out    | Opens at once                    |
| Map branches       | Lines draw out of their node, then each child grows at the line's end, 40ms apart     | About 300ms in all       | ease-out    | Children fade in, no lines drawn |
| An item added      | Grows where it lands, the list opens around it, then a tint fades                     | 200ms                    | ease-out    | Appears, the tint stays          |
| An item removed    | Shrinks into where it goes (Archivio, the deck), or in place; the gap closes after    | 220ms + 200ms            | ease-in-out | Fades, the gap closes at once    |
| Page change        | A short cross-fade, never a slide                                                     | 150ms                    | ease-out    | Instant                          |
| Toast, notice      | Slides down from under the top strip, goes back up                                    | 220ms in, 160ms out      | ease-out    | Fades                            |
| Press              | Scales to 0.98 on pointer-down                                                        | 100ms                    | ease-out    | Colour only                      |
| Checked            | The switch knob slides, the radio dot grows from the centre                           | 180ms, 150ms             | ease-out    | Instant                          |
| Flashcard          | Turns over on its vertical axis                                                       | 130ms + 150ms            | ease-out    | Cross-fade                       |
| Working mark       | The three rings turn about the star, in alternate directions                          | 2.4s, 3.2s and 4s a turn | linear      | The mark breathes                |

## Rules

- Never `ease-in`, which starts slowly and feels late, and never `transition: all`.
- Animate `transform` and `opacity`. The one exception is a row's height, through `grid-template-rows`.
- Exits run faster than entrances, and nothing locks input while it moves.

## Reduced motion

With `prefers-reduced-motion: reduce`, the global rule in `global.css` turns movement off and keeps fades:

- Transitions keep only colour, fill, border, shadow and opacity, at the element's own duration. A transform or a height then jumps to its end, so a popover or a sheet fades in place and a row opens at once. An element with no transition of its own gets none.
- Keyframe animations run once and end at once, except the working mark, which breathes.

A component needs its own reduced-motion rule only when the fallback in the table differs from that, such as a flashcard that cross-fades instead of turning.

## What never animates

- Typing, the caret and text the student is reading.
- What people do many times a day: moving between sections, opening the command palette, rating a flashcard, choosing a quiz answer. These change colour at most.
- Anything reached from the keyboard, such as moving through a list with the arrows.
- Numbers. A score or a count shows its new value; it never counts up.
- The first paint of a screen. Pyxis opens straight into the task, with no entrance choreography.
