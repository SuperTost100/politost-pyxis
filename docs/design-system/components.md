# Components

The shared components live in `src/renderer/src/components/`, one `.tsx` file per component with its CSS beside it. Use one of these before writing a new control, and before reaching for Ant Design. Components that belong to one feature live with that feature, for example the chat sidebar in `features/ask/ChatPanel.tsx`.

The doc comment at the top of each file says what it does and why; this page is the index.

## Controls

| Component            | What it's for                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `Button`             | Every text button: `primary` (one per screen), `secondary`, `ghost` and `danger`, in three sizes         |
| `IconButton`         | An icon-only button with its label for screen readers; can keep focus in the field being typed in        |
| `Chip`               | A small rounded choice or filter                                                                         |
| `SegmentedTabs`      | Tabs inside a page, such as Esami · Fonti · Flashcard                                                    |
| `ListToolbar`        | The bar above a list: search, filters, a secondary menu and the one primary action, always in that order |
| `Stepper`            | Where the student is in a short flow of named steps, such as setup and the new exam                      |
| `MathInput`          | A written answer with formulas: `$` or the sigma button opens a formula at the caret                     |
| `Composer`           | The message box in Chiedi, with attachments, the whiteboard, formulas, the graph and the subject chip    |
| `CrashReportsSwitch` | The crash-report choice as a labelled switch row, the same in setup and Settings                         |
| `EngineUseChoice`    | Automatic, or the AI tools the student ticks                                                             |

Context menus are the system's own, through `window.pyxis.contextMenu` (see `features/ask/ChatPanel.tsx`). Don't build a dropdown menu for actions on a row.

## Status and feedback

| Component      | What it's for                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `Notice`       | An inline message with a tone (info, success, warning, danger), an optional action and technical details        |
| `ErrorState`   | A failed load, build or quiz: one danger notice that says what failed, the fix, and the details behind a toggle |
| `LoadError`    | A failed load with Try again, so a page never stays empty without a word                                        |
| `StepLines`    | The steps of a long job, each pending, running, done or failed                                                  |
| `BuildingMark` | The Pyxis mark drawing its trails while an exam is built                                                        |
| `Logo`         | The Pyxis mark; with `working` its rings turn, for AI work in progress                                          |
| `Tag`          | A short label on an item, such as "general knowledge"                                                           |
| `CheckBadge`   | Whether a figure or a result was checked, failed the check, or can't be checked                                 |
| `EngineNotice` | The one-time notice for an AI tool that is ready but not yet acknowledged                                       |
| `ScanNotice`   | What a scanned source needs before it can be read                                                               |

## Study

| Component         | What it's for                                                                    |
| ----------------- | -------------------------------------------------------------------------------- |
| `PathNode`        | One step of an exam's path: done, current or ahead                               |
| `LessonTile`      | A study activity on an exam page, optionally marked Consigliato                  |
| `PlanCard`        | An exam in the Esami list, with its mastery                                      |
| `MasteryBar`      | A bar from 0 to 100 with an optional target mark                                 |
| `StatTile`        | A number with its label and a small bar                                          |
| `QuizOption`      | One answer of a multiple-choice question, before and after the check             |
| `GapItem`         | A gap to fill, named after its topic                                             |
| `CardFaceFields`  | A flashcard's front and back while it is edited                                  |
| `MakeCardsDialog` | Makes flashcards from a selection or a reply                                     |
| `SmartText`       | A lesson's text with its inline checks                                           |
| `SelectionMenu`   | The actions on selected text in lessons and sources: ask, make a flashcard, copy |

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

| Component       | What it's for                                                                     |
| --------------- | --------------------------------------------------------------------------------- |
| `SourceRow`     | One source in a list, with its kind and state                                     |
| `SourceDetails` | A source's pages, reading state, the exams that use it and the pages lessons cite |
| `SourceViewer`  | A source opened at a page, beside the screen                                      |
| `PdfSourcePage` | One PDF page with the cited passage marked, inside the viewer                     |
| `PdfPassword`   | Asks for the password of a locked PDF and runs its import again                   |
| `OcrData`       | Consent, progress and recovery for the local OCR language data                    |
| `FreeBooks`     | The free books and whether a newer version can update the copy in the Library     |
| `EngineRow`     | One AI tool with its state, each state with its own icon and word                 |
| `ProviderSetup` | Who makes each AI tool and which account signs in to it                           |
| `LocalModel`    | The model that runs on this computer: hardware check, download and state          |
| `Icon`          | A Lucide icon by name, at the stroke and size the system uses                     |
