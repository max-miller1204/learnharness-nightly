// MathJax places the stretched middle of a brace, arrow or bar in a nested svg with an x and y
// offset, and react-native-svg draws a nested Svg at its parent's origin (#338). drawTex moves
// each offset onto a group, so the phone draws what MathJax means.
import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { drawTex, nestedOffsets } from "../src/choice-math.ts";

const OWNER = String.raw`\text{output size} = \underbrace{\left\lfloor \frac{i+2p-k}{s} \right\rfloor}_{\text{moves that fit}} + \underbrace{1}_{\text{first window}}.`;
const STRETCHED = [String.raw`\underbrace{abc}_{x}`, String.raw`\overbrace{abcdef}^{x}`, String.raw`\xrightarrow{\text{long label}}`,
  String.raw`\overrightarrow{AB}`, String.raw`\overline{abc}`, String.raw`\left\{\begin{matrix}a\\b\\c\end{matrix}\right.`, OWNER];
const UNSTRETCHED = [String.raw`\left(\frac{\frac{a}{b}}{\frac{c}{d}}\right)`, String.raw`\left\lfloor\frac{a}{b}\right\rfloor`,
  String.raw`\sqrt{\frac{\frac{a}{b}}{c}}`, String.raw`\widehat{abc}`, String.raw`\bigg(x\bigg)`];
const THEMES = { dark: { ink: "#e6e6e6", back: "#141414" }, light: { ink: "#3d3d3a", back: "#faf9f5" } } as const;
const nested = (svg: string) => [...svg.matchAll(/<svg\b[^>]*>/g)].slice(1).map(([tag]) => tag);

/** react-native-svg 15's placement: a nested Svg at its parent's origin, x and y dropped. */
const phoneRule = (svg: string) => svg.replace(/<svg\b[^>]*>/g, (tag, at: number) => at === 0 ? tag : tag.replace(/\s(?:x|y)="[^"]*"/g, ""));

/** A drawing's pixels as a browser draws it (resvg), at 800 pixels wide, in a theme's colors. */
function pixels(svg: string, mode: keyof typeof THEMES) {
  const [, , width, height] = (svg.match(/viewBox="([^"]*)"/)?.[1] ?? "").split(/\s+/).map(Number) as [number, number, number, number];
  const page = svg.replace("<svg ", `<svg width="800" height="${Math.ceil(800 * height / width)}" style="color:${THEMES[mode].ink}" `);
  return new Resvg(page, { background: THEMES[mode].back }).render().pixels;
}

/** The picture MathJax places itself, and the one drawTex hands the phone. */
function both(tex: string, mode: keyof typeof THEMES) {
  nestedOffsets.moved = false;
  try {
    const mathjax = drawTex(tex, true)?.svg[mode];
    nestedOffsets.moved = true;
    const phone = drawTex(tex, true)?.svg[mode];
    assert.ok(mathjax && phone, tex);
    return { mathjax, phone };
  } finally {
    nestedOffsets.moved = true;
  }
}

test("no nested svg keeps an offset", () => {
  for (const tex of STRETCHED) {
    const { mathjax, phone } = both(tex, "dark");
    assert.ok(nested(mathjax).some((tag) => /\s(?:x|y)="(?!0")/.test(tag)), `${tex}: MathJax offsets a nested svg`);
    assert.deepEqual(nested(phone).filter((tag) => /\s(?:x|y)="/.test(tag)), [], tex);
  }
});

test("stretched braces, arrows and bars draw on the phone exactly as MathJax places them, in both themes", () => {
  for (const tex of STRETCHED) {
    for (const mode of ["dark", "light"] as const) {
      const { mathjax, phone } = both(tex, mode);
      const meant = pixels(mathjax, mode);
      assert.ok(Buffer.compare(pixels(phoneRule(mathjax), mode), meant) !== 0, `${tex} (${mode}): MathJax's own markup is broken on the phone`);
      assert.ok(Buffer.compare(pixels(phoneRule(phone), mode), meant) === 0, `${tex} (${mode}): drawn as MathJax places it`);
      assert.ok(Buffer.compare(pixels(phone, mode), meant) === 0, `${tex} (${mode}): unchanged in a browser`);
    }
  }
});

test("parentheses, floors, roots, hats and big delimiters are unchanged", () => {
  for (const tex of UNSTRETCHED) {
    const { mathjax, phone } = both(tex, "light");
    assert.equal(phone, mathjax, tex);
    assert.deepEqual(nested(phone), [], tex);
  }
});
