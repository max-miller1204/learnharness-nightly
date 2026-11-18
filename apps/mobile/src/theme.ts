import { StyleSheet, useColorScheme, type TextStyle } from "react-native";
import { resolveTheme, shiftHex, type ThemeMode } from "../../../src/core/themes.ts";

// The one source of the app's look. Colors come from the web's own theme
// presets (src/core/themes.ts): Default when the phone is dark, Ivory when it
// is light. The scales mirror app/globals.css.

/** Web type ladder (globals.css --text-*), each size with its line height. */
const size = { xs: 11, sm: 12.5, base: 14, lg: 16, xl: 20, "2xl": 25, "3xl": 32 } as const;
const leading = (key: keyof typeof size, ratio: number) => ({ fontSize: size[key], lineHeight: Math.round(size[key] * ratio) });

/** Tailwind's 4px rhythm. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/** Web radii ladder plus the composer buttons' 10px corner. */
export const radius = { sm: 4, md: 8, control: 10, lg: 12, xl: 16 } as const;

/** Chrome is JetBrains Mono, prose is Source Sans 3, titles are CMU Serif bold. */
export const fonts = {
  ui: "JetBrainsMono_400Regular",
  uiMedium: "JetBrainsMono_500Medium",
  prose: "SourceSans3_400Regular",
  proseItalic: "SourceSans3_400Regular_Italic",
  proseBold: "SourceSans3_700Bold",
  proseBoldItalic: "SourceSans3_700Bold_Italic",
  proseBlack: "SourceSans3_900Black",
  title: "lh-cmu",
} as const;

function alpha(hex: string, amount: number) {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${amount})`;
}

/** color-mix(in srgb, color, black amount): the web's darker code well. */
function darken(hex: string, amount: number) {
  return shiftHex(hex, 0).replace(/[0-9a-f]{2}/g, (channel) =>
    Math.round(parseInt(channel, 16) * (1 - amount)).toString(16).padStart(2, "0"));
}

function palette(mode: ThemeMode) {
  const { colors: c } = resolveTheme(mode === "dark" ? "default" : "ivory");
  return {
    mode,
    background: c.background,
    card: c.surface,
    // The shadcn hover surface (themeVars --accent): one step off the card.
    hover: shiftHex(c.surface, mode === "dark" ? 14 : -14),
    border: c.border,
    text: c.text,
    muted: c.textMuted,
    rail: alpha(c.textMuted, 0.3),
    primary: c.text,
    onPrimary: c.background,
    input: mode === "dark" ? alpha(c.border, 0.3) : "transparent",
    well: darken(c.background, mode === "dark" ? 0.14 : 0.04),
    accent: c.accent,
    strong: c.bold,
    italic: c.italic,
    code: c.code,
    error: c.error,
    errorTint: alpha(c.error, 0.1),
    errorBorder: alpha(c.error, 0.5),
    success: c.success,
  };
}

export type Palette = ReturnType<typeof palette>;

/** The web confidence ramp (components/confidence-rail.tsx): 0 red to 100 emerald, by stop. */
export const confidenceColors = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e", "#10b981"] as const;

export { alpha };

function sheet(c: Palette) {
  const label: TextStyle = { fontFamily: fonts.uiMedium, ...leading("xs", 1.4), letterSpacing: 0.3, textTransform: "uppercase", color: c.muted };
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: c.background },
    section: { padding: space.lg, gap: space.md },
    row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm },
    // TopBar: 60px band, hairline bottom border, 12px gutters.
    bar: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    title: { fontFamily: fonts.title, ...leading("2xl", 1.3), color: c.text },
    heading: { fontFamily: fonts.uiMedium, ...leading("lg", 1.45), color: c.text },
    prose: { fontFamily: fonts.prose, ...leading("lg", 1.5), color: c.text },
    ui: { fontFamily: fonts.ui, ...leading("sm", 1.4), color: c.text },
    muted: { fontFamily: fonts.ui, ...leading("sm", 1.4), color: c.muted },
    meta: { fontFamily: fonts.ui, ...leading("xs", 1.4), color: c.muted },
    label,
    error: { fontFamily: fonts.ui, ...leading("sm", 1.4), color: c.error },
    errorBox: { borderWidth: 1, borderColor: c.errorBorder, backgroundColor: c.errorTint, borderRadius: radius.md, borderCurve: "continuous", paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.sm },
    card: { padding: space.lg, gap: space.sm, borderRadius: radius.lg, borderCurve: "continuous", borderWidth: 1, borderColor: c.border, backgroundColor: c.card },
    // The learner's band: card fill, a muted left rail, the YOU label inside.
    band: { borderLeftWidth: 6, borderLeftColor: c.rail, backgroundColor: c.card, paddingVertical: space.xs, paddingLeft: 14, paddingRight: space.lg, gap: 2 },
    input: { minHeight: 40, backgroundColor: c.input, color: c.text, borderRadius: radius.md, borderCurve: "continuous", borderColor: c.border, borderWidth: 1, paddingHorizontal: space.md, paddingVertical: space.sm, fontFamily: fonts.prose, fontSize: size.lg, lineHeight: 20 },
    // The composer shell: rounded-2xl, border, card fill, shadow-lg.
    dock: { borderRadius: radius.xl, borderCurve: "continuous", borderWidth: 1, borderColor: c.border, backgroundColor: c.card, boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)" },
    divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border },
    well: { fontFamily: fonts.ui, fontSize: size.sm, color: c.code, backgroundColor: c.well },
  });
}

const themes = { dark: { c: palette("dark"), s: sheet(palette("dark")) }, light: { c: palette("light"), s: sheet(palette("light")) } };

/** The phone's light/dark setting picks the palette; unknown reads as the web's dark default. */
export function useTheme() {
  return themes[useColorScheme() === "light" ? "light" : "dark"];
}

export const fontFiles = {
  [fonts.ui]: require("@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf"),
  [fonts.uiMedium]: require("@expo-google-fonts/jetbrains-mono/500Medium/JetBrainsMono_500Medium.ttf"),
  [fonts.prose]: require("@expo-google-fonts/source-sans-3/400Regular/SourceSans3_400Regular.ttf"),
  [fonts.proseItalic]: require("@expo-google-fonts/source-sans-3/400Regular_Italic/SourceSans3_400Regular_Italic.ttf"),
  [fonts.proseBold]: require("@expo-google-fonts/source-sans-3/700Bold/SourceSans3_700Bold.ttf"),
  [fonts.proseBoldItalic]: require("@expo-google-fonts/source-sans-3/700Bold_Italic/SourceSans3_700Bold_Italic.ttf"),
  [fonts.proseBlack]: require("@expo-google-fonts/source-sans-3/900Black/SourceSans3_900Black.ttf"),
  [fonts.title]: require("../../../public/fonts/cmunbx.ttf"),
};
