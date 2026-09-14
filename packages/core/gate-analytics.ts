/**
 * Gate-ledger aggregation — pure. No DB, no clock reads (pass `now`).
 *
 * The DB fetch lives in `apps/web/src/lib/gate-analytics-query.ts`, which is
 * the only thing that touches Postgres, so every number below is unit-testable
 * against a plain array of rows.
 *
 * The shape deliberately mirrors `failure-analytics.ts`: same window vocabulary,
 * same first/last-seen framing, same "group by NORMALIZED reason" rule. A
 * reader who already knows how to read the failure table should not have to
 * learn a second dialect to read this one.
 */
import { toFrictionSignature } from './failure-friction-signature';
import type {
  GateAnalytics,
  GateOutcomeCounts,
  GateReasonFamily,
  GateReasonRow,
  GateRow,
  GateWindow,
} from '@buildd/shared';

/** One ledger row, already read from `gate_events`. */
export interface GateEventRow {
  id: string;
  gate: string;
  surface: string;
  outcome: string;
  reason: string;
  workspaceId: string | null;
  missionId: string | null;
  taskId: string | null;
  callerOrigin: string | null;
  occurredAt: Date;
}

export interface GateAnalyticsInput {
  window: GateWindow;
  now: Date;
  events: GateEventRow[];
  /** Cap on the ranked `gates` list. */
  maxGates?: number;
  /** Cap on each gate's `topReasons` list. */
  maxReasonsPerGate?: number;
}

const DEFAULT_MAX_GATES = 15;
const DEFAULT_MAX_REASONS = 5;

const WINDOW_MS: Record<GateWindow, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export function gateWindowStartFor(window: GateWindow, now: Date): Date {
  return new Date(now.getTime() - WINDOW_MS[window]);
}

function emptyCounts(): GateOutcomeCounts {
  return { rejected: 0, deferred: 0, bypassed: 0, warned: 0 };
}

function tally(counts: GateOutcomeCounts, outcome: string): void {
  if (outcome === 'rejected' || outcome === 'deferred' || outcome === 'bypassed' || outcome === 'warned') {
    counts[outcome] += 1;
  }
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100);
}

/**
 * Bypass rate = bypassed / (bypassed + rejected + warned).
 *
 * `deferred` is excluded from the denominator on purpose. A deferral is the
 * gate working — a wait, a single-flight, a queue — and nobody bypasses it;
 * folding deferrals in would drown a lint's real false-positive rate under
 * whichever gate happens to defer most often that week.
 */
export function bypassRatePct(counts: GateOutcomeCounts): number {
  return pct(counts.bypassed, counts.bypassed + counts.rejected + counts.warned);
}

interface GateAccumulator {
  gate: string;
  surfaces: Set<string>;
  counts: GateOutcomeCounts;
  total: number;
  firstSeen: number;
  lastSeen: number;
  byReason: Map<string, { count: number; counts: GateOutcomeCounts; firstSeen: number; lastSeen: number }>;
  exampleTaskId: string | null;
}

/**
 * Aggregate a window of gate events into a report.
 *
 * Grouping is by (gate, normalized reason). The normalization already happened
 * on write — `recordGateEvent` stores `normalizeErrorSignature(message)` — so
 * this function never re-normalizes. Doing it here too would be a second place
 * the rule could drift.
 */
export function computeGateAnalytics(input: GateAnalyticsInput): GateAnalytics {
  const { window, now, events } = input;
  const maxGates = input.maxGates ?? DEFAULT_MAX_GATES;
  const maxReasons = input.maxReasonsPerGate ?? DEFAULT_MAX_REASONS;

  const totals = emptyCounts();
  const byGate = new Map<string, GateAccumulator>();

  for (const ev of events) {
    tally(totals, ev.outcome);
    const ts = ev.occurredAt.getTime();

    let acc = byGate.get(ev.gate);
    if (!acc) {
      acc = {
        gate: ev.gate,
        surfaces: new Set<string>(),
        counts: emptyCounts(),
        total: 0,
        firstSeen: ts,
        lastSeen: ts,
        byReason: new Map(),
        exampleTaskId: null,
      };
      byGate.set(ev.gate, acc);
    }
    acc.surfaces.add(ev.surface);
    acc.total += 1;
    tally(acc.counts, ev.outcome);
    if (ts < acc.firstSeen) acc.firstSeen = ts;
    if (ts > acc.lastSeen) acc.lastSeen = ts;
    if (!acc.exampleTaskId && ev.taskId) acc.exampleTaskId = ev.taskId;

    let reason = acc.byReason.get(ev.reason);
    if (!reason) {
      reason = { count: 0, counts: emptyCounts(), firstSeen: ts, lastSeen: ts };
      acc.byReason.set(ev.reason, reason);
    }
    reason.count += 1;
    tally(reason.counts, ev.outcome);
    if (ts < reason.firstSeen) reason.firstSeen = ts;
    if (ts > reason.lastSeen) reason.lastSeen = ts;
  }

  const gates: GateRow[] = [...byGate.values()]
    .sort((a, b) => b.total - a.total || b.lastSeen - a.lastSeen || a.gate.localeCompare(b.gate))
    .slice(0, maxGates)
    .map(acc => ({
      gate: acc.gate,
      surfaces: [...acc.surfaces].sort(),
      count: acc.total,
      outcomes: acc.counts,
      bypassRatePct: bypassRatePct(acc.counts),
      firstSeen: new Date(acc.firstSeen).toISOString(),
      lastSeen: new Date(acc.lastSeen).toISOString(),
      exampleTaskId: acc.exampleTaskId,
      distinctReasons: acc.byReason.size,
      topReasons: rankReasons(acc.byReason, maxReasons),
    }));

  return {
    window,
    generatedAt: now.toISOString(),
    windowStart: gateWindowStartFor(window, now).toISOString(),
    totals: {
      events: events.length,
      ...totals,
      distinctGates: byGate.size,
    },
    gates,
    truncatedGates: Math.max(0, byGate.size - gates.length),
  };
}

function rankReasons(
  byReason: GateAccumulator['byReason'],
  limit: number,
): GateReasonRow[] {
  return [...byReason.entries()]
    .map(([reason, r]) => ({
      reason,
      count: r.count,
      outcomes: r.counts,
      bypassRatePct: bypassRatePct(r.counts),
      firstSeen: new Date(r.firstSeen).toISOString(),
      lastSeen: new Date(r.lastSeen).toISOString(),
    }))
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) || a.reason.localeCompare(b.reason))
    .slice(0, limit);
}

const FAMILY_TOP_REASONS = 5;

/**
 * Roll up every gate reason sharing a literal prefix.
 *
 * Same problem `buildSignatureFamily` solves for worker errors: a gate whose
 * message embeds enough free text to survive normalization produces a spread of
 * singleton reasons, each too small to rank into `topReasons`, with no way to
 * ask how big the family is. This reads the FULL event set, not the already
 * ranked/capped output, which is the entire point.
 *
 * The match is a literal, case-sensitive prefix test against the stored
 * (already normalized) reason. The prefix is NOT run through the normalizer —
 * the caller passes the text the reasons actually start with.
 */
export function buildGateReasonFamily(events: GateEventRow[], prefix: string): GateReasonFamily {
  const counts = emptyCounts();
  const byReason = new Map<string, number>();
  const gates = new Set<string>();
  let count = 0;
  let firstSeen: number | null = null;
  let lastSeen: number | null = null;
  let exampleTaskId: string | null = null;

  for (const ev of events) {
    if (!ev.reason.startsWith(prefix)) continue;
    count += 1;
    tally(counts, ev.outcome);
    gates.add(ev.gate);
    const ts = ev.occurredAt.getTime();
    if (firstSeen === null || ts < firstSeen) firstSeen = ts;
    if (lastSeen === null || ts > lastSeen) lastSeen = ts;
    if (!exampleTaskId && ev.taskId) exampleTaskId = ev.taskId;
    byReason.set(ev.reason, (byReason.get(ev.reason) ?? 0) + 1);
  }

  return {
    prefix,
    known: count > 0,
    count,
    distinctReasons: byReason.size,
    gates: [...gates].sort(),
    outcomes: counts,
    bypassRatePct: bypassRatePct(counts),
    firstSeen: firstSeen !== null ? new Date(firstSeen).toISOString() : null,
    lastSeen: lastSeen !== null ? new Date(lastSeen).toISOString() : null,
    exampleTaskId,
    frictionSignature: toFrictionSignature(prefix),
    topReasons: [...byReason.entries()]
      .map(([reason, reasonCount]) => ({ reason, count: reasonCount }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, FAMILY_TOP_REASONS),
  };
}
