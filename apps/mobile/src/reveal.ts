/**
 * The scroll offset that brings a field fully into a scroll viewport, with a
 * margin, or null when it is already visible. A field taller than the
 * viewport is aligned by its top.
 */
export function revealOffset(field: { y: number; height: number }, viewport: number, current: number, margin = 16): number | null {
  const top = Math.max(0, field.y - margin);
  const bottom = field.y + field.height + margin;
  if (top < current || bottom - top > viewport) return top === current ? null : top;
  if (bottom > current + viewport) return bottom - viewport;
  return null;
}
