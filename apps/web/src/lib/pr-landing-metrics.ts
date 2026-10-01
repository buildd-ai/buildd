/**
 * The landing function's own scoreboard: how long an approved-and-green PR waits
 * to land, and how many are waiting too long right now.
 *
 * Derived from the `pr_landing` gate rows `landPr` already writes (see
 * `lib/pr-landing.ts`) — no table of its own. A merged outcome is an `accepted`
 * row carrying `detail.timeToLandMs` (or `timeToLandUnmeasured` when no start
 * could be derived); every other outcome carries `detail.approvedGreenAt` once
 * the PR was approved and green, which is what "stuck" is measured from.
 *
 * Aggregation is pure and exported for tests; `getLandingMetrics` is the only DB
 * read and never throws — a broken read degrades to "no landing data".
 */
import { db } from '@buildd/core/db';
import { gateEvents, workers } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import { gateWindowStartFor } from '@buildd/core/gate-analytics';
import type { GateWindow, LandingMetrics } from '@buildd/shared';

/** The design's landing target: approved and green should merge within this. */
export const LANDING_STUCK_THRESHOLD_MS = 30 * 60 * 1000;

const MAX_LANDING_ROWS = 5000;
const TERMINAL_WORKER_LIFECYCLE = ['merged', 'closed', 'unresolvable'] as const;

export interface LandingLedgerRow {
  workspaceId: string | null;
  outcome: string;
  occurredAt: Date | string;
  detail: Record<string, unknown> | null;
}

export function nearestRank(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

const toMs = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));

const isLanded = (r: LandingLedgerRow): boolean =>
  r.outcome === 'accepted' && r.detail?.landingOutcome === 'merged';

const prKey = (workspaceId: string, prNumber: number) => `${workspaceId}:${prNumber}`;

interface StuckCandidate {
  workspaceId: string;
  prNumber: number;
  waitingMs: number;
}

function candidates(rows: LandingLedgerRow[], now: Date, thresholdMs: number): StuckCandidate[] {
  const latest = new Map<string, LandingLedgerRow>();
  const ordered = [...rows].sort((a, b) => toMs(b.occurredAt) - toMs(a.occurredAt));
  for (const r of ordered) {
    const pr = r.detail?.prNumber;
    if (!r.workspaceId || typeof pr !== 'number') continue;
    const key = prKey(r.workspaceId, pr);
    if (!latest.has(key)) latest.set(key, r);
  }

  const out: StuckCandidate[] = [];
  for (const r of latest.values()) {
    if (isLanded(r)) continue;
    const since = typeof r.detail?.approvedGreenAt === 'string' ? Date.parse(r.detail.approvedGreenAt) : NaN;
    if (!Number.isFinite(since)) continue;
    const waitingMs = now.getTime() - since;
    if (waitingMs < thresholdMs) continue;
    out.push({ workspaceId: r.workspaceId!, prNumber: r.detail!.prNumber as number, waitingMs });
  }
  return out;
}

/** PRs whose newest landing decision says approved-and-green for at least the threshold. */
export function stuckCandidates(
  rows: LandingLedgerRow[],
  now: Date,
  thresholdMs: number,
): Array<{ workspaceId: string; prNumber: number }> {
  return candidates(rows, now, thresholdMs).map(({ workspaceId, prNumber }) => ({ workspaceId, prNumber }));
}

export function computeLandingMetrics(input: {
  rows: LandingLedgerRow[];
  window: GateWindow;
  now: Date;
  thresholdMs?: number;
  /** False for a PR known to be merged or closed already; defaults to open. */
  isOpen?: (workspaceId: string, prNumber: number) => boolean;
}): LandingMetrics {
  const { window, now } = input;
  const thresholdMs = input.thresholdMs ?? LANDING_STUCK_THRESHOLD_MS;
  const start = gateWindowStartFor(window, now).getTime();
  const rows = input.rows.filter((r) => toMs(r.occurredAt) >= start);

  const times: number[] = [];
  let landed = 0;
  for (const r of rows) {
    if (!isLanded(r)) continue;
    landed++;
    const t = r.detail?.timeToLandMs;
    if (typeof t === 'number' && Number.isFinite(t) && t >= 0) times.push(t);
  }

  const stuck = candidates(rows, now, thresholdMs).filter(
    (c) => !input.isOpen || input.isOpen(c.workspaceId, c.prNumber),
  );

  return {
    window,
    landed,
    unmeasured: landed - times.length,
    timeToLand: times.length
      ? {
          count: times.length,
          p50Ms: nearestRank(times, 0.5),
          p90Ms: nearestRank(times, 0.9),
          maxMs: Math.max(...times),
        }
      : null,
    stuck: {
      thresholdMs,
      count: stuck.length,
      oldestMs: stuck.length ? Math.max(...stuck.map((c) => c.waitingMs)) : null,
    },
  };
}

export async function getLandingMetrics(
  scopedWsIds: string[],
  window: GateWindow = '7d',
  now: Date = new Date(),
): Promise<LandingMetrics | null> {
  if (scopedWsIds.length === 0) return null;
  try {
    const rows = (await db
      .select({
        workspaceId: gateEvents.workspaceId,
        outcome: gateEvents.outcome,
        occurredAt: gateEvents.occurredAt,
        detail: gateEvents.detail,
      })
      .from(gateEvents)
      .where(and(
        eq(gateEvents.gate, GATE_SLUGS.PR_LANDING),
        inArray(gateEvents.workspaceId, scopedWsIds),
        gte(gateEvents.occurredAt, gateWindowStartFor(window, now)),
      ))
      .orderBy(desc(gateEvents.occurredAt))
      .limit(MAX_LANDING_ROWS)) as LandingLedgerRow[];

    // A PR whose worker already merged or closed (the legacy path merged it, or
    // the shadow row never saw the merge) is not waiting on anyone.
    const waiting = stuckCandidates(rows, now, LANDING_STUCK_THRESHOLD_MS);
    const gone = new Set<string>();
    if (waiting.length > 0) {
      const done = await db
        .select({ workspaceId: workers.workspaceId, prNumber: workers.prNumber })
        .from(workers)
        .where(and(
          inArray(workers.workspaceId, [...new Set(waiting.map((w) => w.workspaceId))]),
          inArray(workers.prNumber, [...new Set(waiting.map((w) => w.prNumber))]),
          inArray(workers.prLifecycleStatus, [...TERMINAL_WORKER_LIFECYCLE]),
        ));
      for (const w of done as Array<{ workspaceId: string; prNumber: number | null }>) {
        if (w.prNumber != null) gone.add(prKey(w.workspaceId, w.prNumber));
      }
    }

    return computeLandingMetrics({
      rows,
      window,
      now,
      isOpen: (ws, pr) => !gone.has(prKey(ws, pr)),
    });
  } catch (err) {
    console.error('[pr-landing-metrics] read failed:', err);
    return null;
  }
}
