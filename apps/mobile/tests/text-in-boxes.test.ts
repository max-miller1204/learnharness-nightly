// \text inside a box that MathJax parses as text (\colorbox, \fcolorbox, \fbox, \mbox, \text)
// draws on the phone as the web's KaTeX draws it, instead of falling back to TeX source (#351).
import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { drawTex } from "../src/choice-math.ts";

const THEMES = { dark: { ink: "#e6e6e6", back: "#141414" }, light: { ink: "#3d3d3a", back: "#faf9f5" } } as const;

function pixels(svg: string, mode: keyof typeof THEMES) {
  const [, , width, height] = (svg.match(/viewBox="([^"]*)"/)?.[1] ?? "").split(/\s+/).map(Number) as [number, number, number, number];
  const page = svg.replace("<svg ", `<svg width="600" height="${Math.ceil(600 * height / width)}" style="color:${THEMES[mode].ink}" `);
  return new Resvg(page, { background: THEMES[mode].back }).render().pixels;
}

/** Whether two drawings look the same, to anti-aliasing. */
function same(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  for (let at = 0; at < a.length; at++) if (Math.abs((a[at] as number) - (b[at] as number)) > 48) return false;
  return true;
}

test("\\text inside a color box or frame draws the box around the text, as without \\text", () => {
  for (const [withText, plain] of [
    [String.raw`\colorbox{yellow}{\text{hi}}`, String.raw`\colorbox{yellow}{hi}`],
    [String.raw`\fcolorbox{red}{yellow}{\text{hi}}`, String.raw`\fcolorbox{red}{yellow}{hi}`],
    [String.raw`\fbox{\text{hi}}`, String.raw`\fbox{hi}`],
    [String.raw`\mbox{\text{hi}}`, String.raw`\mbox{hi}`],
    [String.raw`\text{a \text{hi} b}`, String.raw`\text{a hi b}`],
    [String.raw`x = \colorbox{yellow}{\text{two words}}`, String.raw`x = \colorbox{yellow}{two words}`],
  ] as const) {
    const drawn = drawTex(withText, true);
    assert.ok(drawn, `${withText}: drawn, not shown as source`);
    const expected = drawTex(plain, true);
    assert.ok(expected, plain);
    for (const mode of ["light", "dark"] as const) {
      assert.ok(same(pixels(drawn.svg[mode], mode), pixels(expected.svg[mode], mode)), `${withText} (${mode}): same picture as ${plain}`);
    }
  }
});

test("math and other text commands still work inside a box that holds \\text", () => {
  for (const tex of [String.raw`\colorbox{yellow}{\text{a $x^2$ b}}`, String.raw`\colorbox{yellow}{\text{\textbf{b} and \textit{i}}}`]) assert.ok(drawTex(tex, true), tex);
  // A command that only works in math mode is still refused inside text, as MathJax does.
  assert.equal(drawTex(String.raw`\colorbox{yellow}{\frac{1}{2}}`, true), undefined);
});

test("a user's own \\text wins inside a box too", () => {
  const foo = drawTex(String.raw`\colorbox{yellow}{foo}`, true) ?? assert.fail("foo");
  const drawn = drawTex(String.raw`\renewcommand{\text}[1]{foo}\colorbox{yellow}{\text{hi}}`, true) ?? assert.fail("not drawn");
  for (const mode of ["light", "dark"] as const) assert.ok(same(pixels(drawn.svg[mode], mode), pixels(foo.svg[mode], mode)), mode);
});

test("a % in the text comments out the braces after it, so the box is refused as it is on the web", () => {
  for (const tex of [String.raw`\colorbox{yellow}{\text{hi% there}}`, String.raw`\fcolorbox{red}{yellow}{\text{hi%}}`, String.raw`\fbox{\text{a\%b% c}}`]) {
    assert.equal(drawTex(tex, true), undefined, tex);
  }
  // A comment that ends at a line break, and a % that is escaped, comment nothing out.
  for (const tex of ["\\colorbox{yellow}{\\text{hi% there\n}}", String.raw`\colorbox{yellow}{\text{50\% off}}`]) assert.ok(drawTex(tex, true), tex);
});
