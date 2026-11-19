import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { hasMath, plainText, splitLabel } from "./choice-math";
import { spokenLabel } from "./math-speech";
import { MathLabel, useSpeech } from "./MathLabel";
import { radius, space, useTheme } from "./theme";

/** The web dock's option row: a radio dot or check box, then the label, with its math
 * drawn. The row is one screen-reader stop that reads the whole label, math spoken.
 * `math: false` keeps the label plain (the constant "Other"). */
export function ChoiceRow({ label, math = true, multi, selected, disabled, onPress }: {
  label: string; math?: boolean; multi: boolean; selected: boolean; disabled: boolean; onPress: () => void;
}) {
  const { c, s } = useTheme();
  const pieces = useMemo(() => math ? splitLabel(label) : plainText(label), [label, math]);
  const drawn = hasMath(pieces);
  const speech = useSpeech(drawn);
  const spoken = useMemo(() => drawn ? spokenLabel(pieces, speech) : label, [drawn, pieces, speech, label]);
  const textStyle = [s.prose, { fontSize: 14, lineHeight: 20 }];
  return (
    <Pressable accessibilityRole={multi ? "checkbox" : "radio"} accessibilityLabel={spoken}
      accessibilityState={{ disabled, checked: selected }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingHorizontal: space.md, paddingVertical: space.sm,
        borderRadius: radius.md, borderCurve: "continuous", borderWidth: 1, borderColor: selected ? c.primary : c.border,
        backgroundColor: selected || pressed ? c.hover : "transparent", opacity: disabled ? 0.5 : 1,
      })}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{
        marginTop: 3, width: 16, height: 16, alignItems: "center", justifyContent: "center", borderWidth: 1,
        borderRadius: multi ? radius.sm : 8, borderColor: selected ? c.primary : c.rail, backgroundColor: selected ? c.primary : "transparent",
      }}>
        {selected && (multi ? <Text style={{ color: c.onPrimary, fontSize: 12, lineHeight: 14 }}>✓</Text>
          : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.onPrimary }} />)}
      </View>
      {drawn ? <MathLabel pieces={pieces} style={textStyle} color={c.text} />
        : <Text accessibilityElementsHidden importantForAccessibility="no" style={[textStyle, { flex: 1 }]}>{label}</Text>}
    </Pressable>
  );
}
