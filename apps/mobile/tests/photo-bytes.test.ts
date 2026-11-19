import assert from "node:assert/strict";
import test from "node:test";
import { sniffImageType, stripLocation } from "../src/photo-bytes.ts";

const text = (value: string) => [...value].map((char) => char.charCodeAt(0));
const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const LATITUDE = [0, 0, 0, 52, 0, 0, 0, 1, 0, 0, 0, 31, 0, 0, 0, 1, 0, 0, 0x0b, 0xb8, 0, 0, 0, 100];

/** TIFF data: IFD0 holds Orientation 6 and the GPS pointer; the GPS IFD holds
 *  "N" inline and a latitude stored out of line. */
function tiff(little: boolean): number[] {
  const out: number[] = [];
  const u16 = (value: number) => little ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff];
  const u32 = (value: number) => little ? [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24]
    : [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  const ifd0 = 8, gps = ifd0 + 2 + 2 * 12 + 4, latitude = gps + 2 + 2 * 12 + 4;
  out.push(...text(little ? "II" : "MM"), ...u16(42), ...u32(ifd0));
  out.push(...u16(2), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(6), 0, 0, ...u16(0x8825), ...u16(4), ...u32(1), ...u32(gps), ...u32(0));
  out.push(...u16(2), ...u16(0x0001), ...u16(2), ...u32(2), ...text("N"), 0, 0, 0, ...u16(0x0002), ...u16(5), ...u32(3), ...u32(latitude), ...u32(0));
  out.push(...LATITUDE.map((byte, index) => little ? LATITUDE[index - (index % 4) + 3 - (index % 4)]! : byte));
  return out;
}

const IMAGE = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0x56, 0xff, 0xd9];

function jpeg(little: boolean, extras = true): Uint8Array {
  return new Uint8Array([0xff, 0xd8,
    ...segment(0xe0, [...text("JFIF"), 0, 1, 2, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xe1, [...text("Exif"), 0, 0, ...tiff(little)]),
    ...(extras ? segment(0xe1, [...text("http://ns.adobe.com/xap/1.0/"), 0, ...text("<exif:GPSLatitude>52,31N</exif:GPSLatitude>")]) : []),
    ...(extras ? segment(0xed, [...text("Photoshop 3.0"), 0, ...text("8BIM city")]) : []),
    ...IMAGE]);
}

const contains = (bytes: Uint8Array, needle: number[]) =>
  bytes.some((_, start) => needle.every((value, offset) => bytes[start + offset] === value));

test("sniffs the type the bytes really hold", () => {
  assert.equal(sniffImageType(jpeg(true)), "image/jpeg");
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10])), "image/png");
  assert.equal(sniffImageType(new Uint8Array(text("GIF89a"))), "image/gif");
  assert.equal(sniffImageType(new Uint8Array([...text("RIFF"), 1, 2, 3, 4, ...text("WEBPVP8 ")])), "image/webp");
  assert.equal(sniffImageType(new Uint8Array(text("%PDF-1.7"))), undefined);
});

for (const little of [true, false]) {
  test(`removes GPS, XMP and IPTC but keeps orientation and the image (${little ? "little" : "big"}-endian EXIF)`, () => {
    const source = jpeg(little);
    const out = stripLocation(source)!;
    assert.ok(out);
    assert.equal(sniffImageType(out), "image/jpeg");
    assert.ok(contains(source, [0x00, 0x00, 0x0b, 0xb8].map((_, i, a) => little ? a[3 - i]! : a[i]!)), "the fixture holds a latitude");
    assert.ok(!contains(out, little ? [0xb8, 0x0b, 0, 0] : [0, 0, 0x0b, 0xb8]), "the latitude value is gone");
    assert.ok(!contains(out, little ? [0x25, 0x88] : [0x88, 0x25]), "no GPS pointer survives");
    assert.ok(!contains(out, little ? [0x01, 0x00, 0x02, 0x00, 0x02, 0x00] : [0x00, 0x01, 0x00, 0x02, 0x00, 0x00]), "no GPS tag survives");
    assert.ok(!contains(out, text("GPSLatitude")) && !contains(out, text("Photoshop")) && !contains(out, text("http://ns.adobe.com")));
    assert.ok(contains(out, little ? [0x12, 0x01, 0x03, 0x00, 0x01, 0, 0, 0, 0x06, 0] : [0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, 6]), "orientation stays");
    assert.ok(contains(out, text("JFIF")));
    assert.deepEqual([...out.subarray(out.length - IMAGE.length)], IMAGE, "image data is untouched");
    assert.equal(out.length, source.length - (source.length - jpeg(little, false).length), "only the XMP and IPTC blocks are removed");
  });
}

test("leaves a JPEG without location, and anything that isn't a JPEG, alone", () => {
  const plain = new Uint8Array([0xff, 0xd8, ...segment(0xe0, [...text("JFIF"), 0]), ...IMAGE]);
  assert.equal(stripLocation(plain), null);
  assert.equal(stripLocation(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])), null);
  const once = stripLocation(jpeg(true))!;
  assert.equal(stripLocation(once), null, "stripping is complete in one pass");
});
