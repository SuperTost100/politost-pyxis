// PoliTost Pyxis — Ant Design v6 theme. The colours come from tokens.json.
// Usage:
//   import { ConfigProvider, App as AntApp } from 'antd';
//   import { pyxisTheme } from './pyxis-theme';
//   <ConfigProvider theme={pyxisTheme(mode)}><AntApp>…</AntApp></ConfigProvider>
import { theme, type ThemeConfig } from "antd";
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

const DANGER_STATES: Record<PyxisMode, { hover: string; active: string }> = {
  dark: { hover: "#e8918e", active: "#c65c5c" },
  light: { hover: "#c74a4f", active: "#99222c" },
};

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
      // The solid danger button paints its hover and active states with these. Ant Design derives them from the seed,
      // and the derived light hover and dark active fills are too faint or too dark under the label (see
      // danger-contrast.test.ts). The other two are the derived values, pinned so the three states stay a set.
      colorErrorHover: DANGER_STATES[mode].hover,
      colorErrorActive: DANGER_STATES[mode].active,
      colorInfo: c.primary,
      colorLink: c.primaryText,
      // Ant Design derives these from colorLink, and its dark algorithm takes them under 4.5:1 on the cards
      // (link-contrast.test.ts). A hovered link turns to the text colour; a pressed one keeps the link colour.
      colorLinkHover: c.ink,
      colorLinkActive: c.primaryText,
      fontFamily: FONT_SANS,
      fontFamilyCode: FONT_MONO,
      fontSize: 15 * textScale,
      // 0.5 shapes (design-spec.md): 10 px buttons and fields, 8 px rows, 14 px cards, 16 px panels. No pills.
      borderRadius: 10,
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
      borderRadiusLG: 14,
      controlHeightSM: 32,
      controlHeightLG: 48,
      lineWidthFocus: 2,
      // antd draws its keyboard focus outline in this colour; one ring for every control, as in global.css.
      colorPrimaryBorder: c.focusRing,
      boxShadowSecondary:
        mode === "dark"
          ? "0 0 0 1px rgba(255, 255, 255, 0.06), 0 22px 48px -12px rgba(0, 0, 0, 0.85)"
          : "0 4px 10px rgba(21, 24, 30, 0.08), 0 22px 44px -14px rgba(21, 24, 30, 0.3)",
    },
    components: {
      Button: {
        borderRadius: 10,
        borderRadiusSM: 8,
        borderRadiusLG: 10,
        fontWeight: 600,
        primaryShadow: "none",
        defaultShadow: "none",
        dangerShadow: "none",
        // The solid danger fill is the light red in the dark theme, where white text fails contrast; onInk is the
        // text colour that sits on a bright fill in each theme.
        dangerColor: c.onInk,
        paddingInline: 20,
        paddingInlineLG: 32,
        // Secondary buttons are a soft fill with no outline (design-spec.md, Buttons).
        defaultBorderColor: "transparent",
        defaultBg: c.surfaceRaised,
        defaultColor: c.ink,
        defaultHoverBg: c.border,
        defaultHoverColor: c.ink,
        defaultHoverBorderColor: "transparent",
        defaultActiveBg: c.border,
        defaultActiveColor: c.ink,
        defaultActiveBorderColor: "transparent",
      },
      Segmented: {
        borderRadius: 10,
        borderRadiusSM: 8,
        trackBg: c.surfaceRaised,
        trackPadding: 4,
        itemColor: c.inkMuted,
        itemHoverColor: c.ink,
        itemHoverBg: "transparent",
        itemSelectedBg: c.surface,
        itemSelectedColor: c.ink,
        fontFamily: FONT_SANS,
        fontSize: 14 * textScale,
      },
      Input: {
        borderRadius: 10,
        activeBorderColor: c.primaryText,
        hoverBorderColor: c.inkMuted,
        activeShadow: "none",
        paddingInline: 16,
      },
      InputNumber: {
        borderRadius: 10,
        activeBorderColor: c.primaryText,
        hoverBorderColor: c.inkMuted,
        activeShadow: "none",
      },
      Select: {
        borderRadius: 10,
        activeBorderColor: c.primaryText,
        hoverBorderColor: c.inkMuted,
        activeOutlineColor: "transparent",
        optionSelectedBg: c.primarySoft,
      },
      Card: {
        borderRadiusLG: 14,
        colorBgContainer: c.surface,
        colorBorderSecondary: c.border,
        headerFontSize: 17,
        bodyPadding: 24,
      },
      Modal: {
        borderRadiusLG: 16,
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
        fontFamily: FONT_SANS,
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
        itemBorderRadius: 8,
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
