import { useEffect, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions, type StyleProp, type TextStyle } from "react-native";
import { SvgXml } from "react-native-svg";
import type { DrawnMath, LabelPiece } from "./choice-math";
import { speechReady, startSpeech } from "./math-speech";

/** The web draws math with KaTeX at 1.21em; MathJax's TeX fonts share its metrics. */
const MATH_SCALE = 1.21;

/** Whether spoken math is ready. Starts the speech engine only when `enabled`
 * (a label with math is on screen); until then labels read symbol text. */
export function useSpeech(enabled: boolean): boolean {
  const [ready, setReady] = useState(speechReady);
  useEffect(() => {
    if (!enabled || ready) return;
    let live = true;
    startSpeech().then(() => { if (live) setReady(true); }, () => {});
    return () => { live = false; };
  }, [enabled, ready]);
  return ready;
}

/** A label with its math drawn as pictures, sized before it is drawn so the row never
 * grows later. It is never reachable by a screen reader on its own: whatever holds it
 * carries the spoken label. `style` must set fontSize and lineHeight. */
export function MathLabel({ pieces, style, color }: { pieces: LabelPiece[]; style: StyleProp<TextStyle>; color: string }) {
  const { fontScale } = useWindowDimensions();
  const { fontSize = 14, lineHeight = 20 } = StyleSheet.flatten(style) ?? {};
  const em = fontSize * fontScale * MATH_SCALE;
  const blocks: ((LabelPiece & { kind: "math" }) | LabelPiece[])[] = [];
  for (const piece of pieces) {
    const last = blocks.at(-1);
    if (piece.kind === "math" && piece.display) blocks.push(piece);
    else if (Array.isArray(last)) last.push(piece);
    else blocks.push([piece]);
  }
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={{ flex: 1 }}>
      {blocks.map((block, index) => Array.isArray(block) ? (
        <Text key={index} style={[style, { lineHeight: lineFor(block, fontSize * MATH_SCALE, lineHeight) }]}>
          {block.map((piece, at) => piece.kind === "text" ? piece.text : <MathPicture key={at} drawn={piece.drawn} em={em} color={color} inline />)}
        </Text>
      ) : (
        <View key={index} style={{ alignItems: "center", paddingVertical: 4 }}>
          <MathPicture drawn={block.drawn} em={em} color={color} />
        </View>
      ))}
    </View>
  );
}

/** A line tall enough for its tallest inline math, so pictures never overlap the next line.
 * In unscaled points: the system scales the line and the math by the font scale alike. */
function lineFor(block: LabelPiece[], em: number, line: number): number {
  const tallest = Math.max(0, ...block.map((piece) => piece.kind === "math" ? piece.drawn.height * em : 0));
  return Math.max(line, Math.ceil(tallest + 2));
}

function MathPicture({ drawn, em, color, inline }: { drawn: DrawnMath; em: number; color: string; inline?: boolean }) {
  const width = drawn.width * em;
  const height = drawn.height * em;
  // An inline view sits on the text baseline, so it drops by the math's depth. Block math
  // scales down to fit the row instead of scrolling; the layout pass sizes it, not a re-measure.
  return (
    <View style={inline ? { width, height, transform: [{ translateY: drawn.depth * em }] }
      : { width, maxWidth: "100%", aspectRatio: drawn.width / Math.max(drawn.height, 0.001) }}>
      <SvgXml xml={drawn.svg} width="100%" height="100%" color={color} />
    </View>
  );
}
