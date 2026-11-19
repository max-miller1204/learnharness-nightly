import { Text, View, useWindowDimensions, type StyleProp, type TextStyle } from "react-native";
import { SvgXml } from "react-native-svg";
import type { DrawnMath, LabelPiece } from "./choice-math";

/** The web draws math with KaTeX at 1.21em; MathJax's TeX fonts share its metrics. */
const MATH_SCALE = 1.21;

/** A label with its math drawn as pictures. It is never reachable by a screen reader
 * on its own: the row that holds it carries the spoken label. */
export function MathLabel({ pieces, style, fontSize, color }: {
  pieces: LabelPiece[]; style: StyleProp<TextStyle>; fontSize: number; color: string;
}) {
  const { fontScale } = useWindowDimensions();
  const em = fontSize * fontScale * MATH_SCALE;
  const blocks: (LabelPiece & { kind: "math" } | LabelPiece[])[] = [];
  for (const piece of pieces) {
    const last = blocks.at(-1);
    if (piece.kind === "math" && piece.display) blocks.push(piece);
    else if (Array.isArray(last)) last.push(piece);
    else blocks.push([piece]);
  }
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={{ flex: 1 }}>
      {blocks.map((block, index) => Array.isArray(block)
        ? <Text key={index} style={style}>{block.map((piece, at) => piece.kind === "text" ? piece.text
          : <MathPicture key={at} drawn={piece.drawn} em={em} color={color} inline />)}</Text>
        : <View key={index} style={{ alignItems: "center", paddingVertical: 4 }}><MathPicture drawn={block.drawn} em={em} color={color} /></View>)}
    </View>
  );
}

function MathPicture({ drawn, em, color, inline }: { drawn: DrawnMath; em: number; color: string; inline?: boolean }) {
  const width = drawn.width * em;
  const height = drawn.height * em;
  // An inline view sits on the text baseline, so it drops by the math's depth.
  return (
    <View style={{ width, height, transform: inline ? [{ translateY: drawn.depth * em }] : undefined }}>
      <SvgXml xml={drawn.svg} width={width} height={height} color={color} />
    </View>
  );
}
