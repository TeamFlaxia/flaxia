// Image dimension validation for uploaded attachments.
//
// Browsers rasterize images at native resolution. Huge-dimension images (or
// oversized animated GIFs) can exhaust renderer memory and crash tabs
// (Chrome: "Aw, Snap!"), so we reject them at upload time before anything is
// stored or served to the timeline.

export const MAX_IMAGE_DIMENSION = 6000; // per-edge, px
export const MAX_IMAGE_PIXELS = 24 * 1024 * 1024; // width * height

function readU16BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000;
}

export type ImageDimensions = { width: number; height: number };

// Parse native image dimensions from the file header without full decode.
// Returns null when the file is not a supported image or cannot be parsed
// (malformed headers are not our problem — the browser will reject those).
export function parseImageDimensions(data: ArrayBuffer, mime: string): ImageDimensions | null {
  try {
    const bytes = new Uint8Array(data);
    if (mime === 'image/png') {
      // IHDR chunk: "PNG\r\n\x1a\n" (8) + "IHDR" (4) then width @16, height @20
      if (bytes.length >= 24) {
        return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
      }
    } else if (mime === 'image/gif') {
      // "GIF87a"/"GIF89a" then width uint16LE @6, height @8
      if (bytes.length >= 10) {
        return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
      }
    } else if (mime === 'image/jpeg') {
      // Walk segments looking for an SOFn marker; guard against malformed data.
      if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 4 <= bytes.length) {
          if (bytes[offset] !== 0xff) {
            offset++;
            continue;
          }
          const marker = bytes[offset + 1];
          // Standalone markers (SOI, RSTn) carry no length.
          if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2;
            continue;
          }
          const length = readU16BE(bytes, offset + 2);
          if (length < 2) return null;
          const isSof =
            (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf);
          if (isSof) {
            if (offset + 9 > bytes.length) return null;
            // SOFn payload: precision(1) height(2) width(2)
            return { width: readU16BE(bytes, offset + 7), height: readU16BE(bytes, offset + 5) };
          }
          offset += 2 + length;
        }
      }
    } else if (mime === 'image/webp') {
      // "RIFF" + size + "WEBP"
      if (bytes.length >= 16 && readU32BE(bytes, 0) === 0x52494646) {
        const chunkId = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
        if (chunkId === 'VP8X') {
          // Extended format: 24-bit LE canvas dimensions (+1) @24 (w) and @27 (h)
          if (bytes.length >= 30) {
            return { width: readU24LE(bytes, 24) + 1, height: readU24LE(bytes, 27) + 1 };
          }
        }
        if (chunkId === 'VP8L') {
          // Lossless: signature 0x2f @20, then width/height packed as 14-bit LE values.
          if (bytes.length >= 25 && bytes[20] === 0x2f) {
            const widthMinusOne = bytes[21] | ((bytes[22] & 0x3f) << 8);
            const heightMinusOne = ((bytes[22] >> 6) & 0x03) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10);
            return { width: widthMinusOne + 1, height: heightMinusOne + 1 };
          }
        }
        if (chunkId === 'VP8 ') {
          // Lossy: 3-byte frame tag @23..25, then width uint16LE @26, height @28
          if (bytes.length >= 30) {
            return { width: bytes[26] | (bytes[27] << 8), height: bytes[28] | (bytes[29] << 8) };
          }
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Returns an error message when an uploaded image exceeds the caps, otherwise null.
export function validateImageDimensions(data: ArrayBuffer, receivedMime: string | null): string | null {
  if (!receivedMime || !receivedMime.startsWith('image/')) return null;
  const dims = parseImageDimensions(data, receivedMime);
  if (!dims || dims.width <= 0 || dims.height <= 0) return null;
  if (dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION) {
    return `Image too large. Maximum dimensions are ${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION}px.`;
  }
  if (dims.width * dims.height > MAX_IMAGE_PIXELS) {
    return `Image too large. Maximum pixel count is ${MAX_IMAGE_PIXELS / (1024 * 1024)} megapixels.`;
  }
  return null;
}
