import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { CONFIDENCE_STOPS } from "../../../src/core/question-core.ts";
import { alpha, confidenceColors, space, useTheme } from "./theme";

/** The confidence rail's paint, shared by the dock's slider and the answered card as on the
 *  web (components/confidence-rail.tsx): the page background, the stop ticks, and the fill in
 *  the stop's color over them, so ticks show only past the value. */
export function RailPaint({ value, style }: { value: number; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  const color = confidenceColors[CONFIDENCE_STOPS.indexOf(value)] ?? confidenceColors[2];
  return (
    <View pointerEvents="none" style={[{ height: 6, borderRadius: 3, borderWidth: 1, borderColor: c.border, backgroundColor: c.background, overflow: "hidden" }, style]}>
      {[30, 50, 70, 90].map((tick) => <View key={tick} style={{ position: "absolute", left: `${tick}%`, top: 0, bottom: 0, width: 1, backgroundColor: alpha(c.text, 0.35) }} />)}
      <View style={{ width: `${value}%`, height: "100%", backgroundColor: color }} />
    </View>
  );
}

/** The answered quiz card's confidence, as the web's (components/answered-card.tsx): the rail
 *  with no handle, a record rather than a control, and the percentage. One screen-reader stop. */
export function ConfidenceRecord({ value }: { value: number }) {
  const { s } = useTheme();
  return (
    <View accessible accessibilityLabel={`Confidence ${value}%`} testID="answered-confidence"
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, marginTop: space.xs }}>
      <RailPaint value={value} style={{ flex: 1, minWidth: 0 }} />
      <Text style={[s.muted, { width: 36, textAlign: "right", fontVariant: ["tabular-nums"] }]}>{`${value}%`}</Text>
    </View>
  );
}
