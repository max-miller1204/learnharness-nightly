import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";

export const colors = {
  background: "#f8f6f0",
  surface: "#ffffff",
  ink: "#171d18",
  muted: "#4a564e",
  border: "#c5cec4",
  accent: "#204d3d",
  accentLight: "#e3eee6",
  danger: "#982c20",
};

export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  section: { padding: 18, gap: 12 },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  header: { padding: 16, gap: 8, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 24, fontWeight: "700", color: colors.ink },
  subtitle: { fontSize: 17, fontWeight: "600", color: colors.ink },
  text: { fontSize: 16, color: colors.ink },
  muted: { fontSize: 15, color: colors.muted },
  error: { fontSize: 15, color: colors.danger },
  card: { padding: 12, gap: 8, borderRadius: 10, borderColor: colors.border, borderWidth: 1, backgroundColor: colors.surface },
  input: { minHeight: 48, backgroundColor: colors.surface, color: colors.ink, borderRadius: 8, borderColor: colors.border, borderWidth: 1, padding: 10, fontSize: 16 },
  button: { minHeight: 44, justifyContent: "center", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.accentLight },
  primary: { backgroundColor: colors.accent },
  buttonText: { color: colors.accent, fontSize: 15, fontWeight: "600" },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
});

export function Button({ children, onPress, disabled, primary, selected }: {
  children: string; onPress: () => void; disabled?: boolean; primary?: boolean; selected?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, (primary || selected) && styles.primary, (disabled || pressed) && { opacity: 0.55 }]}>
      <Text style={[styles.buttonText, (primary || selected) && { color: "#ffffff" }]}>{children}</Text>
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={styles.muted}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.muted} {...props}
        style={[styles.input, props.multiline && { minHeight: 72, textAlignVertical: "top" }, props.style]} />
    </View>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{children}</Text>;
}
