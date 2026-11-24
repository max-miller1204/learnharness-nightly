// MathJax extensions that make the phone's drawing match the web's KaTeX where the two differ:
// \xrightarrow and \xleftarrow sizes (#365), \text inside text-mode boxes (#351) and where a
// comment ends an argument. MathJax's own packages draw everything else.
import { Configuration } from "mathjax-full/js/input/tex/Configuration.js";
import { CommandMap } from "mathjax-full/js/input/tex/SymbolMap.js";
import { TEXCLASS } from "mathjax-full/js/core/MmlTree/MmlNode.js";
import NodeUtil from "mathjax-full/js/input/tex/NodeUtil.js";
import TexParser from "mathjax-full/js/input/tex/TexParser.js";
import type { ParseMethod } from "mathjax-full/js/input/tex/Types.js";
import { MapHandler } from "mathjax-full/js/input/tex/MapHandler.js";
import type { TextParser } from "mathjax-full/js/input/tex/textmacros/TextParser.js";
import { TextMacrosMethods } from "mathjax-full/js/input/tex/textmacros/TextMacrosMethods.js";

/** The width KaTeX gives \xrightarrow and \xleftarrow at least (katexImagesData in its stretchy.ts),
 *  in em of the arrow's own size, so it shrinks in a script style as KaTeX's does. */
const ARROW_MIN_WIDTH = "1.469em";
/** KaTeX pads a label by 0.5em on each side (.x-arrow-pad), an em of the label's script-size
 *  text; the em of MathJax's mpadded around a label is that same em. */
const LABEL_PADDING = { width: "+1em", lspace: ".5em" };

/** \xrightarrow[below]{above}: MathJax's xArrow (ams) with KaTeX's minimum width and label padding. */
const xArrow: ParseMethod = (parser, name, chr: number) => {
  name = String(name);
  const def = LABEL_PADDING;
  const bot = parser.GetBrackets(name);
  const first = parser.ParseArg(name);
  const dstrut = parser.create("node", "mspace", [], { depth: ".25em" });
  const arrow = parser.create("token", "mo", { stretchy: true, minsize: ARROW_MIN_WIDTH, texClass: TEXCLASS.REL }, String.fromCodePoint(chr));
  const mml = parser.create("node", "munderover", [arrow]);
  let mpadded = parser.create("node", "mpadded", [first, dstrut], def);
  NodeUtil.setAttribute(mpadded, "voffset", "-.2em");
  NodeUtil.setAttribute(mpadded, "height", "-.2em");
  NodeUtil.setChild(mml, (mml as unknown as { over: number }).over, mpadded);
  if (bot) {
    const bottom = new TexParser(bot, parser.stack.env, parser.configuration).mml();
    const bstrut = parser.create("node", "mspace", [], { height: ".75em" });
    mpadded = parser.create("node", "mpadded", [bottom, bstrut], def);
    NodeUtil.setAttribute(mpadded, "voffset", ".15em");
    NodeUtil.setAttribute(mpadded, "depth", "-.15em");
    NodeUtil.setChild(mml, (mml as unknown as { under: number }).under, mpadded);
  }
  NodeUtil.setProperty(mml, "subsupOK", true);
  parser.Push(mml);
};

new CommandMap("lh-xarrows", { xrightarrow: ["XArrow", 0x2192], xleftarrow: ["XArrow", 0x2190] }, { XArrow: xArrow });
/** Ahead of the ams package (priority 5), whose \xrightarrow and \xleftarrow these replace, and
 *  behind the macros MathJax keeps for the user (\newcommand, \renewcommand and \let at -1,
 *  configured macros at 3), so a user's own definition of either command wins. */
export const XArrowConfiguration = Configuration.create("lh-xarrows", { handler: { macro: ["lh-xarrows"] }, priority: 4 });

// \colorbox, \fcolorbox and \fbox (and MathJax's own \mbox) hold their content as text, which
// MathJax's textmacros package parses, and it has no \text (the command is math-only in MathJax).
// In LaTeX and KaTeX \text inside text is plain text, so it is the braced argument. \text is the
// text parser's fallback for a command it doesn't know, so a user's own \text, which the fallback
// finds in the math parser's macros, is expanded as before.

type MacroSymbol = { func: unknown; args: unknown[] };
/** Whether a macro is MathJax's own \text (HBox with no variant), not an alias such as \textbf, \hbox
 *  or \mbox that shares its handler and has other arguments. Unknown names are not. */
const isBaseText = (macro: MacroSymbol | null) => {
  const base = (MapHandler.getMap("macros") as unknown as { lookup(name: string): MacroSymbol | null }).lookup("text");
  return !!macro && !!base && macro.func === base.func && JSON.stringify(macro.args) === JSON.stringify(base.args);
};

/** The text parser's own fallback for a command it has no entry for, with \text added. */
const textFallback = (parser: TextParser, name: string) => {
  const texParser = parser.texParser;
  const macro = texParser.lookup("macro", name) as unknown as MacroSymbol | null;
  if (name === "text" && isBaseText(macro)) return void TextMacrosMethods.Macro(parser, name, "{#1}", 1);
  if (macro && macro.func !== TextMacrosMethods.Macro) parser.Error("MathMacro", "%1 is only supported in math mode", `\\${name}`);
  texParser.parse("macro", [parser, name]);
};
export const TextInTextConfiguration = Configuration.create("lh-text-in-text", {
  fallback: { macro: textFallback as unknown as ParseMethod },
  priority: 4,
});

// Comments follow TeX's rule, as KaTeX reads them: a % runs to the end of its line and swallows
// the line break, wherever it stands, and one with no line break after it runs to the end of the
// input, taking any closing brace that was left. MathJax counts braces without looking for
// comments, so a commented-out brace ends an argument early (\colorbox{c}{\text{a% }\nb}) and a
// comment after an argument hides the brace that closes what holds it (\colorbox{c}{\text{a}% x}
// is drawn instead of refused). So comments are removed before MathJax reads the input.

/** The TeX with each unescaped % and the rest of its line, line break included, removed. */
export function withoutComments(tex: string): string {
  let out = "";
  for (let at = 0; at < tex.length; at++) {
    const c = tex.charAt(at);
    if (c === "\\") out += c + tex.charAt(++at);
    else if (c === "%") {
      const end = tex.indexOf("\n", at);
      if (end < 0) break;
      at = end;
    } else out += c;
  }
  return out;
}
export const CommentsConfiguration = Configuration.create("lh-comments", {
  preprocessors: [(data: { math: { math: string } }) => { data.math.math = withoutComments(data.math.math); }],
  priority: 4,
});

/** Package names to add to the TeX input's packages. */
export const PARITY_PACKAGES = ["lh-xarrows", "lh-comments"];
/** The names to add to textmacros' own packages, which parse text. */
export const PARITY_TEXT_PACKAGES = ["lh-text-in-text"];
