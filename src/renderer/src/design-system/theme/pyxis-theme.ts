// PoliTost Pyxis — Ant Design v6 + Ant Design Pro (ProComponents v3) theme. The colours come from tokens.json.
// Usage:
//   import { ConfigProvider, App as AntApp } from 'antd';
//   import { pyxisTheme } from './pyxis-theme';
//   <ConfigProvider theme={pyxisTheme(mode)}><AntApp>…</AntApp></ConfigProvider>
import { theme, type ThemeConfig } from "antd";
import type { ProTokenType } from "@ant-design/pro-components";
import { color } from "../tokens/tokens.json";

export type PyxisMode = "dark" | "light";

// The colours Ant Design takes from tokens.json, the one place their values are set.
const COLOR_NAMES = [
  "bg",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "border",
  "borderControl",
  "ink",
  "inkMuted",
  "inkSubtle",
  "onInk",
  "primary",
  "primaryHover",
  "primaryActive",
  "primaryText",
  "primarySoft",
  "star",
  "starText",
  "starSoft",
  "mastery",
  "masteryText",
  "masterySoft",
  "danger",
  "dangerSoft",
  "focusRing",
  "scrim",
] as const;

function readColors(mode: PyxisMode): Record<(typeof COLOR_NAMES)[number], string> {
  const values = new Map(color.tokens.map((token) => [token.name, token.value[mode]]));
  return Object.fromEntries(
    COLOR_NAMES.map((name) => {
      // tokens.json names colours in kebab case: surfaceRaised is surface-raised.
      const key = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      const value = values.get(key);
      if (!value) throw new Error(`tokens.json has no ${mode} colour ${key}`);
      return [name, value];
    }),
  ) as Record<(typeof COLOR_NAMES)[number], string>;
}

export const pyxisColors = { dark: readColors("dark"), light: readColors("light") };

const FONT_SANS = 'Figtree, system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_MONO =
  '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export function pyxisTheme(
  mode: PyxisMode = "dark",
  reducedMotion = false,
  textScale = 1,
): ThemeConfig {
  const c = pyxisColors[mode];
  return {
    algorithm: mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
    cssVar: { prefix: "px" },
    hashed: false,
    token: {
      // seed
      motion: !reducedMotion,
      colorPrimary: c.primary,
      colorSuccess: c.mastery,
      colorWarning: c.star,
      colorError: c.danger,
      colorInfo: c.primary,
      colorLink: c.primaryText,
      fontFamily: FONT_SANS,
      fontFamilyCode: FONT_MONO,
      fontSize: 15 * textScale,
      borderRadius: 12,
      controlHeight: 40,
      wireframe: false,
      motionDurationMid: "0.15s",
      // map / alias overrides so the algorithm does not drift from our tokens
      colorBgBase: c.bg,
      colorBgLayout: c.bg,
      colorBgContainer: c.surface,
      colorBgElevated: c.surfaceOverlay,
      colorFillSecondary: c.surfaceRaised,
      colorFillTertiary: c.surfaceRaised,
      colorBgMask: c.scrim,
      colorTextBase: c.ink,
      colorText: c.ink,
      colorTextSecondary: c.inkMuted,
      colorTextTertiary: c.inkSubtle,
      colorTextPlaceholder: c.inkSubtle,
      colorBorder: c.borderControl,
      colorBorderSecondary: c.border,
      colorSplit: c.border,
      colorPrimaryBg: c.primarySoft,
      colorPrimaryHover: c.primaryHover,
      colorPrimaryActive: c.primaryActive,
      colorSuccessBg: c.masterySoft,
      colorSuccessText: c.masteryText,
      colorWarningBg: c.starSoft,
      colorWarningText: c.starText,
      colorErrorBg: c.dangerSoft,
      colorErrorText: c.danger,
      borderRadiusSM: 8,
      borderRadiusLG: 16,
      controlHeightSM: 32,
      controlHeightLG: 48,
      lineWidthFocus: 2,
      // antd draws its keyboard focus outline in this colour; one ring for every control, as in global.css.
      colorPrimaryBorder: c.focusRing,
      boxShadowSecondary:
        mode === "dark"
          ? "0 16px 40px rgba(0, 0, 0, 0.55)"
          : "0 12px 32px rgba(21, 24, 30, 0.14)",
    },
    components: {
      Button: {
        borderRadius: 999,
        borderRadiusSM: 999,
        borderRadiusLG: 999,
        fontWeight: 600,
        primaryShadow: "none",
        defaultShadow: "none",
        dangerShadow: "none",
        paddingInline: 20,
        paddingInlineLG: 32,
        defaultBorderColor: c.borderControl,
        defaultBg: "transparent",
        defaultHoverColor: c.primaryText,
        defaultHoverBorderColor: c.primaryText,
        defaultActiveColor: c.primaryText,
        defaultActiveBorderColor: c.primaryText,
      },
      Segmented: {
        borderRadius: 999,
        borderRadiusSM: 999,
        trackBg: c.surface,
        trackPadding: 4,
        itemColor: c.inkMuted,
        itemHoverColor: c.ink,
        itemHoverBg: "transparent",
        itemSelectedBg: c.ink,
        itemSelectedColor: c.onInk,
        fontFamily: FONT_MONO,
        fontSize: 12 * textScale,
      },
      Input: {
        borderRadius: 999,
        activeBorderColor: c.primaryText,
        hoverBorderColor: c.inkMuted,
        activeShadow: "none",
        paddingInline: 16,
      },
      InputNumber: {
        borderRadius: 999,
        activeBorderColor: c.primaryText,
        hoverBorderColor: c.inkMuted,
        activeShadow: "none",
      },
      Select: {
        borderRadius: 999,
        activeBorderColor: c.primaryText,
        hoverBorderColor: c.inkMuted,
        activeOutlineColor: "transparent",
        optionSelectedBg: c.primarySoft,
      },
      Card: {
        borderRadiusLG: 16,
        colorBgContainer: c.surface,
        colorBorderSecondary: c.border,
        headerFontSize: 17,
        bodyPadding: 24,
      },
      Modal: {
        borderRadiusLG: 24,
        contentBg: c.surfaceOverlay,
        headerBg: c.surfaceOverlay,
        titleFontSize: 22,
      },
      Progress: {
        defaultColor: c.mastery,
        remainingColor: c.surfaceRaised,
        lineBorderRadius: 999,
      },
      Tag: {
        borderRadiusSM: 8,
        defaultBg: c.surfaceRaised,
        defaultColor: c.inkMuted,
        fontFamily: FONT_MONO,
      },
      Tabs: {
        itemColor: c.inkMuted,
        itemSelectedColor: c.ink,
        inkBarColor: c.primary,
        titleFontSize: 15,
      },
      Dropdown: { colorError: c.danger },
      Menu: {
        itemBg: "transparent",
        itemSelectedBg: c.primarySoft,
        itemSelectedColor: c.primaryText,
        itemBorderRadius: 12,
        dangerItemColor: c.danger,
        dangerItemHoverColor: c.danger,
      },
      Tooltip: {
        colorBgSpotlight: c.surfaceOverlay,
        colorTextLightSolid: c.ink,
      },
      Switch: { colorPrimary: c.primary, colorPrimaryHover: c.primaryHover },
      Slider: {
        trackBg: c.primary,
        trackHoverBg: c.primaryHover,
        handleColor: c.primary,
        railBg: c.surfaceRaised,
        dotActiveBorderColor: c.primary,
      },
      Tree: {
        nodeSelectedBg: c.primarySoft,
        directoryNodeSelectedBg: c.primarySoft,
        titleHeight: 32,
      },
      Table: {
        headerBg: c.surface,
        rowHoverBg: c.surfaceRaised,
        borderColor: c.border,
        headerColor: c.inkMuted,
      },
    },
  };
}

// ── Ant Design Pro (ProComponents v3) ───────────────────────────────────────
// ProLayout reads its own `token` prop; the rest of ProComponents (ProForm, StepsForm,
// ProList, ProTable, ProCard) inherit the antd theme above through ConfigProvider.

export function pyxisProLayoutToken(
  mode: PyxisMode = "dark",
): ProTokenType["layout"] {
  const c = pyxisColors[mode];
  return {
    bgLayout: c.bg,
    colorPrimary: c.primary,
    header: {
      colorBgHeader: c.bg,
      colorBgScrollHeader: c.bg,
      colorHeaderTitle: c.ink,
      colorTextMenu: c.inkMuted,
      colorTextMenuSecondary: c.inkMuted,
      colorTextMenuSelected: c.onInk,
      colorTextMenuActive: c.ink,
      colorBgMenuItemHover: c.surfaceRaised,
      colorBgMenuItemSelected: c.ink,
      colorBgMenuElevated: c.surfaceOverlay,
      colorTextRightActionsItem: c.inkMuted,
      colorBgRightActionsItemHover: c.surfaceRaised,
      heightLayoutHeader: 64,
    },
    pageContainer: {
      colorBgPageContainer: c.bg,
      colorBgPageContainerFixed: c.bg,
      paddingInlinePageContainerContent: 24,
      paddingBlockPageContainerContent: 48,
    },
  };
}
