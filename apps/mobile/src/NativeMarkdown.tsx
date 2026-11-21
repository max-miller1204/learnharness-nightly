import { Fragment, memo, useMemo, type ReactElement, type ReactNode, type RefObject } from "react";
import { Text, View, useWindowDimensions, type HostInstance, type LayoutChangeEvent } from "react-native";
import { drawingsOf, equationOf } from "./message-math";
import { useLivePictures } from "./math-window";
import type { LabelPiece } from "./choice-math";
import { fit, inlineLift, lineHeightFor, MathPicture, MATH_SCALE, MAX_LINES, useScreenReader, useSpeech, type Size } from "./MathLabel";
import { spokenLabel, spokenMath } from "./math-speech";
import { httpsLink, type MarkdownToken } from "./render-markdown";
import { fonts, radius, space, useTheme } from "./theme";

/** Room beside a message's text (screen padding, cards, bands and list indents), so inline
 * math wider than the rest scales down. */
const BESIDE_TEXT = 120;
/** Punctuation that stays on the line of the inline math before it. */
const CLINGS = /^[.,;:!?)\]}%'"\u2019\u201d\u2026]/;
/** Inline math in a table cell scales down to the cell, never below this width. */
const MIN_CELL_MATH = 24;
/** U+2060 WORD JOINER: no line break on either side. */
const JOIN = "\u2060";

interface Node {
  token: MarkdownToken;
  children: Node[];
}

/** Gives a block whether its pictures show now (math-window.ts), for its own view. */
function Live({ pictures, children }: {
  pictures: number;
  children: (live: boolean, ref: RefObject<HostInstance | null>, onLayout?: (event: LayoutChangeEvent) => void) => ReactElement;
}) {
  const { live, ref, onLayout } = useLivePictures(pictures);
  return children(live, ref, onLayout);
}

interface InlineMath {
  sizes: Map<MarkdownToken, Size>;
  live: boolean;
  /** inlineLift for the line, in unscaled points. */
  lift: number;
}

function hasMath(token: MarkdownToken): boolean {
  return token.type === "math_inline" || token.type === "math_block" || token.children?.some(hasMath) === true;
}

function tokenTree(tokens: MarkdownToken[]): Node[] {
  const root: Node[] = [];
  const levels = [root];
  for (const token of tokens) {
    if (token.nesting === -1) {
      levels.pop();
      continue;
    }
    const children = token.children ? tokenTree(token.children) : [];
    levels.at(-1)?.push({ token, children });
    if (token.nesting === 1) levels.push(children);
  }
  return root;
}

export const NativeMarkdown = memo(function NativeMarkdown({ tokens, openLink }: {
  tokens: MarkdownToken[];
  openLink: (url: string) => void;
}) {
  const { c, s } = useTheme();
  // Drawn once per text, so a render (or a picture coming or going) never draws again.
  const pictures = useMemo(() => drawingsOf(tokens), [tokens]);
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const heading = { h1: 25, h2: 20 } as Record<string, number>;
  const maxWidth = Math.max(40, (windowWidth - BESIDE_TEXT) / fontScale);
  // A paragraph with math is one screen reader stop with the math in it. Its label is right
  // from the first render, the math read as text, and spoken once a screen reader is on and
  // the speech engine is ready.
  const screenReader = useScreenReader();
  const speech = useSpeech(screenReader && tokens.some(hasMath));

  /** Each inline equation's drawn size, for a line of text at `fontSize`. */
  function mathSizes(nodes: Node[], fontSize: number, lineHeight: number, width: number, found = new Map<MarkdownToken, Size>()) {
    for (const { token, children } of nodes) {
      const drawn = token.type === "math_inline" ? pictures.get(token) : undefined;
      if (drawn) found.set(token, fit(drawn, fontSize * MATH_SCALE, width, MAX_LINES * lineHeight));
      mathSizes(children, fontSize, lineHeight, width, found);
    }
    return found;
  }

  /** The line as a screen reader reads it: its text, with each drawn equation spoken. */
  function pieces(nodes: Node[], sizes: Map<MarkdownToken, Size>, found: LabelPiece[] = []): LabelPiece[] {
    for (const { token, children } of nodes) {
      const equation = sizes.has(token) ? equationOf(token) : undefined;
      const drawn = equation && pictures.get(token);
      if (equation && drawn) found.push({ kind: "math", tex: equation.tex, display: false, drawn });
      else if (token.type === "math_inline") found.push({ kind: "text", text: token.markup === "$" ? `$${token.content}$` : `\\(${token.content}\\)` });
      else if (token.type === "softbreak" || token.type === "hardbreak") found.push({ kind: "text", text: " " });
      else if (children.length) pieces(children, sizes, found);
      else if (token.content) found.push({ kind: "text", text: token.content });
    }
    return found;
  }

  /** A line of text whose line height leaves room for the inline math in it. Inline math
   * wider than `width` scales down. */
  function line(key: number, nodes: Node[], style: { fontSize: number; lineHeight: number }, extra?: object, role?: "header", width = maxWidth) {
    const sizes = mathSizes(nodes, style.fontSize, style.lineHeight, width);
    const lineHeight = sizes.size ? lineHeightFor([...sizes.values()], style.fontSize, style.lineHeight, fontScale) : style.lineHeight;
    return (
      <Live key={key} pictures={sizes.size}>
        {(live, ref, onLayout) => (
          <Text ref={ref} onLayout={onLayout} accessibilityRole={role} selectable style={[s.prose, style, extra, { lineHeight }]}
            accessibilityLabel={sizes.size ? spokenLabel(pieces(nodes, sizes), speech && live) : undefined}>
            {inline(nodes, { sizes, live, lift: inlineLift(lineHeight, style.fontSize) })}
          </Text>
        )}
      </Live>
    );
  }

  // Each weight and slant is its own font file, so nested emphasis picks the combined face.
  function inline(nodes: Node[], math: InlineMath, bold = false, italic = false): ReactNode {
    const face = (b: boolean, i: boolean) => b ? (i ? fonts.proseBoldItalic : fonts.proseBold) : i ? fonts.proseItalic : fonts.prose;
    return nodes.map(({ token, children }, index) => {
      switch (token.type) {
        case "strong_open":
          return <Text key={index} style={{ fontFamily: face(true, italic), color: c.strong }}>{inline(children, math, true, italic)}</Text>;
        case "em_open":
          return <Text key={index} style={{ fontFamily: face(bold, true), color: c.italic }}>{inline(children, math, bold, true)}</Text>;
        case "s_open":
          return <Text key={index} style={{ textDecorationLine: "line-through" }}>{inline(children, math, bold, italic)}</Text>;
        case "code_inline":
          return <Text key={index} style={[s.well, { fontSize: 14 }]}>{token.content}</Text>;
        case "softbreak":
        case "hardbreak":
          return "\n";
        case "link_open": {
          const href = httpsLink(token.attrGet("href"));
          return <Text key={index} accessibilityRole={href ? "link" : undefined}
            onPress={href ? () => openLink(href) : undefined}
            style={href ? { color: c.text, textDecorationLine: "underline" } : undefined}>{inline(children, math, bold, italic)}</Text>;
        }
        case "math_inline": {
          const size = math.sizes.get(token);
          const drawn = size && pictures.get(token);
          // Math that can't be drawn shows its source.
          if (!size || !drawn) return token.markup === "$" ? `$${token.content}$` : `\\(${token.content}\\)`;
          const picture = <MathPicture key={index} svg={drawn.svg[c.mode]} drawn={drawn} size={size} scale={fontScale} color={c.text} live={math.live} inline lift={math.lift} />;
          // A period or comma right after the math never wraps away from it.
          const after = nodes[index + 1]?.token;
          return after?.type === "text" && CLINGS.test(after.content) ? [picture, JOIN] : picture;
        }
        default:
          return children.length > 0 ? inline(children, math, bold, italic) : token.content;
      }
    });
  }

  function blocks(nodes: Node[]): ReactNode {
    return nodes.map(({ token, children }, index) => {
      switch (token.type) {
        case "paragraph_open":
          return <Fragment key={index}>{blocks(children)}</Fragment>;
        case "inline":
          return line(index, children, s.prose);
        case "heading_open": {
          const size = heading[token.tag] ?? 16;
          return line(index, children, { fontSize: size, lineHeight: Math.round(size * 1.3) }, { fontFamily: fonts.proseBlack, marginTop: space.xs }, "header");
        }
        case "bullet_list_open":
        case "ordered_list_open": {
          const start = Number(token.attrGet("start") ?? 1);
          return (
            <View key={index} style={{ gap: space.xs, paddingLeft: space.sm }}>
              {children.map((item, itemIndex) => (
                <View key={itemIndex} style={{ flexDirection: "row", gap: space.sm }}>
                  <Text style={s.prose}>{token.type === "bullet_list_open" ? "•" : `${start + itemIndex}.`}</Text>
                  <View style={{ flex: 1, gap: space.xs }}>{blocks(item.children)}</View>
                </View>
              ))}
            </View>
          );
        }
        case "blockquote_open":
          return <View key={index} style={{ borderLeftWidth: 3, borderLeftColor: c.rail, paddingLeft: space.md, gap: space.sm }}>{blocks(children)}</View>;
        case "table_open":
          // The web's outlined table: an outer border, row rules and column rules.
          return <View key={index} style={{ borderWidth: 1, borderColor: c.border, borderBottomWidth: 0 }}>{blocks(children)}</View>;
        case "tr_open":
          // Equal columns, as in a table without math; math in a cell fits the cell.
          return (
            <View key={index} style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: c.border }}>
              {children.map((cell, cellIndex) => line(cellIndex, cell.children, s.prose,
                [{ flex: 1, paddingHorizontal: space.sm, paddingVertical: space.xs, borderLeftWidth: 1, borderColor: c.border, marginLeft: -1 },
                  cell.token.type === "th_open" && { fontFamily: fonts.proseBold }], undefined, Math.max(MIN_CELL_MATH, maxWidth / Math.max(1, children.length) - 2 * space.sm)))}
            </View>
          );
        case "hr":
          return <View key={index} style={s.divider} />;
        case "code_block":
        case "fence":
          return (
            <View key={index} style={{ borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, borderCurve: "continuous", backgroundColor: c.well, paddingHorizontal: space.lg, paddingVertical: space.md }}>
              <Text selectable style={[s.ui, { color: c.code }]}>{token.content.trimEnd()}</Text>
            </View>
          );
        case "math_block": {
          const drawn = pictures.get(token);
          if (!drawn) return <Text key={index} selectable style={s.prose}>{token.content.trim()}</Text>;
          // Display math is centered as on the web, and scales down to fit the column instead of scrolling.
          return (
            <Live key={index} pictures={1}>
              {(live, ref, onLayout) => (
                <View ref={ref} onLayout={onLayout} style={{ alignItems: "center" }}
                  accessible accessibilityLabel={spokenMath(drawn, speech && live)}>
                  <MathPicture svg={drawn.svg[c.mode]} drawn={drawn} size={fit(drawn, s.prose.fontSize * MATH_SCALE, Infinity, MAX_LINES * s.prose.lineHeight)}
                    scale={fontScale} color={c.text} live={live} />
                </View>
              )}
            </Live>
          );
        }
        default:
          return <View key={index} style={{ gap: space.sm }}>{blocks(children)}</View>;
      }
    });
  }

  return <View style={{ gap: space.md }}>{blocks(tokenTree(tokens))}</View>;
});
