# Controls and buttons

Which control fits which choice, the mistakes to avoid, and the button tiers. The controls live in [`Controls.tsx`](../../src/renderer/src/components/Controls.tsx), the buttons in [`Button.tsx`](../../src/renderer/src/components/Button.tsx) and [`IconButton.tsx`](../../src/renderer/src/components/IconButton.tsx).

## Which control for which choice

One look per kind of choice, so the same kind of question always looks the same. Pick the control from the shape of the choice, never from the room left on the screen.

| The choice                                          | Use                        | Never                                                   |
| --------------------------------------------------- | -------------------------- | ------------------------------------------------------- |
| 2 or 3 short options                                | `Segmented`                | Radio rows or a dropdown for two words                  |
| 2 to 6 options that each need a line of explanation | `RadioRows`                | A grid of big buttons, one of them filled               |
| A long list, 7 or more, or one that grows           | A native `select` in a row | Radio rows that push the page down, a grid of buttons   |
| On or off                                           | `SwitchRow`                | Two buttons "Sì" and "No", a segmented On and Off       |
| A number                                            | `Stepper`                  | A slider for an exact number, a bare field              |
| A free list of words                                | `TagsField`                | One text field with commas                              |
| A choice you judge by looking                       | `PreviewTiles`             | Words alone, when a picture would decide it             |
| A short text value in settings                      | `TextRow`                  | A bordered field with a label above it, inside the card |
| Several items to tick, each on its own              | Checkbox rows              | A switch for each item of a list                        |

Every control sits in a row of a white card (`ControlList`): the name on the left, one line on what it does, the control on the right. Preview tiles, tags and checkboxes take the full width of the card under their row.

`Segmented`, `RadioRows` and `PreviewTiles` are radio groups: one tab stop, the arrow keys move the choice, and the chosen item shows the focus ring when it came from the keyboard.

## The mistakes to avoid

Each of these reached a test build. The fix is the control from the table above.

- **A grid of big buttons for one choice.** Seven boxes compete, and the chosen one is told apart by a border. A dropdown in a row says the same in one line.
- **An outlined secondary button.** It reads as generic. Secondary buttons are a soft fill with no border.
- **A box inside a box.** A bordered field with its own label, inside a card inside a card. The value sits in its row as a soft field, and the row's name is its label.
- **A `details` triangle used as an action.** It hides a command behind a disclosure. An action is a button that names it; a disclosure only reveals an explanation, with a chevron that turns.

## Buttons

Three tiers and one danger style, all without outlines. A view has one primary button, and its label starts with the verb of the step forward.

| Tier                             | Looks                                  | Use                                                                                                                            |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Primary, `variant="primary"`     | Solid `--primary`, white label         | The one step forward in the view: Crea l'esame, Gira, Consegna, Aggiungi                                                       |
| Secondary, `variant="secondary"` | Soft `--surface-raised`, no border     | Every other action that matters: Copia ora, Sposta                                                                             |
| Ghost, `variant="ghost"`         | Text in `--ink-muted`, a fill on hover | Quiet actions and the way out: Annulla, Apri, the study bar                                                                    |
| Danger, `variant="danger"`       | Soft fill, label in `--danger`         | What deletes or can't be undone, with "…" when a confirmation follows. The confirmation's own button is the only solid red one |
| Icon, `IconButton`               | A plain icon, a fill on hover          | Tools whose icon is known, always with a label for screen readers and a tooltip                                                |

### Sizes

| Size | Height                | Use                                                   |
| ---- | --------------------- | ----------------------------------------------------- |
| `sm` | 30px (`--control-sm`) | Rows, popovers and bars                               |
| `md` | 34px (`--control-md`) | Everywhere else, the default                          |
| `lg` | 42px (`--control-lg`) | Only the one study action under a flashcard or a quiz |

All three use `--radius-field`.

### States

- **Hover** darkens the fill a little; a ghost button gains the `--surface-raised` fill.
- **Focus** is the 2px ring in `--focus-ring`, shown only from the keyboard.
- **Press** scales the button to 0.98 in 100ms on pointer-down and back on release. No ripple, no bounce. With reduced motion only the colour changes.
- **Disabled** fades to 45% opacity.
- **Working:** a button that starts work keeps its place and says what it is doing, with the working mark, until the work is done. It never turns into a bare spinner.

### Where the main action goes

- **A page:** beside the title, on the right, or at the end of the form it completes. It never floats over the content.
- **A settings row:** on the row's right, small and secondary. One row, one action, plus a ghost "Apri" at most.
- **A popover or dialog:** at the bottom right, the primary last and Annulla as ghost before it.
- **A study screen:** the way back on the left of the bar, tools on the right as ghost buttons, and the study action as the one large primary under the content.
- **Something destructive:** never teal, and never the default focus in a dialog.
