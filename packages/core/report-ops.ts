/**
 * Ops alerting — pushes non-fatal operational warnings/errors to the owner's
 * Pushover so they don't die unnoticed in Vercel function logs.
 *
 * Designed to be dropped into a swallowed catch block alongside the existing
 * console.warn — it is best-effort and NEVER throws:
 *
 *   } catch (err) {
 *     const msg = err instanceof Error ? err.message : String(err);
 *     console.warn('[routing-analytics] recordTaskOutcome failed:', msg);
 *     void reportOps({ source: 'routing-analytics', message: 'recordTaskOutcome failed', detail: msg });
 *     return false;
 *   }
 *
 * Lives in @buildd/core (not apps/web) so both serverless functions and the
 * external runner can call it; core can't import the web-only pushover.ts, so
 * this POSTs the Pushover API directly.
 *
 * Env:
 *   OPS_ALERTS_ENABLED   — must be truthy, else reportOps is a no-op (keeps it
 *                          dark for deploys/runners that haven't opted in)
 *   PUSHOVER_USER        — owner user key (shared with pushover.ts)
 *   PUSHOVER_TOKEN_ALERT — "alerts" app token (falls back to PUSHOVER_TOKEN)
 *   OPS_THROTTLE_MS      — dedup window per source+message (default 1h)
 *
 * Severity → Pushover priority: warning = -2 (badge only, no notification),
 * error = 0 (normal notification), critical = 1 (high-priority, bypasses the
 * recipient's quiet hours — reserve for systemic breakage). Dedup state lives in
 * the systemCache table (atomic insert/claim) so it survives across stateless
 * serverless invocations.
 */

import { createHash } from 'crypto';
import { lt } from 'drizzle-orm';
import { db } from './db';
import { systemCache } from './db/schema';

export type OpsSeverity = 'warning' | 'error' | 'critical';

/** Pushover priority for each severity. */
const SEVERITY_PRIORITY: Record<OpsSeverity, -2 | 0 | 1> = {
  warning: -2, // badge only, no notification
  error: 0, // normal notification
  critical: 1, // high-priority, bypasses quiet hours
};

export interface ReportOpsInput {
  /** Short stable identifier for the call site, e.g. 'routing-analytics'. */
  source: string;
  /** Human-readable summary (kept stable for dedup; put variable bits in detail). */
  message: string;
  /** 'warning' (silent, default), 'error' (normal), or 'critical' (high-priority). */
  severity?: OpsSeverity;
  /** Optional extra context (error.message, ids) — not part of the dedup key. */
  detail?: string;
  /** Override the auto dedup key (source|message) for coarser/finer grouping. */
  dedupeKey?: string;
}

const DEFAULT_THROTTLE_MS = 60 * 60 * 1000; // 1h

function isEnabled(): boolean {
  const v = process.env.OPS_ALERTS_ENABLED;
  return v === '1' || v === 'true' || v === 'yes';
}

function throttleMs(): number {
  const n = Number(process.env.OPS_THROTTLE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THROTTLE_MS;
}

/**
 * Atomically claim the dedup slot for this key. Returns true if this caller
 * won the slot (no live row existed) and should send; false if a still-valid
 * row exists (suppress). Postgres returns a row from RETURNING only when the
 * INSERT actually inserts or the ON CONFLICT update's WHERE matches (i.e. the
 * existing row has expired), giving exactly-once delivery per window.
 */
async function claimSlot(key: string, now: Date, expiresAt: Date, payload: unknown): Promise<boolean> {
  const claimed = await db
    .insert(systemCache)
    .values({ key, value: payload as any, updatedAt: now, expiresAt })
    .onConflictDoUpdate({
      target: systemCache.key,
      set: { value: payload as any, updatedAt: now, expiresAt },
      setWhere: lt(systemCache.expiresAt, now),
    })
    .returning({ key: systemCache.key });
  return claimed.length > 0;
}

async function sendPushover(title: string, message: string, priority: -2 | 0 | 1): Promise<void> {
  const user = process.env.PUSHOVER_USER;
  const token = process.env.PUSHOVER_TOKEN_ALERT || process.env.PUSHOVER_TOKEN;
  if (!user || !token) return;
  await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, user, title, message, priority }),
  });
}

/**
 * Best-effort ops alert. Never throws. Returns true if a Pushover message was
 * sent, false if gated off, deduped within the window, or delivery failed.
 */
export async function reportOps(input: ReportOpsInput): Promise<boolean> {
  try {
    if (!isEnabled()) return false;

    const severity: OpsSeverity = input.severity ?? 'warning';
    const dedupeBasis = input.dedupeKey ?? `${input.source}|${input.message}`;
    const hash = createHash('sha256').update(dedupeBasis).digest('hex').slice(0, 16);
    const key = `ops:${hash}`;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + throttleMs());

    const won = await claimSlot(key, now, expiresAt, {
      source: input.source,
      message: input.message,
      severity,
      lastSeen: now.toISOString(),
    });
    if (!won) return false;

    const title = `[ops] ${input.source}`;
    const message = input.detail ? `${input.message}\n${input.detail}` : input.message;
    await sendPushover(title, message, SEVERITY_PRIORITY[severity]);
    return true;
  } catch {
    // Never let ops alerting break the caller's path.
    return false;
  }
}
