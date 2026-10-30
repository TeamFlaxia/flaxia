/**
 * Post text colors (Flaxia+).
 *
 * Authors type `{red}text{/red}` into the post body. The markers are stored in
 * `posts.text` verbatim, exactly like Markdown syntax, and are only interpreted
 * when the author currently has a Flaxia+ entitlement. Keeping the parser here
 * (rather than in the renderer) lets the API, SSR, ActivityPub and the SPA all
 * agree on what counts as a valid marker.
 */

export const POST_COLOR_PALETTE = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'gray',
  'mikan',
  'kimwaipu',
  'rainbow',
] as const;

export type PostColor = (typeof POST_COLOR_PALETTE)[number];

export const POST_TEXT_STYLES = [...POST_COLOR_PALETTE, 'dinnerborn'] as const;

export type PostTextStyle = (typeof POST_TEXT_STYLES)[number];

const POST_COLOR_ALIASES: Readonly<Record<string, PostTextStyle>> = {
  red: 'red',
  赤: 'red',
  orange: 'orange',
  橙: 'orange',
  yellow: 'yellow',
  黄: 'yellow',
  green: 'green',
  緑: 'green',
  blue: 'blue',
  青: 'blue',
  purple: 'purple',
  紫: 'purple',
  pink: 'pink',
  桃: 'pink',
  gray: 'gray',
  grey: 'gray',
  灰: 'gray',
  mikan: 'mikan',
  蜜柑: 'mikan',
  kimwaipu: 'kimwaipu',
  キムワイプ: 'kimwaipu',
  rainbow: 'rainbow',
  虹: 'rainbow',
  dinnerborn: 'dinnerborn',
  dinnerbone: 'dinnerborn',
};

/** Resolve a user-typed marker name to a palette color or the upside-down style. */
export function normalizePostTextStyle(value: string): PostTextStyle | null {
  if (!value) return null;
  return POST_COLOR_ALIASES[value.toLowerCase()] ?? null;
}

/** CSS class for a style span. `dinnerborn` is a transform, not a color. */
export function postTextStyleClass(style: PostTextStyle): string {
  return style === 'dinnerborn' ? 'post-dinnerborn' : `post-color--${style}`;
}

export interface PostColorSpan {
  /** Start offset in the marker-free text. */
  start: number;
  /** End offset (exclusive) in the marker-free text. */
  end: number;
  style: PostTextStyle;
  /** 0 = outermost span. Used to restore nested spans in the right order. */
  depth: number;
}

export interface PostColorParseResult {
  /** Text with all *valid* color markers removed; invalid markers stay literal. */
  plain: string;
  spans: PostColorSpan[];
}

interface SourceSpan {
  style: PostTextStyle;
  depth: number;
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
}

interface OpenMarker {
  style: PostTextStyle;
  depth: number;
  markerStart: number;
  contentStart: number;
}

interface Marker {
  kind: 'open' | 'close';
  style: PostTextStyle;
  end: number;
}

function readMarker(text: string, index: number): Marker | null {
  const closeBrace = text.indexOf('}', index + 1);
  if (closeBrace === -1) return null;
  const inner = text.slice(index + 1, closeBrace);
  // Longest accepted name is "orange"/"yellow"/"purple"; this also bounds work.
  if (!inner || inner.length > 12 || /\s/.test(inner)) return null;

  let kind: Marker['kind'] = 'open';
  let name = inner;
  if (inner.startsWith('/')) {
    kind = 'close';
    name = inner.slice(1);
  }
  if (!name) return null;

  const style = normalizePostTextStyle(name);
  if (!style) return null;
  return { kind, style, end: closeBrace + 1 };
}

/**
 * Lines that start a new Markdown block. A color span must not cross one: the
 * client renders a span into the DOM, and wrapping across block elements would
 * produce invalid HTML (and is impossible to express in the composer anyway).
 */
function isBlockBoundaryLine(line: string): boolean {
  if (/^\s*$/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/.test(line)) return true;
  if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return true;
  if (/^ {0,3}\|/.test(line)) return true;
  return false;
}

function findBacktickRun(text: string, from: number, length: number, end: number): number {
  for (let i = from; i < end; i++) {
    if (text[i] !== '`') continue;
    let run = 1;
    while (i + run < end && text[i + run] === '`') run++;
    if (run === length) return i;
    i += run - 1;
  }
  return -1;
}

/**
 * Parse color markers in a post body.
 *
 * Valid pairs are removed from `plain`; malformed, escaped, code/math and
 * block-crossing markers remain as literal text. This is deliberately
 * forgiving: a typo should never make a post disappear or turn into HTML.
 */
export function parsePostColors(text: string): PostColorParseResult {
  const spans: SourceSpan[] = [];
  const stack: OpenMarker[] = [];
  let i = 0;
  let atLineStart = true;
  let fence: { char: string; length: number } | null = null;

  const clearOpenMarkers = () => {
    stack.length = 0;
  };

  while (i < text.length) {
    if (atLineStart) {
      const lineEnd = text.indexOf('\n', i);
      const end = lineEnd === -1 ? text.length : lineEnd;
      const line = text.slice(i, end);
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);

      if (fence) {
        if (
          fenceMatch &&
          fenceMatch[1][0] === fence.char &&
          fenceMatch[1].length >= fence.length &&
          /^ {0,3}[`~]+\s*$/.test(line)
        ) {
          fence = null;
        }
        i = lineEnd === -1 ? end : end + 1;
        atLineStart = true;
        continue;
      }

      if (fenceMatch) {
        clearOpenMarkers();
        fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
        i = lineEnd === -1 ? end : end + 1;
        atLineStart = true;
        continue;
      }

      // Markdown's indented code block. (A list continuation indented by four
      // spaces is conservatively treated as code too.)
      if (/^ {4}/.test(line)) {
        clearOpenMarkers();
        i = lineEnd === -1 ? end : end + 1;
        atLineStart = true;
        continue;
      }

      if (isBlockBoundaryLine(line)) {
        clearOpenMarkers();
      }
      atLineStart = false;
    }

    const ch = text[i];

    if (ch === '\n') {
      i++;
      atLineStart = true;
      continue;
    }

    // `\{` is a literal brace, not the start of a marker.
    if (ch === '\\' && text[i + 1] === '{') {
      i += 2;
      continue;
    }

    // Inline code: skip to the matching backtick run on this line.
    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const lineEnd = text.indexOf('\n', i);
      const end = lineEnd === -1 ? text.length : lineEnd;
      const close = findBacktickRun(text, i + run, run, end);
      i = close === -1 ? end : close + run;
      continue;
    }

    // Math is handled by the SPA before color parsing, but SSR and metadata
    // helpers call this parser directly. Skip simple $...$ / $$...$$ spans so
    // LaTeX braces are never mistaken for color markers.
    if (ch === '$') {
      if (text[i + 1] === '$') {
        const close = text.indexOf('$$', i + 2);
        if (close !== -1) {
          i = close + 2;
          continue;
        }
      } else {
        const close = text.indexOf('$', i + 1);
        if (close !== -1) {
          i = close + 1;
          continue;
        }
      }
      i++;
      continue;
    }

    if (ch === '{') {
      const marker = readMarker(text, i);
      if (marker) {
        if (marker.kind === 'open') {
          stack.push({
            style: marker.style,
            depth: stack.length,
            markerStart: i,
            contentStart: marker.end,
          });
        } else {
          const top = stack[stack.length - 1];
          if (top && top.style === marker.style) {
            stack.pop();
            spans.push({
              style: top.style,
              depth: top.depth,
              openStart: top.markerStart,
              openEnd: top.contentStart,
              closeStart: i,
              closeEnd: marker.end,
            });
          }
        }
        i = marker.end;
        continue;
      }
    }

    i++;
  }

  const markerRanges: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    markerRanges.push({ start: span.openStart, end: span.openEnd });
    markerRanges.push({ start: span.closeStart, end: span.closeEnd });
  }
  markerRanges.sort((a, b) => a.start - b.start);

  let plain = '';
  let position = 0;
  const removed: Array<{ start: number; end: number }> = [];
  for (const range of markerRanges) {
    if (range.start < position) continue;
    plain += text.slice(position, range.start);
    position = range.end;
    removed.push(range);
  }
  plain += text.slice(position);

  const mapOffset = (offset: number): number => {
    let removedLength = 0;
    for (const range of removed) {
      if (range.end <= offset) removedLength += range.end - range.start;
      else break;
    }
    return offset - removedLength;
  };

  return {
    plain,
    spans: spans.map((span) => ({
      start: mapOffset(span.openEnd),
      end: mapOffset(span.closeStart),
      style: span.style,
      depth: span.depth,
    })),
  };
}

/** True when the text contains at least one well-formed color span. */
export function hasPostColors(text: string): boolean {
  return parsePostColors(text).spans.length > 0;
}

/** Marker-free text for metadata, notifications, ActivityPub, embeddings, etc. */
export function stripPostColors(text: string): string {
  return parsePostColors(text).plain.replace(/\\\{/g, '{');
}
