import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { CONFIDENCE_STOPS } from "../../../src/core/question-core.ts";
import { alpha, confidenceColors, space, useTheme } from "./theme";

/** A confidence's color on the ramp, by stop, and the middle stop's for a value between
 *  stops, as the web's rail paints it (components/confidence-rail.tsx). */
export function confidenceColor(value: number): string {
  return confidenceColors[CONFIDENCE_STOPS.indexOf(value)] ?? confidenceColors[2];
}

/** The confidence rail's paint, shared by the dock's slider and the answered card as on the
 *  web: the page background, the stop ticks, and the fill in the stop's color over them, so
 *  ticks show only past the value. */
export function RailPaint({ value, style }: { value: number; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return (
    <View pointerEvents="none" style={[{ height: 6, borderRadius: 3, borderWidth: 1, borderColor: c.border, backgroundColor: c.background, overflow: "hidden" }, style]}>
      {[30, 50, 70, 90].map((tick) => <View key={tick} style={{ position: "absolute", left: `${tick}%`, top: 0, bottom: 0, width: 1, backgroundColor: alpha(c.text, 0.35) }} />)}
      <View style={{ width: `${value}%`, height: "100%", backgroundColor: confidenceColor(value) }} />
    </View>
  );
}

/** The percentage beside a rail: at least `width` wide, and wider on one line when larger
 *  text needs it, the rail taking what is left. With `widest`, the box is always as wide as
 *  that text would be (an unseen copy holds it open), so a slider's rail keeps its width as
 *  the value changes at any text size. */
export function Percent({ value, width, style, widest }: { value: number; width: number; style: StyleProp<TextStyle>; widest?: string }) {
  const shown = { textAlign: "right", fontVariant: ["tabular-nums"] } as const;
  if (!widest) return <Text numberOfLines={1} style={[style, shown, { minWidth: width }]}>{`${value}%`}</Text>;
  return (
    <View style={{ minWidth: width }}>
      <Text numberOfLines={1} accessibilityElementsHidden importantForAccessibility="no" style={[style, shown, { opacity: 0 }]}>{widest}</Text>
      <Text numberOfLines={1} style={[style, shown, { position: "absolute", top: 0, right: 0, left: 0 }]}>{`${value}%`}</Text>
    </View>
  );
}

/** The answered quiz card's confidence, as the web's (components/answered-card.tsx): the rail
 *  with no handle, a record rather than a control, and the percentage. One screen-reader stop:
 *  nothing inside it is reachable on its own. */
export function ConfidenceRecord({ value }: { value: number }) {
  const { s } = useTheme();
  return (
    <View accessible accessibilityLabel={`Confidence ${value}%`} testID="answered-confidence"
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, marginTop: space.xs }}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flex: 1, minWidth: 0 }}>
        <RailPaint value={value} />
      </View>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Percent value={value} width={36} style={s.muted} />
      </View>
    </View>
  );
}
