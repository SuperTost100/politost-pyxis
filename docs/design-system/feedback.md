# Working, loading and feedback

When Pyxis works, the place where the result will appear says so: the Pyxis mark with its rings turning, and one line on what it is doing. A spinner alone in the middle of nothing is never enough.

## The working mark

`<Logo working />` beside one line in `--ink-muted`. The line says what Pyxis reads or makes, such as "Sto preparando un quiz · ho letto 2 fonti", and changes at most every 3 seconds with a 300ms fade.

| Where                                  | Size                                  |
| -------------------------------------- | ------------------------------------- |
| In a button or a small row             | 16 to 18px, in place of the icon      |
| In a line of text                      | 22px                                  |
| In the slot where a result will appear | 44px, centred, with the line under it |

A button that starts work keeps its place and its label says what it is doing ("Sto copiando"), with the mark beside it. Next to a label the mark is decorative (`decorative`), so a screen reader hears the words and not the logo. Under reduced motion the rings stand still and the mark breathes.

## Skeletons for short loads

A list or a page that loads from this computer shows a skeleton in its final layout, so nothing jumps when it arrives. It appears only after 150ms, so a fast load never flashes it. AI work never gets a skeleton; it gets the working mark.

## Progress for long jobs

A job that knows its steps shows a 4px bar under its line, and the words carry the count: "Leggo le fonti · 12 di 37". No percentages with decimals, and no time left unless Pyxis measured it.

## Success

Success shows on the thing that did it, in a word that says it is done ("Aggiunta", "Salvato", "Copiata"), with a check. It needs no toast when the student can see the result.

## Errors

An error sits next to what failed, says what happened and how to fix it, and keeps what the student typed. Never a toast for an error the student must act on, and never "Errore" alone.

## Notices and toasts

A notice tells the student something about a screen, at the top of what it is about, in `--primary-soft` with an icon and at most one action (`Notice`). A toast is only for an action whose result is not on screen, such as a backup.
