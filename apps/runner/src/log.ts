/**
 * Lightweight structured logging shim for the runner.
 *
 * Every line carries an ISO timestamp and a short (8-char) correlation id
 * instead of the old `[Worker <full-uuid>] ` prefix — that literal was a
 * fixed 46 bytes on tens of thousands of lines (~20% of the whole log).
 * Timestamps only pay for themselves once that prefix shrinks to match —
 * shipping timestamps alone makes the log bigger, not smaller.
 *
 * Adopt incrementally: this does not require rewriting every existing
 * console.log call site in one pass.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  workerId?: string;
  taskId?: string;
}

function shortId(id: string | undefined): string | undefined {
  return id ? id.slice(0, 8) : undefined;
}

function formatLine(level: LogLevel, message: string, fields?: LogFields): string {
  const tags = [level.toUpperCase()];
  const w = shortId(fields?.workerId);
  const t = shortId(fields?.taskId);
  if (w) tags.push(`w:${w}`);
  if (t) tags.push(`t:${t}`);
  return `${new Date().toISOString()} [${tags.join(' ')}] ${message}`;
}

const sinks: Record<LogLevel, (msg: string) => void> = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

export function log(level: LogLevel, message: string, fields?: LogFields): void {
  sinks[level](formatLine(level, message, fields));
}

export function logInfo(message: string, fields?: LogFields): void {
  log('info', message, fields);
}

export function logWarn(message: string, fields?: LogFields): void {
  log('warn', message, fields);
}

export function logError(message: string, fields?: LogFields): void {
  log('error', message, fields);
}

// ─── Collapsing repeated events ────────────────────────────────────────────
//
// Any sampling/dedupe of a repeated line MUST carry {suppressed, windowMs,
// firstTs, lastTs} on the summary it eventually emits. A blind sample (e.g.
// 1-in-100) would render a real incident burst — 1000+ events in five
// minutes, against a median of a few dozen a day — as a dozen unremarkable
// lines, erasing the single most diagnostic window in the corpus. Counts +
// timestamps let one line reconstruct the rate instead of hiding it.

export interface CollapsedSummary {
  suppressed: number;
  windowMs: number;
  firstTs: number;
  lastTs: number;
}

interface CollapseBucket {
  firstTs: number;
  lastTs: number;
  suppressed: number;
}

const collapseBuckets = new Map<string, CollapseBucket>();

export type CollapseTick =
  | { kind: 'emit' }
  | { kind: 'summary'; summary: CollapsedSummary }
  | { kind: 'suppressed' };

/**
 * Record one occurrence of `key`. The first occurrence in a fresh window
 * emits directly; later occurrences within `windowMs` of the window's start
 * fold into a running count. The occurrence that finally crosses the window
 * boundary flushes that count as a `summary` (never silently dropped) and
 * opens a new window starting at `now`.
 */
export function collapseTick(key: string, windowMs: number, now: number = Date.now()): CollapseTick {
  const existing = collapseBuckets.get(key);
  if (!existing) {
    collapseBuckets.set(key, { firstTs: now, lastTs: now, suppressed: 0 });
    return { kind: 'emit' };
  }
  if (now - existing.firstTs >= windowMs) {
    collapseBuckets.set(key, { firstTs: now, lastTs: now, suppressed: 0 });
    if (existing.suppressed > 0) {
      return {
        kind: 'summary',
        summary: {
          suppressed: existing.suppressed,
          windowMs: existing.lastTs - existing.firstTs,
          firstTs: existing.firstTs,
          lastTs: existing.lastTs,
        },
      };
    }
    return { kind: 'emit' };
  }
  existing.lastTs = now;
  existing.suppressed++;
  return { kind: 'suppressed' };
}

/** Test-only: reset collapse state between tests. */
export function __resetCollapseState(): void {
  collapseBuckets.clear();
}

/**
 * Force-close the open window for `key`, reporting whatever was suppressed
 * so far even though the window hasn't naturally elapsed yet. Without this,
 * a burst that ends mid-window leaves its trailing suppressed count stuck
 * until (if ever) another occurrence of the same key arrives — call this on
 * a periodic tick or at shutdown so nothing is stranded unreported.
 */
export function collapseFlush(key: string, now: number = Date.now()): CollapsedSummary | null {
  const existing = collapseBuckets.get(key);
  if (!existing) return null;
  collapseBuckets.delete(key);
  if (existing.suppressed === 0) return null;
  return {
    suppressed: existing.suppressed,
    windowMs: existing.lastTs - existing.firstTs,
    firstTs: existing.firstTs,
    lastTs: existing.lastTs,
  };
}

/**
 * Log `message` at most once per `windowMs` for `key`. Occurrences folded
 * into the window are summarized (with counts) the next time the window
 * elapses — never silently dropped.
 */
export function logCollapsed(level: LogLevel, key: string, windowMs: number, message: string, fields?: LogFields): void {
  const tick = collapseTick(key, windowMs);
  if (tick.kind === 'emit') {
    log(level, message, fields);
  } else if (tick.kind === 'summary') {
    const { suppressed, windowMs: spanMs, firstTs, lastTs } = tick.summary;
    log(
      level,
      `${message} (+${suppressed} repeat(s) suppressed over ${Math.round(spanMs / 1000)}s, ${new Date(firstTs).toISOString()}–${new Date(lastTs).toISOString()})`,
      fields,
    );
  }
}
