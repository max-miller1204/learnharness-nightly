// MathJax extensions that make the phone's drawing match the web's KaTeX where the two differ:
// \xrightarrow and \xleftarrow sizes (#365) and \text inside text-mode boxes (#351). MathJax's
// own packages draw everything else.
import { Configuration } from "mathjax-full/js/input/tex/Configuration.js";
import { CommandMap } from "mathjax-full/js/input/tex/SymbolMap.js";
import { TEXCLASS } from "mathjax-full/js/core/MmlTree/MmlNode.js";
import NodeUtil from "mathjax-full/js/input/tex/NodeUtil.js";
import TexParser from "mathjax-full/js/input/tex/TexParser.js";
import type { ParseMethod } from "mathjax-full/js/input/tex/Types.js";
import { TextMacrosMethods } from "mathjax-full/js/input/tex/textmacros/TextMacrosMethods.js";

/** The width KaTeX gives \xrightarrow and \xleftarrow at least (katexImagesData in its stretchy.ts). */
const ARROW_MIN_WIDTH = "1.469em";
/** KaTeX pads a label by 0.5em of the text's size on each side (.x-arrow-pad). MathJax sets the
 *  label at script size, and an em in it is that much smaller, so the padding is written in the
 *  em of the label: the text's em over the script size multiplier, which is 1/√2. */
const LABEL_EM = Math.SQRT2;
const PAD = `${String(LABEL_EM / 2)}em`;

/** \xrightarrow[below]{above}: MathJax's xArrow (ams) with KaTeX's minimum width and label padding. */
const xArrow: ParseMethod = (parser, name, chr: number) => {
  name = String(name);
  const def = { width: `+${String(LABEL_EM)}em`, lspace: PAD };
  const bot = parser.GetBrackets(name);
  const first = parser.ParseArg(name);
  const dstrut = parser.create("node", "mspace", [], { depth: ".25em" });
  let arrow = parser.create("token", "mo", { stretchy: true, minsize: ARROW_MIN_WIDTH, texClass: TEXCLASS.REL }, String.fromCodePoint(chr));
  arrow = parser.create("node", "mstyle", [arrow], { scriptlevel: 0 });
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
/** Before the ams package (priority -1), whose \xrightarrow and \xleftarrow these replace. */
export const XArrowConfiguration = Configuration.create("lh-xarrows", { handler: { macro: ["lh-xarrows"] }, priority: -2 });

// \colorbox, \fcolorbox, \fbox and \mbox hold their content as text, which MathJax's textmacros
// package parses, and it has no \text (the command is math-only in MathJax). In LaTeX and KaTeX
// \text inside text is plain text, so it is the braced argument.
new CommandMap("lh-text-macros", { text: ["Macro", "{#1}", 1] }, TextMacrosMethods as unknown as Record<string, ParseMethod>);
export const TextInTextConfiguration = Configuration.create("lh-text-in-text", { handler: { macro: ["lh-text-macros"] } });

/** Package names to add to the TeX input's packages. */
export const PARITY_PACKAGES = ["lh-xarrows"];
/** The names to add to textmacros' own packages, which parse text. */
export const PARITY_TEXT_PACKAGES = ["lh-text-in-text"];
