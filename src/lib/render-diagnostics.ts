/**
 * Opt-in render diagnostics.
 *
 * Enable with `?render-debug=1` (or `window.__FLXIA_RENDER_DEBUG__ = true`).
 * The report explains layout shifts by naming the moved node, which is the part
 * the generic CLS number never tells you. It also records reserved-box drift:
 * a `.fx-box` that changes height after mount is the signature of a late image,
 * ad or iframe.
 */

export interface LayoutShiftSample {
  value: number;
  at: number;
  sources: string[];
}

export interface LongTaskSample {
  duration: number;
  at: number;
}

export interface BoxIssue {
  selector: string;
  expectedHeight: number;
  actualHeight: number;
  delta: number;
}

export interface RenderDiagnosticsReport {
  cls: number;
  lcp: number;
  shifts: LayoutShiftSample[];
  longTasks: LongTaskSample[];
  boxes: BoxIssue[];
}

interface LayoutShiftEntry extends PerformanceEntry {
  value?: number;
  hadRecentInput?: boolean;
  sources?: Array<{ node?: Node | null }>;
}

interface LayoutShiftInit extends PerformanceObserverInit {
  type: string;
  buffered?: boolean;
}

const shifts: LayoutShiftSample[] = [];
const longTasks: LongTaskSample[] = [];
const boxSnapshots = new Map<Element, number>();

let started = false;
let cls = 0;
let lcp = 0;

function isEnabled(): boolean {
  if (typeof window === 'undefined') return false;

  const forced = (window as unknown as { __FLXIA_RENDER_DEBUG__?: boolean }).__FLXIA_RENDER_DEBUG__;
  if (forced === true) return true;

  try {
    return new URLSearchParams(window.location.search).get('render-debug') === '1';
  } catch {
    return false;
  }
}

function describeNode(node: Node | null | undefined): string {
  if (!node) return 'unknown';

  if (node.nodeType === 1) {
    const element = node as Element;
    const id = element.id ? `#${element.id}` : '';
    const className = typeof element.className === 'string' ? element.className.trim() : '';
    const classes = className ? `.${className.split(/\s+/).join('.')}` : '';
    return `${element.tagName.toLowerCase()}${id}${classes}`;
  }

  return node.nodeName.toLowerCase();
}

function observe(type: string, handle: (entry: PerformanceEntry) => void): void {
  if (typeof PerformanceObserver === 'undefined') return;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) handle(entry);
    });
    observer.observe({ type, buffered: true } as LayoutShiftInit);
  } catch {
    // `layout-shift` / `longtask` are not supported in every engine. The
    // remaining observers still provide useful data.
  }
}

function recordShifts(entry: PerformanceEntry): void {
  const shift = entry as LayoutShiftEntry;
  if (shift.hadRecentInput) return;

  const value = shift.value ?? 0;
  if (value <= 0) return;

  cls += value;
  const sample: LayoutShiftSample = {
    value,
    at: Math.round(entry.startTime),
    sources: (shift.sources ?? []).map((source) => describeNode(source.node)),
  };
  shifts.push(sample);

  console.info('[render] layout shift', sample);
}

function recordLongTask(entry: PerformanceEntry): void {
  longTasks.push({ duration: Math.round(entry.duration), at: Math.round(entry.startTime) });
}

function recordLcp(entry: PerformanceEntry): void {
  lcp = Math.round(entry.startTime);
}

/**
 * Snapshot the current height of every reserved box. Call after the first
 * paint; `auditRenderBoxes()` then reports boxes that grew or shrank.
 */
export function markRenderBoxes(root: ParentNode = document): void {
  for (const element of root.querySelectorAll('.fx-box')) {
    boxSnapshots.set(element, element.getBoundingClientRect().height);
  }
}

export function auditRenderBoxes(root: ParentNode = document): BoxIssue[] {
  const issues: BoxIssue[] = [];

  for (const element of root.querySelectorAll('.fx-box')) {
    const expected = boxSnapshots.get(element);
    if (expected === undefined || !element.isConnected) continue;

    const actual = element.getBoundingClientRect().height;
    const delta = actual - expected;
    if (Math.abs(delta) <= 0.5) continue;

    issues.push({
      selector: describeNode(element),
      expectedHeight: Math.round(expected * 100) / 100,
      actualHeight: Math.round(actual * 100) / 100,
      delta: Math.round(delta * 100) / 100,
    });
  }

  if (issues.length > 0) {
    console.warn('[render] reserved boxes changed size after mount', issues);
  }
  return issues;
}

export function getRenderReport(): RenderDiagnosticsReport {
  return {
    cls: Math.round(cls * 1000) / 1000,
    lcp,
    shifts: [...shifts],
    longTasks: [...longTasks],
    boxes: auditRenderBoxes(),
  };
}

export function startRenderDiagnostics(): void {
  if (started || !isEnabled()) return;
  started = true;

  observe('layout-shift', recordShifts);
  observe('longtask', recordLongTask);
  observe('largest-contentful-paint', recordLcp);

  const snapshot = (): void => {
    markRenderBoxes();
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(snapshot));
  } else {
    window.setTimeout(snapshot, 32);
  }

  window.setTimeout(() => {
    auditRenderBoxes();
  }, 1000);

  window.addEventListener(
    'pagehide',
    () => {
      console.info('[render] diagnostics report', getRenderReport());
    },
    { once: true },
  );

  (window as unknown as { __flaxiaRender?: unknown }).__flaxiaRender = {
    report: getRenderReport,
    audit: auditRenderBoxes,
    mark: markRenderBoxes,
  };
}
