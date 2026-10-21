// Parsers for orchestrator `container` task results. Kept free of imports
// from ../crowd.ts so the webhook dispatcher can use them without a cycle.

/** The subset of the SDK's ContainerResult the scanners care about. */
export interface ContainerOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Normalize a callback result envelope into container output. The workload's
 * payload lives under `result.output`; tolerates stringified numbers.
 */
export function parseContainerOutput(output: unknown): ContainerOutput | null {
  if (!output || typeof output !== 'object') return null;
  const record = output as Record<string, unknown>;
  const stdout = typeof record.stdout === 'string' ? record.stdout : '';
  const stderr = typeof record.stderr === 'string' ? record.stderr : '';
  const rawExit = record.exitCode;
  // #96: Number('') is 0, so a missing/empty code would read as CLEAN.
  // Only finite numbers and non-blank numeric strings are admissible.
  let exitCode = NaN;
  if (typeof rawExit === 'number') {
    exitCode = rawExit;
  } else if (typeof rawExit === 'string' && rawExit.trim() !== '') {
    exitCode = Number(rawExit);
  }
  if (!Number.isInteger(exitCode)) return null;
  return { stdout, stderr, exitCode };
}

export interface ClamavVerdict {
  status: 'clean' | 'infected' | 'failed';
  signature: string | null;
  detail: string | null;
}

/**
 * ClamAV exit codes: 0 = no findings, 1 = infected, >=2 = error.
 * `path: Signature-Name FOUND` lines carry the detection name.
 */
export function clamavVerdict(output: ContainerOutput): ClamavVerdict {
  if (output.exitCode === 0) return { status: 'clean', signature: null, detail: null };
  if (output.exitCode === 1) {
    const match = /:\s*(.+?)\s+FOUND/i.exec(output.stdout);
    return { status: 'infected', signature: match ? match[1] : 'unknown', detail: null };
  }
  const detail = (output.stderr || output.stdout).trim().slice(0, 300) || `exit ${output.exitCode}`;
  return { status: 'failed', signature: null, detail };
}

/**
 * Parse the video keyframe hasher's stdout: a JSON object with a `phashes`
 * array of 16-hex-char hashes. Returns validated hashes, or null.
 */
export function parseVideoPhashes(stdout: string): string[] | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    const list = (parsed as Record<string, unknown>).phashes;
    if (!Array.isArray(list)) return null;
    const hashes: string[] = [];
    for (const value of list) {
      if (typeof value === 'string' && /^[0-9a-f]{16}$/i.test(value)) {
        hashes.push(value.toLowerCase());
        if (hashes.length >= 32) break;
      }
    }
    return hashes.length > 0 ? hashes : null;
  } catch {
    return null;
  }
}
