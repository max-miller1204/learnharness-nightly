// What a picked photo really is, and its JPEG without location data. Pure, so
// tests run in Node. expo-image-picker on Android copies GPS EXIF tags into
// its re-encoded JPEG; iOS drops them when it re-encodes. Both platforms
// upload through stripLocation so neither sends coordinates.

/** The image type the bytes hold, whatever the picker reported. */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  const at = (index: number, ...values: number[]) => values.every((value, offset) => bytes[index + offset] === value);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
}

const ascii = (bytes: Uint8Array, start: number, text: string) =>
  [...text].every((char, index) => bytes[start + index] === char.charCodeAt(0));

/** Bytes per value of each TIFF field type. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const GPS_IFD = 0x8825;

/** Erases the GPS IFD inside one EXIF block (TIFF data from `tiff` to `end`):
 *  its entries and values are zeroed and IFD0 no longer points to it. */
function eraseGps(bytes: Uint8Array, tiff: number, end: number): boolean {
  const little = ascii(bytes, tiff, "II");
  if (!little && !ascii(bytes, tiff, "MM")) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, little);
  const u32 = (offset: number) => view.getUint32(offset, little);
  const inside = (offset: number, length: number) => offset >= tiff && offset + length <= end;
  const ifd0 = tiff + u32(tiff + 4);
  if (!inside(ifd0, 2)) return false;
  const count = u16(ifd0);
  const tableEnd = ifd0 + 2 + count * 12 + 4;
  if (!inside(ifd0, tableEnd - ifd0)) return false;
  for (let index = 0; index < count; index++) {
    const entry = ifd0 + 2 + index * 12;
    if (u16(entry) !== GPS_IFD) continue;
    const gps = tiff + u32(entry + 8);
    if (inside(gps, 2)) {
      const fields = u16(gps);
      const gpsEnd = gps + 2 + fields * 12 + 4;
      if (inside(gps, gpsEnd - gps)) {
        for (let field = 0; field < fields; field++) {
          const at = gps + 2 + field * 12;
          const size = (TYPE_SIZE[u16(at + 2)] ?? 1) * u32(at + 4);
          const value = tiff + u32(at + 8);
          if (size > 4 && inside(value, size)) bytes.fill(0, value, value + size);
        }
        bytes.fill(0, gps, gpsEnd);
      }
    }
    // Drop the pointer: later entries and the next-IFD offset move up one slot.
    bytes.copyWithin(entry, entry + 12, tableEnd);
    bytes.fill(0, tableEnd - 12, tableEnd);
    view.setUint16(ifd0, count - 1, little);
    return true;
  }
  return false;
}

/** The JPEG without location data, or null when there was none (or the bytes
 *  aren't a JPEG). GPS EXIF is erased in place; XMP and Photoshop (IPTC)
 *  blocks, which can also carry a location, are removed whole. Orientation and
 *  the rest of EXIF stay, so the photo still displays upright. */
export function stripLocation(source: Uint8Array): Uint8Array | null {
  if (sniffImageType(source) !== "image/jpeg") return null;
  const bytes = source.slice();
  const drop: [number, number][] = [];
  let changed = false;
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0xda || marker === 0xd9) break; // Image data starts: no more metadata.
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const start = offset + 4;
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) break;
    if (marker === 0xe1 && ascii(bytes, start, "Exif\0\0")) {
      changed = eraseGps(bytes, start + 6, end) || changed;
    } else if ((marker === 0xe1 && ascii(bytes, start, "http://ns.adobe.com/")) || (marker === 0xed && ascii(bytes, start, "Photoshop 3.0"))) {
      drop.push([offset, end]);
    }
    offset = end;
  }
  if (!changed && !drop.length) return null;
  if (!drop.length) return bytes;
  const parts: Uint8Array[] = [];
  let from = 0;
  for (const [start, end] of drop) {
    parts.push(bytes.subarray(from, start));
    from = end;
  }
  parts.push(bytes.subarray(from));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
