# Ant Design Pro mapping

Pyxis is built on **Ant Design Pro**: antd v6 plus **ProComponents v3** (`@ant-design/pro-components`, the antd-6 line; still tagged beta at 3.1.15, pin the exact version). Pro is used as a component layer inside the Electron + Vite app, not as the Umi-based admin template.

## Plain antd vs Pro

- **antd** is the component library: Button, Input, Segmented, Modal, Tree, Table.
- **ProComponents** are higher-level blocks built on antd: ProLayout (app shell), ProForm and StepsForm (forms and wizards with validation and layout built in), ProList and ProTable (data lists with search, filters and actions), ProCard, ProDescriptions.
- **Ant Design Pro** (the repo) is a full web-app template (Umi Max, routing, login, mock server, Tailwind). Pyxis does not use it: it is built for admin websites with accounts and a server, and Pyxis has neither.

## Setup

```tsx
<ConfigProvider theme={pyxisTheme(mode)} locale={lang === 'it' ? itIT : enUS}>
  <ProConfigProvider dark={mode === 'dark'} hashed={false}>
    <App>
      <ProLayout layout="top" contentWidth="Fixed" token={pyxisProLayoutToken(mode)} menuRender={false} … />
    </App>
  </ProConfigProvider>
</ConfigProvider>
```

- `antd/pyxis-theme.ts`: `pyxisTheme(mode)` themes antd and every ProComponent; `pyxisProLayoutToken(mode)` themes ProLayout's header and page container.
- `antd/AppShell.tsx`: the working shell (type-checked against antd 6.6.5 and pro-components 3.1.15-3).
- `cssVar` with prefix `px` and `hashed: false`: antd emits `--px-*` variables beside the design-system variables. Set `<html data-theme>` on the same switch so custom components follow.
- Once stable, switch antd to v6 zero-runtime mode for faster start-up in Electron.
- Icons: `lucide-react`, passed into antd/Pro `icon` props. Do not mix in `@ant-design/icons`.
- Locales: antd `it_IT` / `en_US`; ProComponents pick theirs up from the antd locale.

## Which component for what

| Pyxis need | Use | Notes |
| --- | --- | --- |
| App shell | `ProLayout` `layout="top"`, `contentWidth="Fixed"`, `menuRender={false}` | Doors as a centred `Segmented` in `headerContentRender`, settings in `actionsRender` |
| Page frame | `PageContainer` with `header={{ title: false }}` | Max width 768px, `space-12` top padding |
| New plan wizard (PLAN-01…07) | `StepsForm` inside a full-screen `Modal` | One question per step, progress bar on top |
| Plan settings, profile, engine form | `ProForm` + `ProFormText`, `ProFormSelect`, `ProFormSlider`, `ProFormDatePicker` | Validation and layout built in |
| Plan list (PLAN-30/31) | `ProList` with `metas` or a grid of `PlanCard` | Search and subject filter in the toolbar |
| Sources library (SRC-10…13) | `ProTable` | Type, size, sections, status columns; row actions rename, replace, re-extract |
| Simulations history (PRO-05) | `ProTable` (read-only) | Date, score, duration |
| Engines (ENG-10) | `ProList` rendering `EngineRow` | |
| Topic tree (PLAN-12) | antd `Tree` `draggable` | Pro has no tree |
| Info panels | `ProCard` (`bordered`, `split`) | Stat tiles stay custom (`StatTile`) |
| Confirmations, toasts | `App.useApp()` `modal.confirm`, `message` | |
| Charts | `@ant-design/charts` or plain SVG | Line in `primary`, target dashed in `border-control` |
| Chat | `@ant-design/x` `Bubble` / `Sender`, or the custom `ChatMessage` / `Composer` | |

## Rules

- Nothing should look like stock antd or stock Pro: if you see the default blue, the admin sidebar or grey Pro headers, a token is missing.
- No sidebar layout, no breadcrumbs, no page titles in the Pro header: titles live in the page body (`title-1`).
- Never set colours inline. Use `theme.useToken()` in antd code and `var(--token)` in custom CSS.
