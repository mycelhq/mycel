// A tenant's logo bytes → something a PDF can hold.
//
// PDF has no notion of "a PNG". It has image XObjects with an explicit colour space, bit depth and
// stream filter. JPEG is nearly free because DCTDecode is the JPEG entropy coding itself, so the
// bytes pass through untouched. PNG is not: PDF's FlateDecode is zlib, which PNG also uses, but PNG
// interleaves a per-row filter byte and puts alpha in the same stream as colour, and PDF wants alpha
// as a separate soft mask. So a PNG is inflated, unfiltered, split, and re-deflated once.
//
// Everything unsupported returns undefined rather than throwing, and the caller falls back to the
// wordmark. A logo that cannot be embedded must degrade to a business's name in its own typeface —
// never to an empty rectangle, and never to a failed render of an invoice somebody is waiting on.
import { deflateSync, inflateSync } from "node:zlib";

export interface EmbeddableImage {
  width: number;
  height: number;
  colorSpace: "DeviceGray" | "DeviceRGB" | "DeviceCMYK";
  bitsPerComponent: number;
  filter: "DCTDecode" | "FlateDecode";
  data: Buffer;
  /** 8-bit alpha, one byte per pixel, FlateDecode'd. Present only when the source had alpha. */
  smask?: Buffer;
}

export function decodeImage(mime: string, base64: string): EmbeddableImage | undefined {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return undefined;
  }
  if (bytes.length === 0) return undefined;
  try {
    if (mime === "image/jpeg") return decodeJpeg(bytes);
    if (mime === "image/png") return decodePng(bytes);
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * JPEG: pass the bytes through, but read the frame header for the true size and channel count.
 *
 * The size is read here rather than trusted from the kit because /Width and /Height in the XObject
 * dictionary must match the compressed data — a reader given a lie renders garbage or nothing.
 */
function decodeJpeg(b: Buffer): EmbeddableImage | undefined {
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1];
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15, excluding the arithmetic/huffman table markers that share the range.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const precision = b[i + 4];
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      const components = b[i + 9];
      const colorSpace = components === 1 ? "DeviceGray" : components === 3 ? "DeviceRGB" : components === 4 ? "DeviceCMYK" : undefined;
      if (!colorSpace || !width || !height) return undefined;
      return { width, height, colorSpace, bitsPerComponent: precision, filter: "DCTDecode", data: b };
    }
    if (marker === 0xda) return undefined; // reached the scan without a frame header
    i += 2 + len;
  }
  return undefined;
}

/** Non-interlaced, 8-bit, greyscale / greyscale+alpha / truecolour / truecolour+alpha. The four a
 *  logo exported from any design tool actually is. Palette and 16-bit are refused. */
function decodePng(b: Buffer): EmbeddableImage | undefined {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return undefined;

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  let p = 8;
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString("latin1", p + 4, p + 8);
    const body = b.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      if (body[12] !== 0) return undefined; // interlaced
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    p += 12 + len;
  }
  if (bitDepth !== 8 || !width || !height) return undefined;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels || idat.length === 0) return undefined;

  const raw = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels);
  if (!raw) return undefined;

  const hasAlpha = colorType === 4 || colorType === 6;
  const colorChannels = hasAlpha ? channels - 1 : channels;
  const pixels = width * height;
  const color = Buffer.alloc(pixels * colorChannels);
  const alpha = hasAlpha ? Buffer.alloc(pixels) : undefined;
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < colorChannels; c++) color[i * colorChannels + c] = raw[i * channels + c];
    if (alpha) alpha[i] = raw[i * channels + colorChannels];
  }
  return {
    width,
    height,
    colorSpace: colorChannels === 1 ? "DeviceGray" : "DeviceRGB",
    bitsPerComponent: 8,
    filter: "FlateDecode",
    data: deflateSync(color),
    smask: alpha ? deflateSync(alpha) : undefined,
  };
}

/** Undo PNG's five per-row filters. Textbook, and the one place a byte-level mistake shows up as a
 *  logo that looks like television static. */
function unfilter(data: Buffer, width: number, height: number, channels: number): Buffer | undefined {
  const stride = width * channels;
  if (data.length < height * (stride + 1)) return undefined;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const type = data[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = data[src + x];
      const a = x >= channels ? out[dst + x - channels] : 0;
      const bUp = y > 0 ? out[up + x] : 0;
      const c = y > 0 && x >= channels ? out[up + x - channels] : 0;
      let value: number;
      switch (type) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + bUp; break;
        case 3: value = rawByte + ((a + bUp) >> 1); break;
        case 4: {
          const pa = Math.abs(bUp - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + bUp - 2 * c);
          value = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? bUp : c);
          break;
        }
        default: return undefined;
      }
      out[dst + x] = value & 0xff;
    }
  }
  return out;
}
