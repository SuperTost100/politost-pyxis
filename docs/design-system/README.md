# Pyxis design system

The running app uses Figtree for interface text and JetBrains Mono for technical text, with a cobalt action color, mint mastery and gold position/target accents. It has dark and light token sets. Assets and fonts are bundled; screens do not fetch fonts from a third party.

## Source files

The implementation lives under `src/renderer/src/design-system/`. Tokens are in `tokens/tokens.json` and `tokens/tokens.css`; Ant Design mappings and the app shell are in `theme/`. Custom components live under `src/renderer/src/components/`, with feature-specific layouts next to their feature.

[Foundations](foundations.md) covers colors, typography, spacing and voice. [Components](components.md) describes shared controls. [Ant Design mapping](ant-design-pro.md) explains use of Ant Design v6 and Pro components without the Umi application template. The gallery at `#/dev/gallery` displays reusable states in development.

Change tokens before introducing a new arbitrary value. Mirror token changes in CSS and theme mappings. Preserve visible focus, readable contrast and English/Italian copy. The UI audit checks routes at 1280 and 960 pixels in both themes and languages; manual screenshot inspection checks composition and text wrapping.
