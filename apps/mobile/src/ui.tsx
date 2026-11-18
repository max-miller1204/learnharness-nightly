import type { ReactNode } from "react";
import { Pressable, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";
import { fonts, radius, space, useTheme } from "./theme";

type Variant = "primary" | "outline" | "ghost" | "success";

/** The web Button: primary is light-on-dark, outline is the bordered default. */
export function Button({ children, onPress, disabled, primary, selected, variant, label, style }: {
  children: ReactNode; onPress: () => void; disabled?: boolean; primary?: boolean; selected?: boolean;
  variant?: Variant; label?: string; style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  const kind: Variant = primary || selected ? "primary" : variant ?? "outline";
  const fill = { primary: c.primary, outline: c.input, ghost: "transparent", success: c.success }[kind];
  const ink = kind === "primary" || kind === "success" ? c.onPrimary : c.text;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [{
        minHeight: 40, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: space.sm,
        paddingHorizontal: space.lg, borderRadius: radius.md, borderCurve: "continuous", backgroundColor: fill,
        borderWidth: kind === "outline" ? 1 : 0, borderColor: c.border,
        opacity: disabled ? 0.5 : pressed && (kind === "primary" || kind === "success") ? 0.9 : 1,
      }, pressed && (kind === "outline" || kind === "ghost") && { backgroundColor: c.hover }, style]}>
      {typeof children === "string"
        ? <Text style={{ fontFamily: fonts.uiMedium, fontSize: 12.5, color: ink }}>{children}</Text>
        : children}
    </Pressable>
  );
}

/** The web's quiet uppercase label (YOU, PROBLEM, SESSIONS…). */
export function Label({ children }: { children: ReactNode }) {
  const { s } = useTheme();
  return <Text style={s.label}>{children}</Text>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const { c, s } = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <Label>{label}</Label>
      <TextInput accessibilityLabel={label} placeholderTextColor={c.muted} selectionColor={c.accent} {...props}
        style={[s.input, props.multiline && { minHeight: 72, textAlignVertical: "top" }, props.style]} />
    </View>
  );
}

export function Notice({ children, boxed }: { children: ReactNode; boxed?: boolean }) {
  const { s } = useTheme();
  if (!children) return null;
  const text = <Text selectable accessibilityRole="alert" accessibilityLiveRegion="polite" style={s.error}>{children}</Text>;
  return boxed ? <View style={s.errorBox}>{text}</View> : text;
}
