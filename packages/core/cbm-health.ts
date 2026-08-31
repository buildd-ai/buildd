/**
 * Fleet-wide CBM health detector.
 *
 * Fires an ops alert when the last N terminal workers (completed / failed /
 * error — see CBM_HEALTH_TERMINAL_STATUSES) in a workspace all report
 * cbmOutcome='disabled' with disableReason='binary_absent'. This condition means
 * the codebase-memory-mcp binary is missing from the runner image — a broken
 * platform capability that silently degrades every agent session without any
 * per-task signal surfacing it.
 *
 * The check is best-effort: never throws, never blocks the caller. The dedupeKey
 * ensures one alert per workspace per reportOps throttle window (default 1h).
 *
 * Env: same as reportOps — OPS_ALERTS_ENABLED must be truthy, else no-op.
 */

import { db } from './db';
import { workers } from './db/schema';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { reportOps } from './report-ops';

/** Number of consecutive binary_absent outcomes that trigger the fleet alert. */
export const CBM_FLEET_THRESHOLD = 5;

/**
 * Terminal worker statuses that carry a CBM record.
 *
 * The fleet check used to look only at `completed` workers, which made it blind
 * to the very failure it exists to catch: when the codebase-memory binary is
 * missing, workers can die rather than complete, so a workspace where EVERY
 * worker fails would never accumulate a streak and never page. All three of
 * these statuses set `completedAt` and write `resultMeta.cbm`, so all three are
 * valid streak members. The streak threshold is unchanged, so a single
 * transient failure still cannot fire an alert.
 */
export const CBM_HEALTH_TERMINAL_STATUSES = ['completed', 'failed', 'error'] as const;

function opsEnabled(): boolean {
  const v = process.env.OPS_ALERTS_ENABLED;
  return v === '1' || v === 'true' || v === 'yes';
}

function isBinaryAbsent(cbm: unknown): boolean {
  if (!cbm || typeof cbm !== 'object') return false;
  const c = cbm as Record<string, unknown>;
  return c.outcome === 'disabled' && c.disableReason === 'binary_absent';
}

/**
 * Check whether the last CBM_FLEET_THRESHOLD terminal workers in a workspace
 * all have cbmOutcome='disabled' / disableReason='binary_absent'. When they do,
 * fire a single ops alert (deduplicated per workspace per throttle window).
 *
 * Pass `currentCbm` from the just-completed worker's resultMeta.cbm — it may
 * not be committed to the DB yet when this function runs, so we combine it with
 * the DB query for the prior (N-1) workers.
 */
/**
 * Rows in the completion history that carry CBM metrics at all.
 *
 * Workers with no `cbm` key never had the capability mounted (Codex tasks, or
 * coordination workers with no worktree). They are not evidence either way, but
 * they used to break the streak and silence the alert — and in a mixed fleet that
 * is most of the time. Filter them out, then take the window from what remains.
 */
function cbmWindow(
  rows: Array<{ resultMeta: unknown }>,
  size: number,
): Array<Record<string, unknown>> {
  const withCbm: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const cbm = (row.resultMeta as Record<string, unknown> | null)?.cbm;
    if (cbm && typeof cbm === 'object') withCbm.push(cbm as Record<string, unknown>);
    if (withCbm.length === size) break;
  }
  return withCbm;
}

/** How many rows to scan to find `size` CBM-carrying ones. */
function scanLimit(size: number): number {
  return size * 4;
}

export async function detectCbmFleetDisabled(
  workspaceId: string,
  currentCbm: unknown,
): Promise<void> {
  try {
    if (!opsEnabled()) return;

    // Short-circuit: current worker is not binary_absent, so the streak is broken.
    if (!isBinaryAbsent(currentCbm)) return;

    // Query the last (N-1) completed workers with CBM metrics.
    const rows = await db.query.workers.findMany({
      where: and(
        eq(workers.workspaceId, workspaceId),
        inArray(workers.status, [...CBM_HEALTH_TERMINAL_STATUSES]),
        isNotNull(workers.completedAt),
        isNotNull(workers.resultMeta),
      ),
      columns: { resultMeta: true },
      orderBy: [desc(workers.completedAt)],
      limit: scanLimit(CBM_FLEET_THRESHOLD),
    });

    const prior = cbmWindow(rows, CBM_FLEET_THRESHOLD - 1);
    if (prior.length < CBM_FLEET_THRESHOLD - 1) return; // not enough history yet

    const allPriorBinaryAbsent = prior.every(isBinaryAbsent);
    if (!allPriorBinaryAbsent) return;

    await reportOps({
      source: 'cbm-health',
      severity: 'error',
      message: `CBM disabled (binary_absent) on last ${CBM_FLEET_THRESHOLD} workers`,
      detail: `workspace=${workspaceId} — /opt/buildd/bin/codebase-memory-mcp missing from runner image. Re-run install.sh or rebuild the worker image.`,
      dedupeKey: `cbm-fleet-disabled:${workspaceId}`,
    });
  } catch {
    // Never let health tracking break the completion path.
  }
}

/** Consecutive enforced-but-unqueried outcomes that trigger the adoption alert. */
export const CBM_UNUSED_THRESHOLD = 10;

function isEnforcedAndUnused(cbm: unknown): boolean {
  if (!cbm || typeof cbm !== 'object') return false;
  const c = cbm as Record<string, unknown>;
  if (c.outcome === 'disabled') return false;
  const calls = c.toolCalls;
  if (!calls || typeof calls !== 'object') return true; // mounted, nothing recorded
  return Object.values(calls as Record<string, number>).reduce((a, b) => a + (b ?? 0), 0) === 0;
}

/**
 * Detect CBM being mounted but never queried.
 *
 * This is the failure mode that replaced binary_absent. Once the binary shipped,
 * enforcement started firing on every qualifying worker and the graph was indexed
 * in ~12s per task — and on first rollout the first cohort of active workers made
 * ZERO graph tool calls. That is invisible to detectCbmFleetDisabled, because
 * nothing is "disabled": the capability is present, warm, and ignored.
 *
 * Without this signal the only trace is an empty `avgToolCalls` object on an
 * endpoint nobody reads — the same shape of silent degradation that let
 * binary_absent run for four weeks.
 *
 * Threshold is deliberately higher than the disabled check: a single task with no
 * structural question is expected to make no graph calls, so only a sustained run
 * of them indicates the steering is not working.
 *
 * Unlike detectCbmFleetDisabled this stays scoped to `completed` workers on
 * purpose: a session that crashed or was killed naturally made no graph calls,
 * so admitting failed/error workers here would manufacture adoption alerts out
 * of unrelated outages.
 */
export async function detectCbmEnforcedUnused(
  workspaceId: string,
  currentCbm: unknown,
): Promise<void> {
  try {
    if (!opsEnabled()) return;
    if (!isEnforcedAndUnused(currentCbm)) return;

    const rows = await db.query.workers.findMany({
      where: and(
        eq(workers.workspaceId, workspaceId),
        eq(workers.status, 'completed'),
        isNotNull(workers.resultMeta),
      ),
      columns: { resultMeta: true },
      orderBy: [desc(workers.completedAt)],
      limit: scanLimit(CBM_UNUSED_THRESHOLD),
    });

    const prior = cbmWindow(rows, CBM_UNUSED_THRESHOLD - 1);
    if (prior.length < CBM_UNUSED_THRESHOLD - 1) return;
    if (!prior.every(isEnforcedAndUnused)) return;

    // What the agent did instead is the actionable half of the alert: file
    // navigation is exactly the cost the graph was mounted to avoid.
    const current = (currentCbm ?? {}) as Record<string, number | undefined>;
    const fallback = [
      `read=${current.readCount ?? 0}`,
      `grep=${current.grepCount ?? 0}`,
      `glob=${current.globCount ?? 0}`,
    ].join(' ');

    await reportOps({
      source: 'cbm-health',
      // Not 'warning': that is Pushover priority -2, badge-only, and this alert
      // fired in production without anyone seeing it.
      severity: 'error',
      message: `CBM mounted but never queried on last ${CBM_UNUSED_THRESHOLD} workers`,
      detail: `workspace=${workspaceId} — codebase-memory is enforced and pre-indexed, but no agent called an mcp__codebase-memory__* tool across ${CBM_UNUSED_THRESHOLD} consecutive CBM-enabled tasks. Latest task navigated by file access instead: ${fallback}. The graph is being built and paid for and not used; prompt steering is ineffective.`,
      dedupeKey: `cbm-enforced-unused:${workspaceId}`,
    });
  } catch {
    // Never let health tracking break the completion path.
  }
}
