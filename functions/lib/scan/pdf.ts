// Step 3 (PDF): pull the text-showing operators out of a PDF's content
// streams so identical/similar documents share a text hash.
//
// This is deliberately not a full PDF parser: streams are located by scanning,
// FlateDecode payloads are inflated with a hard output ceiling, and only
// streams that look like page content (BT ... ET) contribute text. The result
// is deterministic for identical bytes, which is all the blocklist needs.

import { unzlibSync } from 'fflate';

/** Cap for a single inflated content stream. */
const MAX_STREAM_OUTPUT = 4 * 1024 * 1024;
/** Cap on inflated input per stream (bombs start small but not this small). */
const MAX_STREAM_INPUT = 4 * 1024 * 1024;
/** How many streams we are willing to inspect. */
const MAX_STREAMS = 512;
/** Cap on the normalized text used for hashing. */
export const MAX_PDF_TEXT = 256 * 1024;

const decoder = new TextDecoder('latin1');
const utf16be = new TextDecoder('utf-16be');

function bytesToLatin1(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Inflate a zlib stream into a reused, zeroed buffer (bounded output). */
function inflateBounded(compressed: Uint8Array, scratch: Uint8Array): Uint8Array | null {
  try {
    scratch.fill(0);
    const out = unzlibSync(compressed, { out: scratch });
    return out;
  } catch {
    return null;
  }
}

/** Read a PDF literal string starting at the `(`; returns [text, nextIndex]. */
function readLiteral(data: string, start: number): [string, number] {
  let depth = 0;
  let i = start;
  let out = '';
  while (i < data.length) {
    const c = data[i];
    if (c === '\\') {
      const next = data[i + 1];
      i += 2;
      if (next === undefined) break;
      if (next >= '0' && next <= '7') {
        let oct = next;
        for (let k = 0; k < 2 && i < data.length && data[i] >= '0' && data[i] <= '7'; k++) {
          oct += data[i];
          i++;
        }
        out += String.fromCharCode(Number.parseInt(oct, 8) & 0xff);
      } else if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === 'b') out += '\b';
      else if (next === 'f') out += '\f';
      else if (next === '\n') {
        // line continuation
      } else if (next === '\r') {
        if (data[i] === '\n') i++;
      } else out += next;
      continue;
    }
    if (c === '(') {
      depth++;
      if (depth === 1) {
        i++;
        continue;
      }
    } else if (c === ')') {
      depth--;
      if (depth === 0) {
        i++;
        return [out, i];
      }
    }
    if (depth >= 1) out += c;
    i++;
  }
  return [out, i];
}

/** Read a PDF hex string starting at `<`; returns [text, nextIndex]. */
function readHex(data: string, start: number): [string, number] {
  let i = start + 1;
  let digits = '';
  while (i < data.length && data[i] !== '>') {
    const c = data[i];
    if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) digits += c;
    i++;
  }
  i++; // consume '>'
  if (digits.length % 2 === 1) digits += '0';
  let out = '';
  for (let k = 0; k < digits.length; k += 2) {
    out += String.fromCharCode(Number.parseInt(digits.slice(k, k + 2), 16));
  }
  return [out, i];
}

/** True when the stream has both a text block opener and closer. */
function looksLikeContent(text: string): boolean {
  return text.includes('BT') && text.includes('ET');
}

/**
 * Extract text-showing operators (Tj, TJ, ', ") from a content stream.
 * Strings in other contexts are dropped; TJ kerning numbers are ignored.
 */
function extractText(content: string): string[] {
  const pieces: string[] = [];
  let pending: string[] = [];
  let i = 0;

  const flushText = (): void => {
    if (pending.length > 0) {
      pieces.push(pending.join(''));
      pending = [];
    }
  };

  while (i < content.length) {
    const c = content[i];
    if (c === '(') {
      const [text, next] = readLiteral(content, i);
      pending.push(text);
      i = next;
      continue;
    }
    if (c === '<') {
      if (content[i + 1] === '<') {
        i += 2;
        continue;
      }
      const [text, next] = readHex(content, i);
      pending.push(text);
      i = next;
      continue;
    }
    if (c === '%') {
      // comment to end of line
      while (i < content.length && content[i] !== '\n' && content[i] !== '\r') i++;
      continue;
    }
    if (/[A-Za-z'"]/.test(c)) {
      let j = i;
      while (j < content.length && /[A-Za-z0-9'"*]/.test(content[j])) j++;
      const op = content.slice(i, j);
      if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
        flushText();
      } else {
        // Any other operator ends the relevance of collected strings.
        pending = [];
      }
      i = j;
      continue;
    }
    i++;
  }
  flushText();
  return pieces;
}

/** Decode one extracted string: UTF-16BE when BOM'd, latin1 otherwise. */
function decodePdfString(raw: string): string {
  if (raw.length >= 2 && raw.charCodeAt(0) === 0xfe && raw.charCodeAt(1) === 0xff) {
    const bytes = new Uint8Array(raw.length - 2);
    for (let i = 2; i < raw.length; i++) bytes[i - 2] = raw.charCodeAt(i) & 0xff;
    return utf16be.decode(bytes);
  }
  return raw;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract normalized document text from a PDF, or null when the file is not a
 * PDF. Capped at MAX_PDF_TEXT characters; truncation is deterministic.
 */
export function extractPdfText(bytes: Uint8Array): string | null {
  // The header must appear within the first 1024 bytes (PDF spec tolerates
  // leading junk for mail gateways).
  const head = bytesToLatin1(bytes.subarray(0, Math.min(1024, bytes.length)));
  if (!head.includes('%PDF-')) return null;

  const raw = bytesToLatin1(bytes);
  const scratch = new Uint8Array(MAX_STREAM_OUTPUT);
  const collected: string[] = [];
  let total = 0;
  let streams = 0;

  let cursor = 0;
  while (streams < MAX_STREAMS && total < MAX_PDF_TEXT) {
    const idx = raw.indexOf('stream', cursor);
    if (idx < 0) break;
    if (idx > 0 && /[A-Za-z]/.test(raw[idx - 1])) {
      cursor = idx + 6;
      continue; // part of another word (e.g. /IDStream)
    }

    // Skip the required EOL after `stream`.
    let dataStart = idx + 6;
    if (raw[dataStart] === '\r') dataStart++;
    if (raw[dataStart] === '\n') dataStart++;

    const endIdx = raw.indexOf('endstream', dataStart);
    if (endIdx < 0) break;

    // The dict just before `stream` decides how to decode.
    const dictWindow = raw.slice(Math.max(0, idx - 1024), idx);
    const lengthMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictWindow);
    let dataEnd = endIdx;
    if (lengthMatch) {
      const declaredEnd = dataStart + Number.parseInt(lengthMatch[1], 10);
      if (declaredEnd > dataStart && declaredEnd <= endIdx + 16) dataEnd = declaredEnd;
    }

    const compressed = bytes.subarray(dataStart, Math.min(dataEnd, bytes.length));
    let text: string | null = null;

    if (compressed.length <= MAX_STREAM_INPUT) {
      let decoded: Uint8Array | null = null;
      if (dictWindow.includes('/FlateDecode')) {
        decoded = inflateBounded(compressed, scratch);
      } else if (!dictWindow.includes('/Filter')) {
        decoded = compressed;
      }
      if (decoded) {
        // Streams are usually latin1-ish content operators; NULs from the
        // reused scratch buffer are skipped by the tokenizer.
        const content = bytesToLatin1(decoded.subarray(0, MAX_STREAM_OUTPUT));
        if (looksLikeContent(content)) {
          const pieces = extractText(content);
          if (pieces.length > 0) text = pieces.map(decodePdfString).join(' ');
        }
      }
    }

    if (text) {
      collected.push(text);
      total += text.length + 1;
    }

    streams++;
    cursor = endIdx + 9;
  }

  if (collected.length === 0) return '';
  return normalize(collected.join(' ').slice(0, MAX_PDF_TEXT));
}
