import { useEffect, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions, type StyleProp, type TextStyle } from "react-native";
import { SvgXml } from "react-native-svg";
import type { DrawnMath, LabelPiece } from "./choice-math";
import { speechReady, startSpeech } from "./math-speech";

/** The web draws math with KaTeX at 1.21em; MathJax's TeX fonts share its metrics. */
const MATH_SCALE = 1.21;
/** Source Sans 3's ascent and descent (hhea 1024 and 400 per 1000), which the phone lays
 * prose lines out with. */
const ASCENT = 1.024;
const DESCENT = 0.4;
/** Row and screen padding beside a label, so inline math wider than this scales down. */
const BESIDE_LABEL = 120;
/** No equation is drawn taller than this many lines, so huge math never allocates a huge picture. */
const MAX_LINES = 8;

/** Whether spoken math is ready. Starts the speech engine only when `enabled`
 * (a label with math is on screen); until then labels read their math as text. */
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

/** A drawn equation's size in unscaled points, scaled down to fit `maxWidth` and the line cap. */
function fit(drawn: DrawnMath, em: number, maxWidth: number, maxHeight: number) {
  const scale = Math.min(1, maxWidth / (drawn.width * em), maxHeight / (drawn.height * em));
  return { width: drawn.width * em * scale, height: drawn.height * em * scale, depth: drawn.depth * em * scale };
}

/** The line height for the lines an inline equation sits on. The phone splits extra line
 * height evenly above and below the text, so this grows each such line until it holds
 * the math above the baseline and its depth below; other lines keep `line`. */
function lineFor(size: { height: number; depth: number }, fontSize: number, line: number): number {
  const spare = (line - (ASCENT + DESCENT) * fontSize) / 2;
  const above = ASCENT * fontSize + spare;
  const below = DESCENT * fontSize + spare;
  return Math.ceil(Math.max(line, line + 2 * (size.height - size.depth + 1 - above), line + 2 * (size.depth + 1 - below)));
}

/** A label with its math drawn as pictures, sized before it is drawn so the row never
 * grows later. It is never reachable by a screen reader on its own: whatever holds it
 * carries the spoken label. `style` must set fontSize and lineHeight. */
export function MathLabel({ pieces, style, color }: { pieces: LabelPiece[]; style: StyleProp<TextStyle>; color: string }) {
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const { fontSize = 14, lineHeight = 20 } = StyleSheet.flatten(style) ?? {};
  // Unscaled points: the system scales text and line heights by the font scale, and the
  // pictures are scaled to match.
  const em = fontSize * MATH_SCALE;
  const maxWidth = Math.max(40, (windowWidth - BESIDE_LABEL) / fontScale);
  const maxHeight = MAX_LINES * lineHeight;
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
        <Text key={index} style={style}>
          {block.map((piece, at) => {
            if (piece.kind === "text") return piece.text;
            const size = fit(piece.drawn, em, maxWidth, maxHeight);
            return (
              <Text key={at} style={{ lineHeight: lineFor(size, fontSize, lineHeight) }}>
                <MathPicture drawn={piece.drawn} size={size} scale={fontScale} color={color} inline />
              </Text>
            );
          })}
        </Text>
      ) : (
        <View key={index} style={{ alignItems: "center", paddingVertical: 4 }}>
          <MathPicture drawn={block.drawn} size={fit(block.drawn, em, Infinity, maxHeight)} scale={fontScale} color={color} />
        </View>
      ))}
    </View>
  );
}

function MathPicture({ drawn, size, scale, color, inline }: {
  drawn: DrawnMath; size: { width: number; height: number; depth: number }; scale: number; color: string; inline?: boolean;
}) {
  const width = size.width * scale;
  const height = size.height * scale;
  // An inline view sits on the text baseline, so it drops by the math's depth; its line
  // (lineFor) holds that depth. Block math scales down to fit the row instead of
  // scrolling; the layout pass sizes it, not a re-measure.
  return (
    <View style={inline ? { width, height, transform: [{ translateY: size.depth * scale }] }
      : { width, maxWidth: "100%", aspectRatio: drawn.width / drawn.height }}>
      <SvgXml xml={drawn.svg} width="100%" height="100%" color={color} />
    </View>
  );
}
