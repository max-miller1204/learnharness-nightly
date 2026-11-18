import { katex } from "@mdit/plugin-katex";
import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, linkify: true }).use(katex, {
  delimiters: "all",
  output: "mathml",
  throwOnError: false,
  trust: false,
});

export type MarkdownToken = ReturnType<typeof markdown.parse>[number];

export function httpsLink(href: unknown): string | undefined {
  if (typeof href !== "string" || !/^https:\/\//i.test(href)) return;
  try {
    const url = new URL(href);
    if (url.protocol === "https:" && url.hostname) return url.href;
  } catch {
    // Leave malformed links as plain text.
  }
}

// Only the host can open links. Images in messages use the native snapshot renderer.
markdown.renderer.rules.link_open = (tokens, index) => {
  const href = httpsLink(tokens[index]?.attrGet("href") ?? null);
  return href ? `<a href="${markdown.utils.escapeHtml(href)}">` : "";
};
markdown.renderer.rules.link_close = (tokens, index) => {
  const level = tokens[index]?.level;
  for (let earlier = index - 1; earlier >= 0; earlier--) {
    const token = tokens[earlier];
    if (token?.type === "link_open" && token.level === level) {
      return httpsLink(token.attrGet("href")) ? "</a>" : "";
    }
  }
  return "";
};
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index]?.content ?? "");

function containsMath(token: MarkdownToken): boolean {
  return token.type === "math_inline" || token.type === "math_block" || token.children?.some(containsMath) === true;
}

export function parseMarkdown(text: string) {
  const env = {};
  const tokens = markdown.parse(text, env);
  return { tokens, env, hasMath: tokens.some(containsMath) };
}

export function renderMarkdown({ tokens, env }: ReturnType<typeof parseMarkdown>): string {
  return markdown.renderer.render(tokens, markdown.options, env);
}
