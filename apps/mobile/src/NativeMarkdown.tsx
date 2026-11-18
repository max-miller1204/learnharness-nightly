import { Fragment, memo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { httpsLink, type MarkdownToken } from "./render-markdown";
import { fonts, radius, space, useTheme } from "./theme";

interface Node {
  token: MarkdownToken;
  children: Node[];
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
  const heading = { h1: 25, h2: 20 } as Record<string, number>;

  // Each weight and slant is its own font file, so nested emphasis picks the combined face.
  function inline(nodes: Node[], bold = false, italic = false): ReactNode {
    const face = (b: boolean, i: boolean) => b ? (i ? fonts.proseBoldItalic : fonts.proseBold) : i ? fonts.proseItalic : fonts.prose;
    return nodes.map(({ token, children }, index) => {
      switch (token.type) {
        case "strong_open":
          return <Text key={index} style={{ fontFamily: face(true, italic), color: c.strong }}>{inline(children, true, italic)}</Text>;
        case "em_open":
          return <Text key={index} style={{ fontFamily: face(bold, true), color: c.italic }}>{inline(children, bold, true)}</Text>;
        case "s_open":
          return <Text key={index} style={{ textDecorationLine: "line-through" }}>{inline(children, bold, italic)}</Text>;
        case "code_inline":
          return <Text key={index} style={[s.well, { fontSize: 14 }]}>{token.content}</Text>;
        case "softbreak":
        case "hardbreak":
          return "\n";
        case "link_open": {
          const href = httpsLink(token.attrGet("href"));
          return <Text key={index} accessibilityRole={href ? "link" : undefined}
            onPress={href ? () => openLink(href) : undefined}
            style={href ? { color: c.text, textDecorationLine: "underline" } : undefined}>{inline(children, bold, italic)}</Text>;
        }
        case "math_inline":
          return token.markup === "$" ? `$${token.content}$` : `\\(${token.content}\\)`;
        default:
          return children.length > 0 ? inline(children, bold, italic) : token.content;
      }
    });
  }

  function blocks(nodes: Node[]): ReactNode {
    return nodes.map(({ token, children }, index) => {
      switch (token.type) {
        case "paragraph_open":
          return <Fragment key={index}>{blocks(children)}</Fragment>;
        case "inline":
          return <Text key={index} selectable style={s.prose}>{inline(children)}</Text>;
        case "heading_open": {
          const size = heading[token.tag] ?? 16;
          return <Text key={index} accessibilityRole="header" selectable
            style={[s.prose, { fontFamily: fonts.proseBlack, fontSize: size, lineHeight: Math.round(size * 1.3), marginTop: space.xs }]}>{inline(children)}</Text>;
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
          return <View key={index} style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: c.border }}>{blocks(children)}</View>;
        case "th_open":
        case "td_open":
          return <Text key={index} selectable style={[s.prose, { flex: 1, paddingHorizontal: space.sm, paddingVertical: space.xs, borderLeftWidth: 1, borderColor: c.border, marginLeft: -1 },
            token.type === "th_open" && { fontFamily: fonts.proseBold }]}>{inline(children)}</Text>;
        case "hr":
          return <View key={index} style={s.divider} />;
        case "code_block":
        case "fence":
          return (
            <View key={index} style={{ borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, borderCurve: "continuous", backgroundColor: c.well, paddingHorizontal: space.lg, paddingVertical: space.md }}>
              <Text selectable style={[s.ui, { color: c.code }]}>{token.content.trimEnd()}</Text>
            </View>
          );
        case "math_block":
          return <Text key={index} selectable style={s.prose}>{token.content.trim()}</Text>;
        default:
          return <View key={index} style={{ gap: space.sm }}>{blocks(children)}</View>;
      }
    });
  }

  return <View style={{ gap: space.md }}>{blocks(tokenTree(tokens))}</View>;
});
