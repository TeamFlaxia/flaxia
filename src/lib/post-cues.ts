/**
 * Post media cues (Niconico-style timed comments).
 *
 * Authors type timed comments directly into the post body, one per line:
 *
 *   Under 01:36.12 text   → bottom subtitle at 1:36.12
 *   Over  01:36.12 text   → top subtitle at 1:36.12
 *   01:36.12 text         → danmaku (scrolls right-to-left) at 1:36.12
 *   Scroll 01:36.12 text  → explicit danmaku, same as the bare form
 *
 * The timestamp is `MM:SS.cc`: total minutes (may exceed 59), seconds 00-59,
 * centiseconds exactly two digits. Markers are stored verbatim in
 * `posts.text`, exactly like Markdown syntax, and are never sent to or read
 * by the database. The SPA strips cue lines from the visible body and feeds
 * them to the media overlay instead; every plain-text output (SSR, meta
 * descriptions, notifications, ActivityPub, share sheets) strips them too so
 * readers never see the markers unless they typed them themselves.
 *
 * This is deliberately forgiving: a malformed cue line stays as literal text.
 */

export type MediaCueKind = 'danmaku' | 'top' | 'bottom';

export interface MediaCue {
  /** Milliseconds from the start of the media. */
  timeMs: number;
  /** Raw cue body (may contain inline Markdown and `$math$`). */
  text: string;
  kind: MediaCueKind;
}

export interface MediaCueParseResult {
  /** Text with all cue lines removed (escaped cue-like lines keep their text, minus the backslash). */
  plain: string;
  cues: MediaCue[];
}

// Keyword is optional; bare lines are danmaku. Seconds must be 00-59 and the
// fraction exactly two digits (centiseconds). Up to 3 leading spaces, matching
// how Markdown allows indentation before block markers.
const CUE_RE = /^ {0,3}(?:(over|under|scroll)[ \t]+)?(\d{1,4}):([0-5]?\d)\.(\d{2})[ \t]+(.+)$/i;

// `\01:36.12 ...` (or `\Under 01:36.12 ...`) renders as literal text.
const ESCAPE_RE = /^ {0,3}\\(?=(?:(?:over|under|scroll)[ \t]+)?\d{1,4}:[0-5]?\d\.\d{2}[ \t])/i;

function matchFence(line: string): { char: string; length: number } | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return m ? { char: m[1][0], length: m[1].length } : null;
}

export function parseMediaCues(text: string): MediaCueParseResult {
  if (!text) return { plain: text, cues: [] };

  const plainLines: string[] = [];
  const cues: MediaCue[] = [];
  let fence: { char: string; length: number } | null = null;

  for (const line of text.split('\n')) {
    const fenceLine = matchFence(line);

    if (fence) {
      plainLines.push(line);
      if (
        fenceLine &&
        fenceLine.char === fence.char &&
        fenceLine.length >= fence.length &&
        /^ {0,3}[`~]+\s*$/.test(line)
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceLine) {
      fence = fenceLine;
      plainLines.push(line);
      continue;
    }
    // Indented code block: never a cue.
    if (/^( {4}|\t)/.test(line)) {
      plainLines.push(line);
      continue;
    }
    // Escaped cue-like line: literal text, drop the backslash.
    if (ESCAPE_RE.test(line)) {
      plainLines.push(line.replace(/^( {0,3})\\/, '$1'));
      continue;
    }

    const m = CUE_RE.exec(line);
    if (!m) {
      plainLines.push(line);
      continue;
    }
    const [, keyword, mm, ss, cc, body] = m;
    const minutes = Number(mm);
    const seconds = Number(ss);
    const centiseconds = Number(cc);
    const cueBody = body.trim();
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds > 59 || !cueBody) {
      plainLines.push(line);
      continue;
    }
    const kw = keyword?.toLowerCase();
    cues.push({
      timeMs: (minutes * 60 + seconds) * 1000 + centiseconds * 10,
      text: cueBody,
      kind: kw === 'over' ? 'top' : kw === 'under' ? 'bottom' : 'danmaku',
    });
    // Cue lines are not part of the visible body.
  }

  // Stable sort by timestamp; equal-time cues keep their line order.
  const sorted = cues
    .map((cue, index) => ({ cue, index }))
    .sort((a, b) => a.cue.timeMs - b.cue.timeMs || a.index - b.index)
    .map(({ cue }) => cue);

  return { plain: plainLines.join('\n'), cues: sorted };
}

/** Text with cue lines removed, for metadata, notifications, SSR and the visible body. */
export function stripMediaCues(text: string): string {
  return parseMediaCues(text).plain;
}
