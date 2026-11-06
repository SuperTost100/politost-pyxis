# Pyxis design system

Pyxis 0.5 uses a warm paper ground in light and a deep blue-black in dark, a teal action colour, Young Serif for titles and Figtree for everything else. The tokens, fonts, logo and icons ship with the app, so no design asset loads from the network.

- [Foundations](foundations.md): principles, copy, colour, type, spacing, radius, elevation, motion, icons and the logo.
- [Components](components.md): the shared components in `src/renderer/src/components/` and what each is for.

## Source files

| What                                       | Where                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Colour tokens read by the Ant Design theme | [`tokens/tokens.json`](../../src/renderer/src/design-system/tokens/tokens.json)     |
| CSS variables, fonts and type styles       | [`tokens/tokens.css`](../../src/renderer/src/design-system/tokens/tokens.css)       |
| Ant Design v6 theme                        | [`theme/pyxis-theme.ts`](../../src/renderer/src/design-system/theme/pyxis-theme.ts) |
| Shared components                          | [`src/renderer/src/components/`](../../src/renderer/src/components/)                |
| Fonts and their licences                   | [`fonts/README.md`](../../src/renderer/src/design-system/fonts/README.md)           |
| Logo, mark and app icons                   | [`logo/README.md`](../../src/renderer/src/design-system/logo/README.md)             |
| Icon sprite                                | [`icons/README.md`](../../src/renderer/src/design-system/icons/README.md)           |

The approved look is the 0.5 mockup. Where this folder and a screen built from the mockup disagree, the mockup wins and this folder gets updated.

## Changing the system

- Add or change a token before writing a new arbitrary value in a screen.
- `tokens.json` feeds the Ant Design theme and `tokens.css` the CSS. Change both: `tokens.test.ts` fails when they differ.
- `token-contrast.test.ts` and `link-contrast.test.ts` check selected pairs in both themes: the text tokens and links at 4.5:1 on each ground, controls and rings at 3:1, and the soft pairs they list. A new pair of text and ground needs its own line there.
- Keep visible focus, both themes and both languages. The route audit (`tests/e2e/ui-audit.spec.ts`) checks every route at 1280 and 960 pixels in Italian and English, light and dark.
- The gallery at `#/dev/gallery` shows the shared states in a development build.
