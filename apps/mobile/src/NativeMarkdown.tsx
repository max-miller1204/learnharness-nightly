import { Fragment, memo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { httpsLink, type MarkdownToken } from "./render-markdown";
import { colors, styles } from "./ui";

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
  function inline(nodes: Node[]): ReactNode {
    return nodes.map(({ token, children }, index) => {
      switch (token.type) {
        case "strong_open":
          return <Text key={index} style={{ fontWeight: "700" }}>{inline(children)}</Text>;
        case "em_open":
          return <Text key={index} style={{ fontStyle: "italic" }}>{inline(children)}</Text>;
        case "s_open":
          return <Text key={index} style={{ textDecorationLine: "line-through" }}>{inline(children)}</Text>;
        case "code_inline":
          return <Text key={index} style={{ fontFamily: "monospace", backgroundColor: colors.accentLight }}>{token.content}</Text>;
        case "softbreak":
        case "hardbreak":
          return "\n";
        case "link_open": {
          const href = httpsLink(token.attrGet("href"));
          return <Text key={index} accessibilityRole={href ? "link" : undefined}
            onPress={href ? () => openLink(href) : undefined}
            style={href ? { color: colors.accent, textDecorationLine: "underline" } : undefined}>{inline(children)}</Text>;
        }
        case "math_inline":
          return token.markup === "$" ? `$${token.content}$` : `\\(${token.content}\\)`;
        default:
          return children.length > 0 ? inline(children) : token.content;
      }
    });
  }

  function blocks(nodes: Node[]): ReactNode {
    return nodes.map(({ token, children }, index) => {
      switch (token.type) {
        case "paragraph_open":
          return <Fragment key={index}>{blocks(children)}</Fragment>;
        case "inline":
          return <Text key={index} selectable style={styles.text}>{inline(children)}</Text>;
        case "heading_open":
          return <Text key={index} accessibilityRole="header" selectable
            style={token.tag === "h1" ? styles.title : styles.subtitle}>{inline(children)}</Text>;
        case "bullet_list_open":
        case "ordered_list_open": {
          const start = Number(token.attrGet("start") ?? 1);
          return (
            <View key={index} style={{ gap: 4 }}>
              {children.map((item, itemIndex) => (
                <View key={itemIndex} style={{ flexDirection: "row", gap: 8 }}>
                  <Text style={styles.text}>{token.type === "bullet_list_open" ? "•" : `${start + itemIndex}.`}</Text>
                  <View style={{ flex: 1, gap: 4 }}>{blocks(item.children)}</View>
                </View>
              ))}
            </View>
          );
        }
        case "blockquote_open":
          return <View key={index} style={{ borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: 10, gap: 8 }}>{blocks(children)}</View>;
        case "table_open":
          return <View key={index} style={{ gap: 4 }}>{blocks(children)}</View>;
        case "tr_open":
          return <View key={index} style={[styles.divider, { flexDirection: "row", gap: 8, paddingVertical: 4 }]}>{blocks(children)}</View>;
        case "th_open":
        case "td_open":
          return <Text key={index} selectable style={[styles.text, { flex: 1 }, token.type === "th_open" && { fontWeight: "700" }]}>{inline(children)}</Text>;
        case "hr":
          return <View key={index} style={styles.divider} />;
        case "code_block":
        case "fence":
          return <Text key={index} selectable style={[styles.text, { fontFamily: "monospace", backgroundColor: colors.accentLight, padding: 8 }]}>{token.content.trimEnd()}</Text>;
        case "math_block":
          return <Text key={index} selectable style={styles.text}>{token.content.trim()}</Text>;
        default:
          return <View key={index} style={{ gap: 8 }}>{blocks(children)}</View>;
      }
    });
  }

  return <View style={{ gap: 8 }}>{blocks(tokenTree(tokens))}</View>;
});
