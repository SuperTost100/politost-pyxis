# Layout patterns

The shapes every screen is built from. A new screen picks from these before it invents anything.

## Page head

The title in Young Serif (`.title-1`), one line under it on what the page is for, and the page's main action on the right.

## Settings rows in a white card

A group title (`.title-3`), an optional line under it, then a white card of rows split by hairlines. Each row has its name, one line on what it does and one control. The card is `--radius-card` with `--shadow-raised`, and its rows follow the [nested-corner rule](foundations.md#corners). `ControlGroup` and `ControlList` in `Controls.tsx` draw it; Studio, Profilo and Dati e privacy use it.

## List cards

Items the student opens sit as rows in one card: a name, a line under it, and a time or count on the right in tabular figures. The whole row is the link, with a fill on hover.

## The sidebar shell

One sidebar for the whole app: Cerca, the sections, the recent chats and the profile at the foot. The current section sits on a white card. Folded, it is a column of icons with each name on hover. The lesson, the quiz and the flashcards are full-screen, without it.

## The study bar

Over the lesson, the quiz and the flashcards. The way back is a ghost button that names where it goes, the title and the count sit in the middle, and the tools are ghost buttons on the right. There is no close button: the way back is the way out.

## Side panels

What opens beside a screen, such as a source at its page, is a sheet along the right edge of the window, and the screen stays usable beside it. The sheet slides in from that edge and leaves the same way. Its head holds the title and the close button.

The source panel (`SourceViewer` in `components/SourceViewer.tsx`) is 520px wide, below Attività's corner. From 1180px the page moves over and stays usable beside it; on a narrower window it covers the page's right side, and below 640px it starts after the folded sidebar. Its head has the file's name on one line, its menu (the same as the file's cover) and the close button, with what the file is under the name and the way back under that. The paging row has the arrows round the page number, which can be typed over, and "Apri il file" on the right. The page sits on `--surface-sunken`, `--bg` in dark, and a PDF page stays white in both themes. The cited passage gets a 2px line in the page's margin beside its lines, with no colour behind the text. Escape and the close button close it, focus goes back to what opened it, and a second source opened while it is open moves it instead of opening another.

## Popovers

A popover belongs to the button that opened it: it sits 8px from it, lines up with its edge and grows out of it. Escape and a click outside close it, and focus goes back to the button.

## Item menus

Whatever has a three-dots menu opens the same menu on a right-click, at the pointer, and on the context-menu key and Shift+F10 under the focused element. Escape closes it and focus goes back to where it was. A menu holds actions on the item and nothing else. The behaviour is shared (`useItemMenu`, `MenuItemArea` and the dots button `MenuButton` in `components/ItemMenu.tsx`, the rules in `lib/itemMenu.ts`), so a new row wires it in one line and gives the dots and the right-click one `menu`. An item with `children` opens a submenu, such as Esporta with its formats: the right arrow opens it, and the left arrow and Escape close it. A submenu opens beside its menu, never over it: on the right of its row, on the left when the right has no room, and moved up to stay inside the window. Only when neither side has room does it cover the menu, and then it moves below or above the row that opened it. What deletes goes last, after a hairline, in soft red with "…". A menu never lists keyboard shortcuts, which live in Help's shortcuts dialog. Text fields and anything marked `data-native-menu` keep the system's own menu.

A text field inside such an item (a name being renamed on a subject or a tile) is not part of the item's menu: a right-click there opens the system's text menu (`textMenuTemplate`), which `keepsSystemMenu` in `lib/itemMenu.ts` leaves alone. A name that renames in place from its menu also renames on a double-click when a single click does nothing else: a subject's name in the Library and a map's title on its page do, a map tile's or a file cover's name does not, since a click there opens it.

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
