Describe the problem and the resulting behavior.

## Validation

List the checks run and any platform checks still pending. Include fixture screenshots for UI changes, using both themes and languages where affected.

## UI checklist

For a change to the interface, tick each line against the screenshots, or explain the ones that don't hold. Delete this section when the pull request changes no UI. The rules behind each line are in [the design system](../docs/design-system/README.md).

### Structure

- [ ] One primary button in the view, and its label starts with a verb.
- [ ] The main thing on the screen is the largest, and each element appears once.
- [ ] Groups are made with space first; no card inside a card, no box around everything.
- [ ] Each choice uses its control from the control table.
- [ ] A page opened from another has one back control at its top left, named by its place (`usePlace`, `BackControl`).
- [ ] Every dialog is `Dialog` or a `useConfirm` question, and leaving with unsaved work asks through `useLeaveGuard`.
- [ ] The examples show real study content (Fisica I, «Moto nel piano»), never placeholder text.

### Type, colour and shape

- [ ] Titles in Young Serif, everything else in Figtree; italics only for maths; mono only for raw input and paths.
- [ ] Headings say what is there and wrap with `text-wrap: balance`.
- [ ] Text at 4.5:1, control edges, focus and rings at 3:1, in both themes; state is never colour alone.
- [ ] One accent; the ring colours only on the rings.
- [ ] Counts, scores and times use tabular figures.
- [ ] Nested corners follow inner = outer − padding; no pills except the round controls.
- [ ] Lucide icons only, at 1.75, one per idea; no emoji, badges, gradients, glows or coloured side borders.
- [ ] Aligned by eye: icons in buttons, numbers in columns, the first letter of a title with the text under it.

### States and motion

- [ ] Empty, loading, error and working states are drawn, and background work shows the working mark where its result will appear.
- [ ] Errors sit next to what failed and give the fix.
- [ ] Motion starts from what caused it, follows the motion table and has its reduced-motion fallback; nothing animates on typing or frequent actions.
- [ ] Every scroll area uses the app's thin scrollbar.

### Words

- [ ] Sentence case, plain words, no redundant labels, no dashes as punctuation.
- [ ] Italian and English both updated, and the layout holds the Italian.

### Proof

- [ ] Screenshots at 1280 and 960, light and dark, Italian and English, read before merging. The route audit covers the states it lists; anything else gets a look by hand.
- [ ] Keyboard: every control reachable, focus visible, Escape closes and focus goes back to the trigger.
