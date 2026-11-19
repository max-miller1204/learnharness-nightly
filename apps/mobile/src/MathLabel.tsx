import { useEffect, useState } from "react";
import { Platform, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type TextStyle } from "react-native";
import { parse, SvgAst, type JsxAST } from "react-native-svg";
import type { DrawnMath, LabelPiece } from "./choice-math";
import { speechReady, startSpeech } from "./math-speech";
import { useTheme } from "./theme";

/** The web draws math with KaTeX at 1.21em; MathJax's TeX fonts share its metrics. */
export const MATH_SCALE = 1.21;
/** Source Sans 3's ascent and descent (hhea 1024 and 400 per 1000), which the phone lays
 * prose lines out with. */
const ASCENT = 1.024;
const DESCENT = 0.4;
/** Row and screen padding beside a label, so inline math wider than this scales down. */
const BESIDE_LABEL = 120;
/** No equation is drawn taller than this many lines, so huge math never allocates a huge picture. */
export const MAX_LINES = 8;

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

export type Size = { width: number; height: number; depth: number };

/** A drawn equation's size in unscaled points, scaled down to fit `maxWidth` and the line cap. */
export function fit(drawn: DrawnMath, em: number, maxWidth: number, maxHeight: number): Size {
  const scale = Math.min(1, maxWidth / (drawn.width * em), maxHeight / (drawn.height * em));
  return { width: drawn.width * em * scale, height: drawn.height * em * scale, depth: drawn.depth * em * scale };
}

/** The line height of a paragraph holding inline math. An inline picture's box is the math
 * above the baseline, and the math hangs below it by its depth. Android sets a line's ascent
 * to the tallest box (or the text's ascent) and its descent to the text's, then splits the
 * extra line height evenly above and below, on every line of the paragraph. So the line
 * leaves the depth below the baseline when L >= top + 2 * depth - descent, and keeps the
 * ascent when L >= top + descent. */
function paragraphLine(sizes: Size[], fontSize: number, line: number): number {
  const [ascent, descent] = [ASCENT * fontSize, DESCENT * fontSize];
  return Math.ceil(Math.max(line, ...sizes.map(({ height, depth }) => {
    const top = Math.max(height - depth, ascent);
    return Math.max(top + descent, top + 2 * depth - descent) + 1;
  })));
}

/** The lineHeight to pass for a paragraph holding inline math. iOS scales a line height by
 * the font scale, as the pictures are, so it gets paragraphLine in unscaled points. Android
 * scales large sp values less than small ones (Android 14's non-linear font scaling), so a
 * tall line height barely grows while the math grows by the full font scale. There it is
 * worked out at the scaled size and passed as is: Android never scales a size down. */
export function lineHeightFor(sizes: Size[], fontSize: number, line: number, fontScale: number): number {
  if (Platform.OS !== "android") return paragraphLine(sizes, fontSize, line);
  const scaled = sizes.map(({ width, height, depth }) => ({ width: width * fontScale, height: height * fontScale, depth: depth * fontScale }));
  return paragraphLine(scaled, fontSize * fontScale, line * fontScale);
}

/** A label with its math drawn as pictures, sized before it is drawn so the row never
 * grows later. It is never reachable by a screen reader on its own: whatever holds it
 * carries the spoken label. `style` must set fontSize and lineHeight. */
export function MathLabel({ pieces, style, color }: { pieces: LabelPiece[]; style: StyleProp<TextStyle>; color: string }) {
  const { c } = useTheme();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const { fontSize = 14, lineHeight = 20 } = StyleSheet.flatten(style) ?? {};
  // Unscaled points: the system scales text by the font scale, and the pictures are scaled to match.
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
      {blocks.map((block, index) => {
        if (!Array.isArray(block)) {
          return (
            // Block math starts at the left of the row, as on the web's option buttons.
            <View key={index} style={{ alignItems: "flex-start", paddingVertical: 4 }}>
              <MathPicture svg={block.drawn.svg[c.mode]} drawn={block.drawn} size={fit(block.drawn, em, Infinity, maxHeight)} scale={fontScale} color={color} />
            </View>
          );
        }
        const sizes = block.map((piece) => piece.kind === "math" ? fit(piece.drawn, em, maxWidth, maxHeight) : undefined);
        const line = lineHeightFor(sizes.filter((size) => size !== undefined), fontSize, lineHeight, fontScale);
        return (
          <Text key={index} style={[style, { lineHeight: line }]}>
            {block.map((piece, at) => piece.kind === "text" ? piece.text
              : <MathPicture key={at} svg={piece.drawn.svg[c.mode]} drawn={piece.drawn} size={sizes[at] as Size} scale={fontScale} color={color} inline />)}
          </Text>
        );
      })}
    </View>
  );
}

/** A drawn equation in a box of its exact size. Without `live` the box stays empty, so a
 * picture coming or going never moves anything. */
export function MathPicture({ svg, drawn, size, scale, color, inline, live = true }: {
  svg: string; drawn: DrawnMath; size: Size; scale: number; color: string; inline?: boolean; live?: boolean;
}) {
  const width = size.width * scale;
  const height = size.height * scale;
  if (!inline) {
    // Block math scales down to fit the row instead of scrolling; the layout pass sizes it, not a re-measure.
    return (
      <View style={{ width, maxWidth: "100%", aspectRatio: drawn.width / drawn.height }}>
        {live && <Picture svg={svg} color={color} />}
      </View>
    );
  }
  // The inline box is the math above the baseline, which it sits on; the picture hangs
  // below it by the depth, into the space paragraphLine leaves.
  return (
    <View style={{ width, height: (size.height - size.depth) * scale }}>
      <View style={{ position: "absolute", top: 0, left: 0, width, height }}>
        {live && <Picture svg={svg} color={color} />}
      </View>
    </View>
  );
}

/** Parsed pictures, so an equation shown many times is parsed once. */
const parsedPictures = new Map<string, JsxAST | null>();

function Picture({ svg, color }: { svg: string; color: string }) {
  let ast = parsedPictures.get(svg);
  if (ast === undefined) {
    try { ast = parse(svg); } catch { ast = null; }
    if (parsedPictures.size >= 1000) parsedPictures.delete(parsedPictures.keys().next().value as string);
    parsedPictures.set(svg, ast);
  }
  return <SvgAst ast={ast} override={{ width: "100%", height: "100%", color }} />;
}
