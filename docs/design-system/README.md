# PoliTost Pyxis — design system

Status: v1, 29 Sep 2026. The live version, with previews and comments, is the "PoliTost Pyxis" Design System artifact on claude.ai. This folder is the offline, code-ready copy.

Pyxis follows Astra's calm dark study space (near-black canvas, one centred column, pill controls, uppercase mono labels) with its own identity: cobalt for the next step, star gold for position and target, aurora mint for mastery. The logo is **star trails** around the pole star.

## Stack

- Electron + Vite + React, **antd v6** + **Ant Design Pro components** (`@ant-design/pro-components` v3, antd-6 line, beta 3.1.15: pin it).
- Not the Umi-based Ant Design Pro template. See `docs/ant-design-pro.md` for the difference and the component mapping.
- Fonts: Figtree + JetBrains Mono, bundled. Icons: `lucide-react`.

## Folders

| Folder | What |
| --- | --- |
| `docs/` | `foundations.md` (colour, type, spacing, logo, voice, rules), `components.md` (every custom component), `ant-design-pro.md` (antd / Pro mapping) |
| `tokens/` | `tokens.json` (source of truth), `tokens.css` (CSS variables for both themes + type classes) |
| `theme/` | `pyxis-theme.ts` (antd v6 theme + ProLayout token), `AppShell.tsx` (top-header ProLayout shell) |
| `fonts/` | Variable woff2 files, OFL |
| `icons/` | Lucide sprite of the icons the design uses |
| `logo/` | Mark (dark, light, mono), lockups, app icon SVG + PNG 16–1024 |
| `reference/` | `index.html` (every custom component, dark and light, opens offline), `bundle.css`, `bundle.js`, `index.d.ts` |

## Quick start

```bash
npm i antd@^6 @ant-design/pro-components@3.1.15-3 lucide-react
```

```tsx
import './design-system/tokens/tokens.css';
import { AppShell } from './design-system/theme/AppShell';
<AppShell mode="dark" lang="it" door="exams" onDoor={setDoor} onSettings={openSettings}>…</AppShell>
```

`theme/*.ts` type-checks against antd 6.6.5 and pro-components 3.1.15-3. `reference/bundle.js` is the preview build of the custom components, not production code: rebuild them as TSX in the app using `bundle.css` and `docs/components.md` as the spec.

## Change rules

Change a value in `tokens/tokens.json` first, then mirror it in `tokens.css` and `theme/pyxis-theme.ts`. Keep every text pair at 4.5:1 in both themes.
