# Pyxis design system

How Pyxis looks, moves and talks: the tokens, which control fits which choice, where motion comes from, what a screen shows while Pyxis works, and the checklist every UI pull request goes through. Where this folder and the app disagree, this folder is the rule and the app is the bug.

- [Foundations](foundations.md): colour, type, spacing, corners, depth, icons, numbers and the logo.
- [Controls and buttons](controls.md): which control for which choice, the mistakes to avoid, and the button tiers and sizes.
- [Layout patterns](layout.md): page heads, settings cards, lists, the sidebar, the study bar, side panels, popovers, empty states and scroll areas.
- [Motion](motion.md): what moves, from where, for how long, and what happens with reduced motion.
- [Working, loading and feedback](feedback.md): the working mark, skeletons, progress, success, errors and notices.
- [Copy](copy.md): how Pyxis writes, in Italian and English.
- [Checklist](checklist.md): the list every UI pull request is checked against.
- [Components](components.md): the shared components in `src/renderer/src/components/` and what each is for.

Every rule here has a live example on the design system page in the private mockups repository (`pyxis-mockups`, `app/design-system.html`), where it can be tried in both themes and with reduced motion. In a development build, the gallery at `#/dev/gallery` shows the shared components in the app itself.

## Source files

| What                                            | Where                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Colour tokens read by the Ant Design theme      | [`tokens/tokens.json`](../../src/renderer/src/design-system/tokens/tokens.json)     |
| CSS variables, fonts and type styles            | [`tokens/tokens.css`](../../src/renderer/src/design-system/tokens/tokens.css)       |
| Global rules: focus, scrollbars, reduced motion | [`styles/global.css`](../../src/renderer/src/styles/global.css)                     |
| Ant Design v6 theme                             | [`theme/pyxis-theme.ts`](../../src/renderer/src/design-system/theme/pyxis-theme.ts) |
| Shared components                               | [`src/renderer/src/components/`](../../src/renderer/src/components/)                |
| Fonts and their licences                        | [`fonts/README.md`](../../src/renderer/src/design-system/fonts/README.md)           |
| Logo, mark and app icons                        | [`logo/README.md`](../../src/renderer/src/design-system/logo/README.md)             |
| Icon sprite                                     | [`icons/README.md`](../../src/renderer/src/design-system/icons/README.md)           |

## Changing the system

- Add or change a token before writing a new value by hand in a screen.
- `tokens.json` feeds the Ant Design theme and `tokens.css` the CSS. Change both: `tokens.test.ts` fails when their colours, motion or scrollbar tokens differ. It doesn't compare spacing, radii, sizes, type or shadows, so check those by hand.
- `token-contrast.test.ts` and `link-contrast.test.ts` check selected pairs in both themes: the text tokens and links at 4.5:1 on each ground, controls, rings and the scrollbar thumb on hover at 3:1, and the soft pairs they list. A new pair of text and ground needs its own line there.
- Keep visible focus, both themes and both languages. The route audit (`tests/e2e/ui-audit.spec.ts`) checks the states it lists at 1280 and 960 pixels in Italian and English, light and dark. A screen it doesn't list needs a state added there, or a look by hand.
- Fix a rule in the shared component or the token, not screen by screen.
