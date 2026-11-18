import { katex } from "@mdit/plugin-katex";
import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false }).use(katex, {
  delimiters: "all",
  output: "mathml",
  throwOnError: false,
  trust: false,
});

// The native surface owns all navigation and authenticated images.
markdown.renderer.rules.link_open = () => "";
markdown.renderer.rules.link_close = () => "";
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index]?.content ?? "");

export function renderMarkdown(text: string): string {
  return markdown.render(text);
}
