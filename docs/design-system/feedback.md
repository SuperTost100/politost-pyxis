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

A list or a page that loads from this computer shows a skeleton in its final layout, so nothing jumps when it arrives. It appears only after 150ms, so a fast load never flashes it. AI work never gets a skeleton; it gets the working mark. A lesson part being written, and the page of a gap whose drill is being written, are the places with shapes under the working mark: still lines where the text will be, which never pulse, so the sheet keeps the shape of a page while the student waits.

## Progress for long jobs

A job that knows its steps shows a 4px bar under its line, and the words carry the count: "Leggo le fonti · 12 di 37". No percentages with decimals, and no time left unless Pyxis measured it.

## Success

Success shows on the thing that did it, in a word that says it is done ("Aggiunta", "Salvato", "Copiata"), with a check. It needs no toast when the student can see the result.

## Errors

An error sits next to what failed, says what happened and how to fix it, and keeps what the student typed. Never a toast for an error the student must act on, and never "Errore" alone.

## Notices and toasts

A notice tells the student something about a screen, at the top of what it is about, with an icon and at most one action (`Notice`). Its tone follows what the message means, never how much room it needs:

| Tone      | Ground                 | Means                                                                                          |
| --------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `info`    | `--primary-soft`, teal | Something to know, nothing wrong: a build the student stopped, an update, an archived exam     |
| `warning` | `--star-soft`, amber   | Something needs a choice or a step first, or a result is partial: no AI tool yet, a folder cut |
| `danger`  | `--danger-soft`, red   | Something failed or was refused, and the student can retry or fix it: a build that did not end |

The same event has the same tone everywhere: a failed build is red on a map, on flashcards and on a quiz, and one the student stopped is teal. A failure is never amber or teal, and a message that only asks for a step is never red.

A toast is only for an action whose result is not on screen, such as a backup.
