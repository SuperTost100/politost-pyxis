# Layout patterns

The shapes every screen is built from. A new screen picks from these before it invents anything.

## Page head

The title in Young Serif (`.title-1`), one line under it on what the page is for, and the page's main action on the right.

## Settings rows in a white card

A group title (`.title-3`), an optional line under it, then a white card of rows split by hairlines. Each row has its name, one line on what it does and one control. The card is `--radius-card` with `--shadow-raised`, and its rows follow the [nested-corner rule](foundations.md#corners). `ControlGroup` and `ControlList` in `Controls.tsx` draw it; Studio, Profilo and Dati e privacy use it.

## List cards

Items the student opens sit as rows in one card: a name, a line under it, and a time or count on the right in tabular figures. The whole row is the link, with a fill on hover.

## The sidebar shell

One sidebar for the whole app: Cerca, the sections, the recent chats and the profile at the foot. The current section sits on a white card. Folded, it is a column of icons with each name on hover. The study pages (the lesson, the quiz, the flashcards, the exercises, the introduction, Ripasso and the simulation) are full-screen, without it.

## Going back

A page opened from another page has one way back, at its top left: an arrow and the name of the place it returns to, such as "← Analisi Matematica 2". It leads to where the student came from. With nothing behind it (the first page of a window, a page opened by a reminder or a file, a trail that was lost), it leads to the page's parent and takes the page's place in history, so the parent then shows its own way back. The sidebar sections have none, and each row of the sidebar opens its section's main page. Vai > Indietro, the mouse's back button and, on macOS, the three-finger swipe (when the trackpad is set to deliver it) do what the control does, and Avanti, the forward button and the opposite swipe go one page forward; the menu greys either where it would do nothing, and both during a running exam simulation.

| Part           | Rule                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control        | `BackControl` in `components/BackControl.tsx`: `variant="page"` above a shell page's title, `variant="bar"` at the left end of the study bar, before its thin separator. A ghost button in `--ink-muted`, the fill on hover, the focus ring from the keyboard, 0.98 when pressed and 45% while the page records what it must before leaving |
| Label          | The place's name, in the app's language: an exam's title, a topic, a map's name, or a section such as Mappe. A name longer than 24 characters is cut with "…", and the whole one is in the control's title. A screen reader hears "Torna a {{place}}" / "Back to {{place}}"                                                                 |
| Where it leads | Where the student came from, by moving back in the window's history, so history keeps one entry per page. A move inside a page (a lesson's parts, Settings' sections, a filter) replaces the entry instead of adding one                                                                                                                    |
| Parent         | A page under an exam goes to the exam, the exam to Esami, a map to Mappe at its subject, a review of the day's flashcards to Flashcard, the Quaderno and Tutte le flashcard to the exam they were narrowed to or to Esami. `app/places.ts` holds the whole table                                                                            |
| Focus          | Back on the page it left, the focus returns to what opened it (a step of the path, a tile, a row), or to its row when the step is folded away, or to the page's main heading. The page does not scroll unless that element is out of sight, and a page that places the focus itself on arrival keeps it there                               |
| Escape         | Never leaves a page                                                                                                                                                                                                                                                                                                                         |

A page takes its place with `usePlace` (`app/usePlace.ts`): it writes its own name for the controls that lead to it, and gets back its way back. A button that names the place it returns to, such as "Torna al percorso", goes back the same way when the back control leads there (`returnTo`).

## The study bar

`StudyBar` is the bar over every study page. It is 56 px high, it is the window's drag strip, and from left to right it holds:

1. The back control (`BackControl variant="bar"`), or nothing on a running simulation.
2. A thin separator, only after a back control.
3. The title block: the topic or the thing as the title, and one line under it that says what the student is doing and where they are in it. The title sits beside the back control, not in the middle. Under 1,100 px a lesson's title opens the parts in a popover (`titleMenu`).
4. A flexible space.
5. The page's tools (`BarTool`): ghost buttons with an icon and a word. Under 1,100 px the word is kept for screen readers only.
6. The page's dots (`MenuButton`), when the page has a menu. They hold actions only, and a right-click on them opens the same menu.
7. Attività (`JobsButton keep`), always last at the far right.

A link in the Attività list that leaves the page (a failed job's "Vai agli strumenti AI") leaves it the way the back control does: it waits for the page's `beforeLeave` (`BackTarget.leave`) and stays when that says no. On a running simulation, where nothing leaves, those links are off and give the reason. A page's own shortcuts (the flashcards' Space and ratings, a quiz's number keys) do nothing while the focus is inside an open dialog, menu or the Attività list (`lib/pageKeys.ts`).

The bar draws the page's `progress` as a thin line along its bottom edge. A page has no foot button for the way back, since the bar's control is that: no "Indietro", no "Torna al percorso". The questions of a quiz and a simulation have "Domanda precedente" for the previous question.

| Page                         | Title                                                           | Line                                                                                                                       | Tools                             | Dots                                                           |
| ---------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------- |
| Lesson part                  | the topic                                                       | "Lezione · Parte 3 di 5 · circa 6 minuti"                                                                                  | Livello                           | the part's menu                                                |
| Older lesson                 | the topic                                                       | "Lezione · circa 8 minuti"                                                                                                 | Livello                           | the lesson's menu                                              |
| Quiz                         | the topic, or "Test diagnostico", "Rifai gli errori", "Ripasso" | "Quiz · domanda 3 di 10, senza limite di tempo"; on a diagnostic and a Ripasso "Le risposte restano: riprendi quando vuoi" | the clock of a timed quiz         | Esporta, on the results                                        |
| Flashcards                   | the topic, the subject, "Flashcard di oggi" or "Ripasso"        | "Flashcard · 4 di 12"                                                                                                      | Nuova flashcard, Annulla l'ultima | Esporta, on a topic's deck. Modifica is in the card's own menu |
| Exercises                    | the topic                                                       | "Esercizi · 6 esercizi, dal libro"                                                                                         | Fai il quiz                       | none                                                           |
| Introduction                 | the exam                                                        | "Introduzione"                                                                                                             | none                              | none                                                           |
| Ripasso, before it starts    | the exam                                                        | "Ripasso · the subject"                                                                                                    | none                              | none                                                           |
| Simulation, running          | "Simulazione · the exam"                                        | "Non puoi uscire: si esce consegnando o allo scadere del tempo"                                                            | the clock                         | none                                                           |
| Simulation, before and after | "Simulazione"                                                   | the exam's subject and title                                                                                               | none                              | Esporta, on the results                                        |

The new exam, the guided exam and the tools (Lavagna, Grafico, Python) keep their own top bar until they move onto this one.

## Side panels

What opens beside a screen, such as a source at its page, is a sheet along the right edge of the window, and the screen stays usable beside it. The sheet slides in from that edge and leaves the same way. Its head holds the title and the close button.

The source panel (`SourceViewer` in `components/SourceViewer.tsx`) is 520px wide, below Attività's corner. From 1180px the page moves over and stays usable beside it; on a narrower window it covers the page's right side, and below 640px it starts after the folded sidebar. Its head has the file's name on one line, its menu (the same as the file's cover) and the close button, with what the file is under the name and the way back under that. The paging row has the arrows round the page number, which can be typed over, and "Apri il file" on the right. The page sits on `--surface-sunken`, `--bg` in dark, and a PDF page stays white in both themes. The cited passage gets a 2px line in the page's margin beside its lines, with no colour behind the text. Escape and the close button close it, focus goes back to what opened it, and a second source opened while it is open moves it instead of opening another.

## Popovers

A popover belongs to the button that opened it: it sits 8px from it, lines up with its edge and grows out of it. Escape and a click outside close it, and focus goes back to the button. A menu or a dialog opened from inside it counts as inside, so Escape closes that first. A popover taller than the room under its button scrolls inside itself, and the window never scrolls for it. `Popover` in `components/Popover.tsx` draws one; the button that opens it says so with `hasPopup="dialog"`, `expanded` and `controls`.

## Item menus

Whatever has a three-dots menu opens the same menu on a right-click, at the pointer, and on the context-menu key and Shift+F10 under the focused element. Escape closes it and focus goes back to where it was. A menu holds actions on the item and nothing else. The behaviour is shared (`useItemMenu`, `MenuItemArea` and the dots button `MenuButton` in `components/ItemMenu.tsx`, the rules in `lib/itemMenu.ts`), so a new row wires it in one line and gives the dots and the right-click one `menu`. An item with `children` opens a submenu, such as Esporta with its formats: the right arrow opens it, and the left arrow and Escape close it. A submenu opens beside its menu, never over it: on the right of its row, on the left when the right has no room, and moved up to stay inside the window. Only when neither side has room does it cover the menu, and then it moves below or above the row that opened it. What deletes goes last, after a hairline, in soft red with "…". A menu never lists keyboard shortcuts, which live in Help's shortcuts dialog. Text fields and anything marked `data-native-menu` keep the system's own menu.

A text field inside such an item (a name being renamed on a subject or a tile) is not part of the item's menu: a right-click there opens the system's text menu (`textMenuTemplate`), which `keepsSystemMenu` in `lib/itemMenu.ts` leaves alone. A name that renames in place from its menu also renames on a double-click when a single click does nothing else: a subject's name in the Library and a map's title on its page do, a map tile's or a file cover's name does not, since a click there opens it.

## The page's menu

A page's own actions (importing, exporting, the Library's free books) are the dots (`MenuButton`, `icon="ellipsis"`, `size="md"`) in the page's head, beside its main action, with an accessible name that says what the menu is for: "Altro su Esami", "Altro sull'esame", "Altro sulle flashcard", "Altro sulla Libreria". There is no "Altro" text button. The head is also an item with that menu (`MenuItemArea`), so a right-click on it opens the menu at the pointer, and the context-menu key and Shift+F10 open it under the focused element, the dots when they have the focus. A text field in the head keeps the system's menu. Build the menu once as a `MenuProps` and give it to both the dots and the head. Help's shortcuts dialog lists "Apri il menu della pagina · Maiusc F10".

`ChoiceMenu` (`components/ListToolbar.tsx`) is a different thing: a round button with a label and a chevron that offers a choice, such as "Scegli altro" at the foot of a lesson part. It never holds a page's actions.

## Empty states

One line on what will appear here and the action that starts it, in the place where the content will be. No illustration, no joke, no second button.

## Scroll areas

Every scroll area, popovers and menus included, uses the same thin scrollbar in the app's colours on every system. It shows that there is more without competing with the content, and it doesn't cut square through the rounded corner of a popover.

| Part   | Rule                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Gutter | 10px. A column that may scroll keeps it with `scrollbar-gutter: stable`, so content never jumps                                       |
| Thumb  | 4px wide inside the gutter, 6px on hover, fully rounded                                                                               |
| Colour | `--scrollbar-thumb` at rest, ink at 30%. `--scrollbar-thumb-hover`, ink at 50%, holds 3:1 or more against every ground in both themes |
| Track  | Transparent in both themes                                                                                                            |

The rule is global, in `global.css`. Chromium ignores `::-webkit-scrollbar` styles on any element that sets `scrollbar-width` or `scrollbar-color`, so the app sets neither. The bar changes only the look. Chromium makes a scroll area with nothing focusable inside it a tab stop of its own, so the arrow keys and Page Up and Down scroll it; don't take that away with `tabIndex={-1}`.
