/**
 * The runner's periodic "runner alive" liveness heartbeat (index.ts) was
 * measured at 26% of the entire log — one distinct message, ticking every
 * 60s, whose only informational branch (DEGRADED) has never fired. It was
 * also the log's only clock (most lines carry no timestamp), so it could not
 * be reduced before every log line had its own timestamp (see log.ts).
 *
 * With that shim in place, routine "alive" ticks can collapse into an
 * occasional summary instead of one line every 60s. DEGRADED is never
 * collapsed — a degraded window is exactly the diagnostic signal the
 * collapse rule exists to protect, not erase.
 */
import { collapseTick, logInfo, logError } from './log';

const HEARTBEAT_ALIVE_COLLAPSE_WINDOW_MS = 15 * 60_000;
const HEARTBEAT_ALIVE_KEY = 'heartbeat-alive';

export function emitHeartbeatTick(degraded: boolean, degradedDetail: string, now: number = Date.now()): void {
  if (degraded) {
    logError(`[heartbeat] DEGRADED — ${degradedDetail}`);
    return;
  }
  const tick = collapseTick(HEARTBEAT_ALIVE_KEY, HEARTBEAT_ALIVE_COLLAPSE_WINDOW_MS, now);
  if (tick.kind === 'emit') {
    logInfo('[heartbeat] runner alive');
  } else if (tick.kind === 'summary') {
    const { suppressed, windowMs, firstTs, lastTs } = tick.summary;
    logInfo(
      `[heartbeat] runner alive (+${suppressed} in last ${Math.round(windowMs / 60_000)}m, ${new Date(firstTs).toISOString()}–${new Date(lastTs).toISOString()})`,
    );
  }
  // 'suppressed' -> nothing this tick; folded into the next summary.
}
