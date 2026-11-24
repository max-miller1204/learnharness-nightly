// MathJax extensions that make the phone's drawing match the web's KaTeX where the two differ.
// MathJax's own packages draw everything else.
import { Configuration } from "mathjax-full/js/input/tex/Configuration.js";
import { CommandMap } from "mathjax-full/js/input/tex/SymbolMap.js";
import type { ParseMethod } from "mathjax-full/js/input/tex/Types.js";
import { TextMacrosMethods } from "mathjax-full/js/input/tex/textmacros/TextMacrosMethods.js";

// \colorbox, \fcolorbox, \fbox and \mbox hold their content as text, which MathJax's textmacros
// package parses, and it has no \text (the command is math-only in MathJax). In LaTeX and KaTeX
// \text inside text is plain text, so it is the braced argument.
new CommandMap("lh-text-macros", { text: ["Macro", "{#1}", 1] }, TextMacrosMethods as unknown as Record<string, ParseMethod>);
export const TextInTextConfiguration = Configuration.create("lh-text-in-text", { handler: { macro: ["lh-text-macros"] } });

/** The names to add to textmacros' own packages, which parse text. */
export const PARITY_TEXT_PACKAGES = ["lh-text-in-text"];
