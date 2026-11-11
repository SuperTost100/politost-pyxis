# Components

The shared components live in `src/renderer/src/components/`, one `.tsx` file per component with its CSS beside it. Use one of these before writing a new control, and before reaching for Ant Design. Components that belong to one feature live with that feature, for example the chat sidebar in `features/ask/ChatPanel.tsx`.

The doc comment at the top of each file says what it does and why; this page is the index.

## Controls

The settings controls are rows in a white card, one look per kind of choice. [Controls and buttons](controls.md) says which one fits which choice.

| Component                            | What it's for                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `Button`                             | Every text button: `primary` (one per view), `secondary`, `ghost` and `danger`, at 30, 34 and 42px       |
| `IconButton`                         | An icon-only button with its label for screen readers; can keep focus in the field being typed in        |
| `ControlGroup`, `ControlList`        | A titled group of settings and the white card of rows under it                                           |
| `ControlRow`, `TextRow`, `SwitchRow` | A row with any control on its right, a short text field, an on or off switch                             |
| `Segmented`                          | 2 or 3 short options side by side, such as Italiano and English                                          |
| `RadioRows`                          | 2 to 6 options that each need a line of explanation                                                      |
| `PreviewTiles`                       | A choice judged by looking, such as the theme: a small picture per option, the chosen one ringed         |
| `Stepper` (`Controls.tsx`)           | A whole number with − and +                                                                              |
| `TagsField`                          | A free list of words, each a tag                                                                         |
| `Reveal`                             | Content that grows out of the control that opened it, such as a confirmation                             |
| `Chip`                               | A small rounded choice or filter                                                                         |
| `SegmentedTabs`                      | Tabs inside a page, such as Esami · Fonti · Flashcard                                                    |
| `ItemMenu`                           | `useItemMenu` and `MenuItemArea`: a right-click or the menu key opens an item's three-dots menu          |
| `BackLink`                           | The way back above a page's title: an arrow and the name of the place it leads to                        |
| `ListToolbar`                        | The bar above a list: search, filters, a secondary menu and the one primary action, always in that order |
| `Stepper` (`Stepper.tsx`)            | Where the student is in a short flow of named steps, such as setup and the new exam                      |
| `MathInput`                          | A written answer with formulas: `$` or the sigma button opens a formula at the caret                     |
| `Composer`                           | The message box in Chiedi, with attachments, the whiteboard, formulas, the graph and the subject chip    |
| `CrashReportsSwitch`                 | The crash-report choice as a labelled switch row, the same in setup and Settings                         |
| `EngineUseChoice`                    | Automatic, or the AI tools the student ticks                                                             |

A row, tile or card with a three-dots menu uses `ItemMenu`: the dots and a right-click open the same `menu`, so both show the same items ([item menus](layout.md#item-menus) has the rules). Wire `useItemMenu` or `MenuItemArea` rather than building another dropdown for a row. Chats are the exception: their menu is the system's own, through `window.pyxis.contextMenu` (see `features/ask/chatActions.tsx`), in the sidebar and in the search, which is a modal dialog that a menu drawn in the page would sit behind. Text fields and anything marked `data-native-menu` keep the system's menu for copy, paste and spelling.

## Status and feedback

| Component      | What it's for                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Notice`       | An inline message with a tone (info, warning or danger), an optional action and technical details                       |
| `ErrorState`   | A failed load, build or quiz: one danger notice that says what failed, the fix, and the details behind a toggle         |
| `LoadError`    | A failed load with Try again, so a page never stays empty without a word                                                |
| `StepLines`    | The steps of a long job, each pending, running, done or failed                                                          |
| `BuildingMark` | The Pyxis mark drawing its trails while an exam is built                                                                |
| `Logo`         | The Pyxis mark; with `working` its rings turn, the [working mark](feedback.md#the-working-mark) for AI work in progress |
| `Tag`          | A short label on an item, such as "general knowledge"                                                                   |
| `CheckBadge`   | Whether a figure or a result was checked, failed the check, or can't be checked                                         |
| `EngineNotice` | The one-time notice for an AI tool that is ready but not yet acknowledged                                               |
| `ScanNotice`   | What a scanned source needs before it can be read                                                                       |

## Study

| Component         | What it's for                                                                          |
| ----------------- | -------------------------------------------------------------------------------------- |
| `PathNode`        | One step of an exam's path: done, current or ahead                                     |
| `LessonTile`      | A study activity on an exam page, optionally marked Consigliato                        |
| `ExamRings`       | An exam's three rings, Preparazione, Percorso and Oggi, with `RingLegend` for its page |
| `MasteryBar`      | A bar from 0 to 100 with an optional target mark                                       |
| `StatTile`        | A number with its label and a small bar                                                |
| `QuizOption`      | One answer of a multiple-choice question, before and after the check                   |
| `GapItem`         | A gap to fill, named after its topic                                                   |
| `CardFaceFields`  | A flashcard's front and back while it is edited                                        |
| `MakeCardsDialog` | Makes flashcards from a selection, a reply or a map                                    |
| `ProposedCards`   | Flashcards Pyxis wrote, to edit or drop before saving, in both card dialogs            |
| `SmartText`       | A lesson's text with its inline checks                                                 |
| `SelectionMenu`   | The actions on selected text in lessons and sources: ask, make a flashcard, copy       |

## Messages and content

| Component      | What it's for                                                                      |
| -------------- | ---------------------------------------------------------------------------------- |
| `ChatMessage`  | A question or an answer in Chiedi, with its actions                                |
| `MarkdownView` | Markdown with formulas, code and citations, shared by answers, lessons and sources |
| `CitationChip` | A numbered citation that opens its source at the page                              |
| `ContextBlock` | A quoted passage the next question refers to, with a way to remove it              |
| `Figure`       | A figure drawn in the Python sandbox, with its caption                             |
| `PythonBlock`  | A Python block in an answer that can run                                           |

## Sources and AI tools

| Component                               | What it's for                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `SourceRow`                             | One source in a list, with its kind and state                                     |
| `SourceDetails`                         | A source's pages, reading state, the exams that use it and the pages lessons cite |
| `SourceViewer`                          | A source opened at a page, beside the screen                                      |
| `PdfSourcePage`                         | One PDF page with the cited passage marked, inside the viewer                     |
| `PdfPasswordDialog` (`PdfPassword.tsx`) | Asks for the password of a locked PDF and runs its import again                   |
| `OcrDataCard` (`OcrData.tsx`)           | Progress and recovery for the local OCR language data                             |
| `FreeBooks`                             | The free books and whether a newer version can update the copy in the Library     |
| `EngineRow`                             | One AI tool with its state, each state with its own icon and word                 |
| `ProviderSetup`                         | Who makes each AI tool and which account signs in to it                           |
| `LocalModelCard` (`LocalModel.tsx`)     | The model that runs on this computer: hardware check, download and state          |
| `Icon`                                  | A Lucide icon by name, at the stroke and size the system uses                     |
