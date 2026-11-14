# Controls and buttons

Which control fits which choice, the mistakes to avoid, and the button tiers. The controls live in [`Controls.tsx`](../../src/renderer/src/components/Controls.tsx), the buttons in [`Button.tsx`](../../src/renderer/src/components/Button.tsx) and [`IconButton.tsx`](../../src/renderer/src/components/IconButton.tsx).

## Which control for which choice

One look per kind of choice, so the same kind of question always looks the same. Pick the control from the shape of the choice, never from the room left on the screen.

| The choice                                          | Use                        | Never                                                   |
| --------------------------------------------------- | -------------------------- | ------------------------------------------------------- |
| 2 or 3 short options                                | `Segmented`                | Radio rows or a dropdown for two words                  |
| A scope, a length or a count before starting        | `ActivityChoice`           | Outlined pills                                          |
| 2 to 6 options that each need a line of explanation | `RadioRows`                | A grid of big buttons, one of them filled               |
| A long list, 7 or more, or one that grows           | A native `select` in a row | Radio rows that push the page down, a grid of buttons   |
| On or off                                           | `SwitchRow`                | Two buttons "Sì" and "No", a segmented On and Off       |
| A number                                            | `Stepper`                  | A slider for an exact number, a bare field              |
| A free list of words                                | `TagsField`                | One text field with commas                              |
| A choice you judge by looking                       | `PreviewTiles`             | Words alone, when a picture would decide it             |
| A short text value in settings                      | `TextRow`                  | A bordered field with a label above it, inside the card |
| Several items to tick, each on its own              | Checkbox rows              | A switch for each item of a list                        |
| A few kinds to keep or leave out, at least one kept | `ToggleChips`              | Checkbox rows that double a dialog's height             |

Every control sits in a row of a white card (`ControlList`): the name on the left, one line on what it does, the control on the right. Preview tiles, tags and checkboxes take the full width of the card under their row.

`Segmented`, `RadioRows` and `PreviewTiles` are radio groups: one tab stop, the arrow keys move the choice, and the chosen item shows the focus ring when it came from the keyboard. `PreviewTiles` with `variant="icons"` is the small form for a choice of kinds, as in "Crea un'attività": an icon over its name on a soft tile, six in a row or two rows of three when the window is narrow or the text is large. The chosen tile is filled with `--primary-soft`, its name in `--primary-text` and bold, with no ring, so the ring is left for the keyboard focus.

### Choices before starting an activity

The first screen of a quiz, a simulation and a review draws each choice with `ActivityChoice`: the label on the left and the control filling the rest of the row. Up to three options are a `Segmented`, a radio group with one tab stop where the arrow keys move the choice. More than three options, such as the simulation's lengths, which grow with the exam's own length, are a native `select` in the same row, because a growing row of segments would not fit at 960px with large text. The page keeps its own value type: a number stays a number.

The kinds of question in a quiz are `ToggleChips` under their label, with the same hint as "Crea un'attività": at least one kind stays chosen.

### Toggle chips

`ToggleChips` is a row of rounded chips, each a kind the student keeps or leaves out, such as the kinds of question in a quiz. A pressed chip is tinted `--primary-soft` with its name in `--primary-text` and a check that grows in; an unpressed one is a plain soft chip. Colour is never the only signal: the check comes and goes with the state.

- Each chip is a `button` with `aria-pressed`, inside a `group` named by its label. Every chip is a tab stop, and Space or Enter toggles it.
- At least one chip stays on. The last pressed chip can't be turned off: it keeps its tab stop, carries `aria-disabled`, and its description says why ("Almeno un tipo di domanda resta scelto"), so a screen reader hears its state and the reason.
- The check grows from the chip's start in 150 ms, ease-out; under reduced motion it appears at once. A press scales the chip to 0.98.

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
- **A popover or dialog:** at the bottom right, the primary last and Annulla as ghost before it. A dialog follows [Dialogs](#dialogs).
- **A study screen:** the way back on the left of the bar, tools on the right as ghost buttons, and the study action as the one large primary under the content.
- **Something destructive:** never teal, and never the default focus in a dialog.

## Dialogs

Every dialog is `Dialog` (`components/Dialog.tsx`), and every question with buttons is asked through `useConfirm`, so a confirmation, a form and a notice look and behave the same. The browser's own boxes (`window.confirm`), Ant Design's `Modal` and its `modal.confirm` and `modal.warning` are gone, and so are the native `<dialog>`s that Crea un'attività and Nuova flashcard drew for themselves.

| Rule           | What it does                                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title          | `.title-2` in Young Serif, sentence case, never an icon. A confirmation asks a question: "Eliminare Fisica 1?"                                                                                                                                                  |
| Close          | An X at the top right only in a dialog that only informs (`cancel={false}`), such as the keyboard shortcuts. With Annulla there is no X                                                                                                                         |
| Buttons        | At the bottom right: Annulla as ghost, then the one confirming button named by its action ("Crea la mappa", "Elimina l'esame"). A destructive one is `danger-solid`, any other `primary`. An extra action such as "Archivia invece" is `secondary`, on the left |
| Focus on open  | The field the page names, else the first field, else Annulla. Never the destructive button                                                                                                                                                                      |
| Focus inside   | Tab and Shift+Tab go round inside it; the page behind is inert                                                                                                                                                                                                  |
| Focus on close | Back to what it grew out of, or to what had the focus before it opened                                                                                                                                                                                          |
| Escape         | Closes it like Annulla, unless its work is running (`busy`). A menu or list opened inside it closes first                                                                                                                                                       |
| Click outside  | Closes it like Annulla, unless it is busy or a text field in it holds typed text                                                                                                                                                                                |
| Long content   | The body scrolls; the title and the buttons stay in view. A long label wraps inside its button                                                                                                                                                                  |
| Width          | 460px for a confirmation, 560 for a form, 720 for a preview, never wider than the window less 16px a side                                                                                                                                                       |
| Layer          | A native modal `<dialog>`, in the top layer above the source panel, popovers and menus. Menus opened inside it are drawn inside it                                                                                                                              |

One question at a time: asked while another is open, `useConfirm` answers "cancel" at once and nothing opens.

A select, a date picker or a menu opened inside a dialog is drawn inside it (`getPopupContainer`), because anything Ant Design puts in the document's body would sit under the native dialog. The dialog does not clip it, so a long list can reach past the card. An Escape that a field or list uses (a select closing its list, a rename field cancelling) belongs to that one and does not close the dialog. A source opened from a citation inside a dialog is drawn inside that dialog and closes with it. An Escape that cancels a keyboard reorder belongs to the reorder.

Enter in a single-line field runs the dialog's confirming action, as the browser would submit a form with its own submit button, when that action is on and the dialog is not busy; a busy dialog does nothing. It does not in a text area, a search, a select's list or a form that has a submit button of its own, and a dialog that opts out (`enterConfirms={false}`) leaves it to its fields: Nuova flashcard, where Enter must never save or write by accident, and the picker of a new exam, where Enter filters.

### The dialogs

A dialog that starts its work from rows or tabs in its body (a list of books, the tabs of Aggiungi fonti) has no confirming button, and its way out is "Chiudi". A dialog that only informs has the X. Crea un'attività and Nuova flashcard change height while they are open, so they stay 64px from the top of the window instead of re-centring.

| Dialog                                                      | Width                  | Buttons                                                                     | X   |
| ----------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------- | --- |
| Nuova mappa                                                 | md                     | Annulla, Crea la mappa                                                      | no  |
| Aggiungi un ramo, Rinomina il nodo, Collega i nodi (a map)  | md                     | Annulla and the action                                                      | no  |
| Esporta                                                     | md                     | Annulla, Salva file                                                         | no  |
| Aggiungi fonti (Library, exam, past papers, new exam)       | md                     | Chiudi                                                                      | no  |
| Aggiungi le fonti di un esame                               | lg                     | Annulla, Collega le fonti selezionate                                       | no  |
| The Library picker of a new exam                            | md                     | Annulla, Aggiungi N                                                         | no  |
| Sposta in una materia nuova                                 | md                     | Annulla, Sposta                                                             | no  |
| Gestisci materie                                            | md                     | Chiudi                                                                      | no  |
| Importa un esame (the file's review)                        | lg                     | Annulla, Importa                                                            | no  |
| Libri PoliTost gratuiti                                     | md                     | Chiudi                                                                      | no  |
| Apri un PDF protetto                                        | md                     | Annulla, Apri il PDF                                                        | no  |
| Crea flashcard (from a text, a reply or a map)              | lg                     | Annulla, Crea di nuovo on the left, Salva N flashcard                       | no  |
| Nuova flashcard                                             | md, lg while reviewing | Annulla, Salva e scrivine un'altra, Salva; Crea di nuovo on the left        | no  |
| Modifica la flashcard                                       | md                     | Annulla, Salva                                                              | no  |
| Importa o esporta Anki                                      | md                     | Annulla, the action; Fatto after the result                                 | no  |
| Crea un'attività                                            | md                     | Annulla, Crea l'attività                                                    | no  |
| Ricostruisci gli argomenti                                  | lg                     | Annulla or Continua a lavorare, Scarta on the left, the action of its state | no  |
| An activity's preview (exam page, titled with its kind)     | lg                     | none                                                                        | yes |
| Quale sezione riscrivo? and Riscrivere la lezione in parti? | md                     | Annulla, Riscrivi                                                           | no  |
| Aggiungi strumento AI                                       | lg                     | Chiudi, or Annulla and Salva e prova on the key's tab                       | no  |
| Installazione e accesso di uno strumento AI                 | md                     | Chiudi                                                                      | no  |
| Cosa esce da questo computer                                | md                     | Non ora, Ho capito                                                          | no  |
| Scorciatoie da tastiera                                     | md                     | none                                                                        | yes |

An Ant Design `Drawer` (the AI tool's details, the source details), a `Popconfirm` and the search palette are not dialogs and keep their own look.

### Naming a destructive action

A menu names what it deletes, and the confirmation repeats the words on its button.

| Where                    | Rule                                                                                         | Example                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A menu item              | "Elimina" plus the thing, with "…" when a confirmation follows, in soft red after a hairline | "Elimina la chat…", "Elimina il file…", "Elimina la flashcard…"      |
| The confirming button    | The same words without "…", as `danger-solid`, never "Elimina" alone or "Elimina per sempre" | "Elimina la chat", "Elimina l'esame"                                 |
| The title                | A question that names the thing                                                              | "Eliminare «Fisica 1»?"                                              |
| The body                 | What is lost and what stays                                                                  | "Le fonti restano nella Libreria."                                   |
| Nothing is deleted       | The action keeps its own verb, as the thing stays elsewhere                                  | "Scollega…", "Rimuovi dall'esame"                                    |
| An item with no question | No "…": an action Pyxis can undo runs at once                                                | "Elimina la flashcard" on a card Pyxis wrote, which Undo brings back |

A confirmation that starts work passes it as `run`, so the dialog stays, busy, until it ends and cannot start it twice. When the work removes what the dialog grew out of, the focus is placed once the dialog has closed (`onClosed`), because the page behind it is inert until then.

### Leaving without saving

A page that holds work it does not save by itself calls `useLeaveGuard({ dirty, body })`. Whatever moves away (its back control, the sidebar, a link, the menu's Indietro) asks once, "Uscire senza salvare?", with the page's sentence on what would be lost, "Resta qui" as ghost and "Esci senza salvare" as `danger-solid`. Staying keeps the page and the focus as they were. A dialog that holds typed work asks the same question through `useConfirm` when it closes. Work that saves itself (quiz answers, lesson progress, a chat draft, settings) leaves without asking.
