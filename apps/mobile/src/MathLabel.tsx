import { useEffect, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Platform, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type TextStyle } from "react-native";
import { parse, SvgAst, type JsxAST } from "react-native-svg";
import type { DrawnMath, LabelPiece } from "./choice-math";
import { speechReady, startSpeech } from "./math-speech";
import { useLivePictures } from "./math-window";
import { useTheme } from "./theme";

/** The web draws math with KaTeX at 1.21em; MathJax's TeX fonts share its metrics. */
export const MATH_SCALE = 1.21;
/** Source Sans 3's ascent and descent (hhea 1024 and 400 per 1000, every weight and slant),
 * which the phone lays prose lines out with. */
const ASCENT = 1.024;
const DESCENT = 0.4;
/** JetBrains Mono's (hhea 1020 and 300 per 1000), for inline code. */
const MONO = { ascent: 1.02, descent: 0.3 };
/** The descender of the font iOS gives an inline view's character, in points: React Native
 * gives that character no font (RCTNSAttributedStringFragmentFromFragment), so TextKit uses
 * its default, Helvetica at 12 points (descender 0.23 em), at any text size. */
const VIEW_FONT_DESCENT = 2.76;

/** A font in a line of text: its size, and whether it is the code face. */
export type TextRun = { fontSize: number; mono?: boolean };
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

/** Whether a screen reader (VoiceOver, TalkBack) is on: one subscription, shared by every
 * component that asks. */
const screenReader = {
  on: false,
  listeners: new Set<() => void>(),
  subscription: undefined as { remove: () => void } | undefined,
  set(value: boolean) {
    if (value === screenReader.on) return;
    screenReader.on = value;
    for (const listener of screenReader.listeners) listener();
  },
  subscribe(listener: () => void) {
    screenReader.listeners.add(listener);
    if (!screenReader.subscription) {
      screenReader.subscription = AccessibilityInfo.addEventListener("screenReaderChanged", screenReader.set);
      AccessibilityInfo.isScreenReaderEnabled().then(screenReader.set, () => {});
    }
    return () => {
      screenReader.listeners.delete(listener);
      if (screenReader.listeners.size || !screenReader.subscription) return;
      screenReader.subscription.remove();
      screenReader.subscription = undefined;
    };
  },
};
const screenReaderOn = () => screenReader.on;

export function useScreenReader(): boolean {
  return useSyncExternalStore(screenReader.subscribe, screenReaderOn, screenReaderOn);
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

/** The lineHeight to pass for a paragraph holding inline math, whose text is in `runs`. iOS
 * scales a line height by the font scale, as the pictures are, so it is worked out in
 * unscaled points, and also holds each picture once lifted onto the baseline (iosLine). Android
 * scales large sp values less than small ones (Android 14's non-linear font scaling), so a
 * tall line height barely grows while the math grows by the full font scale. There it is
 * worked out at the scaled size and passed as is: Android never scales a size down. */
export function lineHeightFor(sizes: Size[], fontSize: number, line: number, fontScale: number, runs: TextRun[] = [{ fontSize }]): number {
  if (Platform.OS !== "android") return Math.max(paragraphLine(sizes, fontSize, line), iosLine(sizes, runs, line));
  const scaled = sizes.map(({ width, height, depth }) => ({ width: width * fontScale, height: height * fontScale, depth: depth * fontScale }));
  return paragraphLine(scaled, fontSize * fontScale, line * fontScale);
}

/** On iOS, a paragraph's fonts as they lay out a line, in points: the largest descent, which
 * TextKit keeps at the bottom of a line, and the tallest font's line height. */
function iosFonts(runs: TextRun[]) {
  const fonts = runs.map(({ fontSize, mono }) => mono ? { ascent: MONO.ascent * fontSize, descent: MONO.descent * fontSize }
    : { ascent: ASCENT * fontSize, descent: DESCENT * fontSize });
  return { descent: Math.max(...fonts.map((font) => font.descent)), tallest: Math.max(...fonts.map((font) => font.ascent + font.descent)) };
}

/** On iOS, where a line's text baseline sits, up from the line's bottom: React Native raises
 * the glyphs by half the line's height over the tallest font's (RCTApplyBaselineOffsetForRange),
 * or not at all when the line is shorter than that font. */
function iosBaseline(runs: TextRun[], lineHeight: number): number {
  const { descent, tallest } = iosFonts(runs);
  return descent + Math.max(0, (lineHeight - tallest) / 2);
}

/** iOS keeps every line at the lineHeight, so a picture on the baseline that is taller than
 * the line leaves above it would stand out of the line, and one deeper than it leaves below
 * would too. This is the least line height that holds each picture inside its line. A
 * paragraph with no text has no line height of its own on iOS, so it is left as it is. */
function iosLine(sizes: Size[], runs: TextRun[], line: number): number {
  if (!runs.length) return line;
  const fits = (height: number) => {
    const baseline = iosBaseline(runs, height);
    return sizes.every((size) => baseline + size.height - size.depth <= height && size.depth <= baseline);
  };
  if (fits(line)) return line;
  // At a line height L of at least the tallest font's, the baseline is descent + (L - tallest) / 2.
  const { descent, tallest } = iosFonts(runs);
  return Math.ceil(Math.max(tallest, ...sizes.map(({ height, depth }) =>
    Math.max(2 * (height - depth + descent) - tallest, 2 * (depth - descent) + tallest))) + 1);
}

/** How far an inline picture must rise on iOS to sit on its line's baseline, in points at
 * the font scale. React Native's iOS text puts an inline view's bottom at its line's bottom
 * plus its character's font descender (RCTTextLayoutManager's attachment frames), and that
 * character's font is TextKit's default, not the text's. A Text with no text in it has no
 * other font, so its pictures already sit on its baseline. Android puts an inline view on
 * the baseline itself. */
export function inlineLift(lineHeight: number, runs: TextRun[], fontScale: number, platform: string = Platform.OS): number {
  if (platform !== "ios" || !runs.length) return 0;
  const scaled = runs.map((run) => ({ ...run, fontSize: run.fontSize * fontScale }));
  return iosBaseline(scaled, lineHeight * fontScale) - VIEW_FONT_DESCENT;
}

/** A label with its math drawn as pictures, sized before it is drawn so the row never
 * grows later. It is never reachable by a screen reader on its own: whatever holds it
 * carries the spoken label. `style` must set fontSize and lineHeight. */
export function MathLabel({ pieces, style, color }: { pieces: LabelPiece[]; style: StyleProp<TextStyle>; color: string }) {
  // In a session's transcript the pictures show only near the screen (math-window.ts).
  const { live, ref, onLayout } = useLivePictures(pieces.filter((piece) => piece.kind === "math").length);
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
    <View ref={ref} onLayout={onLayout} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={{ flex: 1 }}>
      {blocks.map((block, index) => {
        if (!Array.isArray(block)) {
          return (
            // Block math starts at the left of the row, as on the web's option buttons.
            <View key={index} style={{ alignItems: "flex-start", paddingVertical: 4 }}>
              <MathPicture svg={block.drawn.svg[c.mode]} drawn={block.drawn} size={fit(block.drawn, em, Infinity, maxHeight)} scale={fontScale} color={color} live={live} />
            </View>
          );
        }
        const sizes = block.map((piece) => piece.kind === "math" ? fit(piece.drawn, em, maxWidth, maxHeight) : undefined);
        // The block's text, if any, is all in the label's font.
        const runs = block.some((piece) => piece.kind === "text" && piece.text) ? [{ fontSize }] : [];
        const line = lineHeightFor(sizes.filter((size) => size !== undefined), fontSize, lineHeight, fontScale, runs);
        const lift = inlineLift(line, runs, fontScale);
        return (
          <Text key={index} style={[style, { lineHeight: line }]}>
            {block.map((piece, at) => piece.kind === "text" ? piece.text
              : <MathPicture key={at} svg={piece.drawn.svg[c.mode]} drawn={piece.drawn} size={sizes[at] as Size} scale={fontScale} color={color} live={live} inline
                lift={lift} />)}
          </Text>
        );
      })}
    </View>
  );
}

/** A drawn equation in a box of its exact size. Without `live` the box stays empty, so a
 * picture coming or going never moves anything. */
export function MathPicture({ svg, drawn, size, scale, color, inline, live = true, lift = 0 }: {
  svg: string; drawn: DrawnMath; size: Size; scale: number; color: string; inline?: boolean; live?: boolean;
  /** Inline only: inlineLift for the line it sits in, in points at the font scale. */
  lift?: number;
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
  // below it by the depth, into the space paragraphLine leaves. Lifting moves only what
  // is drawn, so the line's layout is unchanged.
  return (
    <View style={{ width, height: (size.height - size.depth) * scale, transform: lift ? [{ translateY: -lift }] : undefined }}>
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
