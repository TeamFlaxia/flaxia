export type ParentMessage =
  | { type: 'REQUEST_FULLSCREEN' }
  | { type: 'REQUEST_FRESH' }
  | { type: 'POST_SCORE'; score: number; label: string };

export type SandboxMessage =
  | { type: 'FULLSCREEN_GRANTED' }
  | { type: 'FULLSCREEN_DENIED' }
  | { type: 'FRESH_GRANTED' }
  | { type: 'FRESH_DENIED' }
  | { type: 'SCORE_SUBMITTED'; score: number; label: string };

export function isParentMessage(msg: unknown): msg is ParentMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as any;

  switch (m.type) {
    case 'REQUEST_FULLSCREEN':
      return true;
    case 'REQUEST_FRESH':
      return true;
    case 'POST_SCORE':
      return typeof m.score === 'number' && !Number.isNaN(m.score) && typeof m.label === 'string';
    default:
      return false;
  }
}

export function isSandboxMessage(msg: unknown): msg is SandboxMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as any;

  switch (m.type) {
    case 'FULLSCREEN_GRANTED':
    case 'FULLSCREEN_DENIED':
    case 'FRESH_GRANTED':
    case 'FRESH_DENIED':
      return true;
    case 'SCORE_SUBMITTED':
      return typeof m.score === 'number' && !Number.isNaN(m.score) && typeof m.label === 'string';
    default:
      return false;
  }
}
