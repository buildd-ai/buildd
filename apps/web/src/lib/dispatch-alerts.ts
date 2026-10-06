/**
 * Operator alerts for the Dispatch transport. Two triggers, both bug signals:
 *
 *  - alertDispatchFailed: the receipts route applied a terminal `failed`
 *    receipt. Sent when it happens, deduped per workspace.
 *  - alertFloorRepair: the hourly floor (app/api/cron/dispatch-drain) had to
 *    repair something. The floor should find nothing; any repair means a
 *    transition was missed. The backstop, not the primary signal.
 *
 * Unacked rows do not alert by themselves: the in-app drain takes them after
 * PUBLISH_GRACE_MS. Only `unackedStale` (still unacked after the floor's own
 * drain) does. Design: knowledge-base buildd/design/cloudflare-dispatch-transport.md,
 * "Observability"; contract: docs/specs/task-dispatch-authority.md.
 *
 * Dedupe is Redis and fails open: with Redis unavailable every alert is sent.
 * Ids and counts only, never task content.
 */
import type { FailedReceiptRow } from '@buildd/core/dispatch-handoff';
import type { DispatchOutboxHealth } from '@buildd/core/dispatch-outbox';
import { notifyOperator } from '@/lib/pushover';
import { delKey, getKey, setWithTtl, tryLock } from '@/lib/redis';
import type { ReconcileCounts } from '@/lib/dispatch-reconcile';

/** One alert per workspace in this window, however many wakes fail. */
export const FAILED_ALERT_TTL_SEC = 3 * 3600;
/** One alert per floor condition set in this window. */
export const FLOOR_ALERT_TTL_SEC = 4 * 3600;
/** How long "the floor alerted" is remembered, so the clear can be reported. */
const FLOOR_ACTIVE_TTL_SEC = 24 * 3600;

const FAILED_KEY = (workspaceId: string) => `buildd:alert:dispatch-failed:${workspaceId}`;
const FLOOR_KEY = (signature: string) => `buildd:alert:dispatch-floor:${signature}`;
const FLOOR_ACTIVE_KEY = 'buildd:alert:dispatch-floor:active';

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev';
const DIGEST_LINES = 8;

export interface AlertDeps {
  tryLock: (key: string, ttlSec: number) => Promise<boolean | null>;
  getKey: <T>(key: string) => Promise<T | null | undefined>;
  setWithTtl: <T>(key: string, value: T, ttlSec: number) => Promise<boolean>;
  delKey: (key: string) => Promise<void>;
  notify: typeof notifyOperator;
}

const DEFAULT_DEPS: AlertDeps = { tryLock, getKey, setWithTtl, delKey, notify: o => notifyOperator(o) };

/** null (could not ask) or true (first in the window) both send. */
const mayAlert = (lock: boolean | null) => lock !== false;

/**
 * Alert on rows a receipt batch moved to `failed`: Dispatch exhausted its
 * attempts. One digest per batch, listing only workspaces not alerted on in
 * the last FAILED_ALERT_TTL_SEC.
 */
export async function alertDispatchFailed(
  rows: readonly FailedReceiptRow[],
  over: Partial<AlertDeps> = {},
): Promise<{ alerted: string[]; muted: string[] }> {
  const d = { ...DEFAULT_DEPS, ...over };
  const byWs = new Map<string, FailedReceiptRow[]>();
  for (const r of rows) byWs.set(r.workspaceId, [...(byWs.get(r.workspaceId) ?? []), r]);
  const alerted: string[] = [];
  const muted: string[] = [];
  for (const ws of byWs.keys()) {
    (mayAlert(await d.tryLock(FAILED_KEY(ws), FAILED_ALERT_TTL_SEC)) ? alerted : muted).push(ws);
  }
  if (alerted.length === 0) return { alerted, muted };

  const lines = alerted.slice(0, DIGEST_LINES).map(ws => {
    const list = byWs.get(ws)!;
    const first = list[0];
    const n = list.length;
    return `• workspace ${ws}: ${n} ${n === 1 ? 'wake' : 'wakes'} failed (outbox ${first.id}${first.error ? `: ${first.error.slice(0, 120)}` : ''})`;
  });
  if (alerted.length > DIGEST_LINES) lines.push(`• +${alerted.length - DIGEST_LINES} more workspaces`);
  lines.push(
    '',
    'Dispatch gave up on these after every retry. That is a bug signal, not routine: a consumer is rejecting wakes or the route is wrong.',
    `Further failures per workspace are muted for ${FAILED_ALERT_TTL_SEC / 3600}h. Read dispatch_health or get_task include:["dispatch"].`,
  );
  d.notify({
    app: 'alerts',
    title: alerted.length === 1 ? '[buildd] Dispatch delivery failed' : `[buildd] Dispatch delivery failed in ${alerted.length} workspaces`,
    message: lines.join('\n'),
    priority: 0,
    url: `${APP_BASE_URL}/app/health/operator`,
    urlTitle: 'Dispatch health',
  });
  return { alerted, muted };
}

export type FloorConditionKey =
  | 'republished' | 'projected' | 'fellBack' | 'workerErrors' | 'reconcileFailed' | 'orphaned' | 'unackedStale';

export interface FloorCondition {
  key: FloorConditionKey;
  count: number;
}

const DESCRIBE: Record<FloorConditionKey, string> = {
  republished: 'handed-off rows the Worker did not know, re-published',
  projected: 'terminal receipts that never arrived, projected from the Worker',
  fellBack: 'rows taken back from Dispatch for in-app delivery',
  workerErrors: 'Worker lookups or re-publishes that failed',
  reconcileFailed: 'the orphan reconcile threw',
  orphaned: 'handed-off rows over an hour past due with no terminal receipt',
  unackedStale: 'unacked rows the in-app fallback did not take',
};

type Isolated<T> = T | { error: string };
const isError = (v: unknown): v is { error: string } => !!v && typeof v === 'object' && 'error' in v;

/** What the floor run did that it should not have had to. Order is stable (it keys the dedupe). */
export function floorRepairConditions(input: {
  reconcile: Isolated<ReconcileCounts> | null;
  health: Isolated<DispatchOutboxHealth> | null;
}): FloorCondition[] {
  const out: FloorCondition[] = [];
  const rc = input.reconcile;
  if (isError(rc)) out.push({ key: 'reconcileFailed', count: 1 });
  else if (rc) {
    for (const key of ['republished', 'projected', 'fellBack', 'workerErrors'] as const) {
      if (rc[key] > 0) out.push({ key, count: rc[key] });
    }
  }
  const h = input.health;
  if (h && !isError(h)) {
    if (h.orphaned > 0) out.push({ key: 'orphaned', count: h.orphaned });
    if ((h.unackedStale ?? 0) > 0) out.push({ key: 'unackedStale', count: h.unackedStale });
  }
  return out;
}

export type FloorAlertOutcome = 'alerted' | 'muted' | 'recovered' | 'quiet';

/**
 * Alert when the floor repaired something; note the clear once when a later
 * run finds nothing. Deduped by the set of conditions present.
 */
export async function alertFloorRepair(conditions: readonly FloorCondition[], over: Partial<AlertDeps> = {}): Promise<FloorAlertOutcome> {
  const d = { ...DEFAULT_DEPS, ...over };
  if (conditions.length === 0) {
    const active = await d.getKey<string>(FLOOR_ACTIVE_KEY);
    // undefined: Redis could not be asked, so there is no clear to report.
    if (typeof active !== 'string' || !active) return 'quiet';
    await Promise.all([d.delKey(FLOOR_ACTIVE_KEY), d.delKey(FLOOR_KEY(active))]);
    d.notify({
      app: 'alerts',
      title: '[buildd] Dispatch repair cleared',
      message: `The hourly dispatch floor found nothing to repair. Earlier: ${active.split('+').join(', ')}.`,
      priority: -1,
    });
    return 'recovered';
  }

  const signature = conditions.map(c => c.key).join('+');
  if (!mayAlert(await d.tryLock(FLOOR_KEY(signature), FLOOR_ALERT_TTL_SEC))) return 'muted';
  await d.setWithTtl(FLOOR_ACTIVE_KEY, signature, FLOOR_ACTIVE_TTL_SEC);
  const lines = conditions.map(c => `• ${c.key}=${c.count}: ${DESCRIBE[c.key]}`);
  lines.push(
    '',
    'The floor exists to repair missed transitions and should normally find nothing. This is a bug signal, not routine.',
    `Same conditions are muted for ${FLOOR_ALERT_TTL_SEC / 3600}h. Read dispatch_health for the counts.`,
  );
  d.notify({
    app: 'alerts',
    title: '[buildd] Dispatch floor had to repair',
    message: lines.join('\n'),
    priority: 0,
    url: `${APP_BASE_URL}/app/health/operator`,
    urlTitle: 'Dispatch health',
  });
  return 'alerted';
}
