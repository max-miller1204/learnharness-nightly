/** The colors the phone can measure and draw from TeX: the CSS names below, 3- or 6-digit hex,
 *  and rgb() triples of 0 to 255. Anything else is not a color here. */
export const NAMED_COLORS: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  cyan: "#00ffff", aqua: "#00ffff", magenta: "#ff00ff", fuchsia: "#ff00ff", gray: "#808080", grey: "#808080",
  silver: "#c0c0c0", maroon: "#800000", olive: "#808000", lime: "#00ff00", teal: "#008080", navy: "#000080",
  purple: "#800080", orange: "#ffa500", brown: "#a52a2a", pink: "#ffc0cb", violet: "#ee82ee", gold: "#ffd700",
  indigo: "#4b0082", darkgreen: "#006400", darkblue: "#00008b", darkred: "#8b0000", lightgray: "#d3d3d3", lightgrey: "#d3d3d3",
};

/** A color parsed: its CSS form, normalized (a lowercase name, lowercase hex, or rgb(r,g,b)
 *  with no spaces), and its 6-digit hex. Undefined for anything that isn't one of the colors
 *  above, such as none, transparent, currentColor, rgba(), 4- or 5-digit hex, or an unknown name. */
export function parseColor(text: string): { css: string; hex: string } | undefined {
  const color = text.trim();
  const name = NAMED_COLORS[color.toLowerCase()];
  if (/^[a-z]+$/i.test(color) && name) return { css: color.toLowerCase(), hex: name };
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1]?.toLowerCase();
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    return { css: `#${hex}`, hex: `#${full}` };
  }
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(color);
  if (!rgb) return;
  const channels = rgb.slice(1, 4).map(Number);
  if (!channels.every((channel) => channel <= 255)) return;
  return { css: `rgb(${channels.join(",")})`, hex: `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}` };
}
