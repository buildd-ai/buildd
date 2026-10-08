/**
 * Path-coordination signal vocabulary (docs/specs/path-claim-ownership.md).
 *
 * Every `path_claim` / `path_declaration` gate event is one of five things,
 * and a sentinel that rolls them into one "coordinator outage" number is wrong
 * four times out of five:
 *
 *  - observation_truncated   the bounded observed-touch SAMPLE hit its cap.
 *                            Advisory. Leases are authoritative; nothing lost.
 *  - claim_blocked           a live holder blocked a claim. That is the
 *                            coordinator working, not failing.
 *  - deadlock_detected       a circular wait. A conflict with its own metric.
 *  - coordination_unavailable a timeout / network error / 5xx / DB failure.
 *                            Real degradation, reason-classified in `detail`.
 *  - coverage_unknown_at_ship a ship checkpoint could not prove coverage.
 *                            Critical when the ship was refused (enforce), a
 *                            loud warning when it was let through (advisory).
 *
 * Writers put the signal in `detail.signal`; readers that only have the
 * normalized `reason` (gate analytics drops `detail`) classify from text.
 * Both paths are pinned by __tests__/path-coordination-signal.test.ts, so a
 * reason string cannot drift away from its signal.
 */
import type { PathCoordinationSeverity, PathCoordinationSignal, PathCoordinationSummary } from '@buildd/shared';

export const PATH_COORDINATION_GATES: readonly string[] = ['path_claim', 'path_declaration'];

export const PATH_COORDINATION_SIGNALS: readonly PathCoordinationSignal[] = [
  'observation_truncated',
  'claim_blocked',
  'deadlock_detected',
  'coordination_unavailable',
  'coverage_unknown_at_ship',
];

export const SIGNAL_SEVERITY: Record<PathCoordinationSignal, PathCoordinationSeverity> = {
  observation_truncated: 'advisory',
  claim_blocked: 'healthy',
  deadlock_detected: 'conflict',
  coordination_unavailable: 'degraded',
  coverage_unknown_at_ship: 'critical',
};

const SEVERITY_RANK: Record<PathCoordinationSeverity, number> = {
  healthy: 0, advisory: 1, conflict: 2, degraded: 3, critical: 4,
};

/**
 * The reason strings the writers use. Centralised so a writer and the text
 * classifier below cannot disagree. Keep them free of numbers, ids and paths:
 * `normalizeErrorSignature` rewrites those on write and the classifier runs
 * on the normalized text.
 */
export const PATH_SIGNAL_REASONS = {
  observation_truncated: 'observed-touch sample truncated at its cap; coverage unaffected, leases are authoritative',
  claim_blocked: 'paths overlap an active claim held by another task',
  claim_blocked_checkpoint: 'checkpoint path collision: task deferred behind the holder',
  deadlock_detected: 'deadlock detected: circular wait between path claims',
  coordination_unavailable: 'path declaration degraded: coordination unavailable, edits proceeded',
  coverage_unknown_refused: 'ship checkpoint refused: path coverage unknown, coordinator unreachable',
  coverage_unknown_advisory: 'ship proceeded with path coverage unknown: coordinator unreachable, advisory mode',
} as const;

export interface PathCoordinationEventLike {
  gate: string;
  outcome: string;
  reason: string;
  detail?: Record<string, unknown> | null;
}

function isSignal(v: unknown): v is PathCoordinationSignal {
  return typeof v === 'string' && (PATH_COORDINATION_SIGNALS as readonly string[]).includes(v);
}

/**
 * Which signal one gate event is. `detail.signal` wins when present; otherwise
 * the normalized reason text decides. Null for a path event that is none of
 * the five (a wildcard rejection, an accepted call) and for any other gate.
 */
export function classifyPathCoordinationEvent(ev: PathCoordinationEventLike): PathCoordinationSignal | null {
  if (!PATH_COORDINATION_GATES.includes(ev.gate)) return null;
  const tagged = ev.detail?.signal;
  if (isSignal(tagged)) return tagged;

  const r = (ev.reason ?? '').toLowerCase();
  if (/coverage unknown/.test(r)) return 'coverage_unknown_at_ship';
  if (/deadlock/.test(r) || ev.detail?.deadlock === true) return 'deadlock_detected';
  if (/sample truncated|past the .*cap|observed touches past/.test(r)) return 'observation_truncated';
  if (/coordination unavailable|unreachable|coordinator (is )?down/.test(r)) return 'coordination_unavailable';
  if (ev.outcome === 'deferred' && /overlap an active claim|held by another|path collision|collision/.test(r)) return 'claim_blocked';
  return null;
}

/**
 * Summarise a window of gate events. Only `coordination_unavailable` and
 * `coverage_unknown_at_ship` make `incident` true: thousands of truncation
 * advisories or blocked claims are, respectively, noise and health.
 */
export function summarizePathCoordination(events: PathCoordinationEventLike[]): PathCoordinationSummary {
  const counts = Object.fromEntries(PATH_COORDINATION_SIGNALS.map(s => [s, 0])) as Record<PathCoordinationSignal, number>;
  let unclassified = 0;
  let severity: PathCoordinationSeverity | null = null;
  for (const ev of events) {
    if (!PATH_COORDINATION_GATES.includes(ev.gate)) continue;
    const signal = classifyPathCoordinationEvent(ev);
    if (!signal) { unclassified += 1; continue; }
    counts[signal] += 1;
    const s = SIGNAL_SEVERITY[signal];
    if (severity === null || SEVERITY_RANK[s] > SEVERITY_RANK[severity]) severity = s;
  }
  const incident = counts.coordination_unavailable > 0 || counts.coverage_unknown_at_ship > 0;
  return { counts, unclassified, incident, severity, verdict: verdictFor(counts, incident) };
}

function verdictFor(counts: Record<PathCoordinationSignal, number>, incident: boolean): string {
  const parts: string[] = [];
  if (counts.coverage_unknown_at_ship > 0) parts.push(`${counts.coverage_unknown_at_ship} ship checkpoint(s) could not prove path coverage`);
  if (counts.coordination_unavailable > 0) parts.push(`${counts.coordination_unavailable} coordination-unavailable event(s)`);
  if (counts.deadlock_detected > 0) parts.push(`${counts.deadlock_detected} deadlock(s) detected`);
  const healthy: string[] = [];
  if (counts.claim_blocked > 0) healthy.push(`${counts.claim_blocked} blocked claim(s) are live holders doing their job`);
  if (counts.observation_truncated > 0) healthy.push(`${counts.observation_truncated} sample-truncation advisory(ies) do not affect coverage`);
  if (incident) {
    return `Path coordination degraded: ${parts.join('; ')}.${healthy.length ? ` Not part of the incident: ${healthy.join('; ')}.` : ''}`;
  }
  if (parts.length > 0) return `Path coordination available; ${parts.join('; ')}.${healthy.length ? ` ${healthy.join('; ')}.` : ''}`;
  if (healthy.length > 0) return `Path coordination healthy: ${healthy.join('; ')}.`;
  return 'No path-coordination events in the window.';
}
