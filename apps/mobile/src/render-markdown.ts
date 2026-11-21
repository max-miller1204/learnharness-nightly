import { katex } from "@mdit/plugin-katex";
import MarkdownIt from "markdown-it";

// The plugin only marks where math is: every delimiter the web reads. NativeMarkdown draws it.
const markdown = new MarkdownIt({ html: false, linkify: true }).use(katex, { delimiters: "all" });

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

export function parseMarkdown(text: string) {
  return { tokens: markdown.parse(text, {}) };
}
