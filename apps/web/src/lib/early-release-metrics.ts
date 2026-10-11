/**
 * The early-release measure (knowledge-base: buildd/design/early-release.md
 * "Failure modes & the measure"): is releasing dependents before their upstream
 * merges actually shortening chains, and at what rework cost?
 *
 * Read entirely off `dependency_releases` rows and the `early_release` gate
 * ledger (plus the workers/tasks those rows point at) — standalone, with no
 * dependency on any other scheduling readout. The arithmetic is pure
 * (`computeRework`, `computeChainDurations`, `computeRaisedToClaimed`) so it is
 * testable with fixture rows; `fetchEarlyReleaseStats` only gathers the rows.
 *
 * - Rework rate: released dependents (start_now / start_stacked) that the
 *   reconciler later refreshed or escalated, or whose release was revoked or
 *   whose task was cancelled ÷ all dependents released in the window.
 * - Chain duration: upstream PR raised → the dependent's own PR merged, for the
 *   released cohort vs. dependents in workspaces that never opted in.
 * - Raised → claimed: release decision (taken when the upstream PR is raised) →
 *   the dependent's first claim, for released dependents.
 */
import type { DurationSummary, EarlyReleaseStats } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { dependencyReleases, gateEvents, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import { EARLY_RELEASE_SATISFYING_DECISIONS } from '@/lib/dep-gate-contract';
import { resolveEarlyReleaseMode, type EarlyReleaseMode } from '@/lib/early-release-mode';
import { coordinationFilters, type CoordinationWindow } from '@/lib/coordination-stats-query';

const RELEASED = new Set<string>(EARLY_RELEASE_SATISFYING_DECISIONS);

export interface ReleaseRow {
  id: string;
  dependentTaskId: string;
  upstreamTaskId: string;
  decision: 'start_now' | 'wait' | 'start_stacked';
  decidedAt: Date;
  revokedAt: Date | null;
  /** The dependent task's current status. */
  dependentStatus: string;
}

/** One `early_release` gate event, reduced to what rework needs. */
export interface ReworkEvent {
  taskId: string | null;
  /** `detail.releaseId` — the reconciler stamps every row with it. */
  releaseId: string | null;
  /** `detail.action` — 'refresh' | 'escalate' count as rework; 'ignore' and the skipped refreshes do not. */
  action: string | null;
}

export interface ChainRow {
  dependentTaskId: string;
  workspaceId: string;
  upstreamTaskIds: string[];
  /** When the dependent's own PR merged. */
  mergedAt: Date;
  /** Whether the dependent ever got a start_now / start_stacked release. */
  released: boolean;
}

/** Nearest-rank quantile over a sorted array. */
function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

export function summarizeDurations(durationsMs: number[]): DurationSummary {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  return { n: sorted.length, p50Ms: quantile(sorted, 0.5), p90Ms: quantile(sorted, 0.9) };
}

export function computeRework(releases: ReleaseRow[], events: ReworkEvent[]): EarlyReleaseStats['rework'] {
  const released = releases.filter(r => RELEASED.has(r.decision));
  const dependentByRelease = new Map(released.map(r => [r.id, r.dependentTaskId]));
  const releasedDependents = new Set(released.map(r => r.dependentTaskId));
  const refreshed = new Set<string>();
  const escalated = new Set<string>();
  for (const event of events) {
    const dependent = (event.releaseId && dependentByRelease.get(event.releaseId))
      ?? (event.taskId && releasedDependents.has(event.taskId) ? event.taskId : null);
    if (!dependent) continue;
    if (event.action === 'refresh') refreshed.add(dependent);
    else if (event.action === 'escalate') escalated.add(dependent);
  }
  const cancelled = new Set(released.filter(r => r.revokedAt || r.dependentStatus === 'cancelled').map(r => r.dependentTaskId));
  const reworked = new Set([...refreshed, ...escalated, ...cancelled]);
  return {
    released: releasedDependents.size,
    reworked: reworked.size,
    rate: releasedDependents.size ? reworked.size / releasedDependents.size : null,
    refreshed: refreshed.size,
    escalated: escalated.size,
    cancelled: cancelled.size,
  };
}

/**
 * Chain start is the LATEST upstream PR raise among the dependent's upstreams —
 * on the merge-gated path that is the one the dependent was actually waiting on,
 * and the same anchor for both cohorts keeps them comparable. A dependent whose
 * upstreams never raised a PR, or whose raise postdates its own merge, has no
 * chain to measure and is skipped.
 */
export function computeChainDurations(
  chains: ChainRow[],
  upstreamPrRaisedAt: Map<string, Date>,
  modes: Map<string, EarlyReleaseMode>,
): EarlyReleaseStats['chainDuration'] {
  const released: number[] = [];
  const notOptedIn: number[] = [];
  for (const chain of chains) {
    const raises = chain.upstreamTaskIds.map(id => upstreamPrRaisedAt.get(id)?.getTime()).filter((t): t is number => t != null);
    if (raises.length === 0) continue;
    const duration = chain.mergedAt.getTime() - Math.max(...raises);
    if (duration < 0) continue;
    if (chain.released) released.push(duration);
    else if ((modes.get(chain.workspaceId) ?? 'off') === 'off') notOptedIn.push(duration);
  }
  return { released: summarizeDurations(released), notOptedIn: summarizeDurations(notOptedIn) };
}

/** Earliest release decision per dependent → that dependent's first claim. */
export function computeRaisedToClaimed(releases: ReleaseRow[], firstClaimAt: Map<string, Date>): DurationSummary {
  const releasedAt = new Map<string, number>();
  for (const r of releases) {
    if (!RELEASED.has(r.decision)) continue;
    const prior = releasedAt.get(r.dependentTaskId);
    if (prior == null || r.decidedAt.getTime() < prior) releasedAt.set(r.dependentTaskId, r.decidedAt.getTime());
  }
  const durations: number[] = [];
  for (const [dependent, at] of releasedAt) {
    const claimed = firstClaimAt.get(dependent)?.getTime();
    if (claimed != null && claimed >= at) durations.push(claimed - at);
  }
  return summarizeDurations(durations);
}

export function countDecisions(releases: ReleaseRow[]): EarlyReleaseStats['decisions'] {
  const counts = { start_now: 0, start_stacked: 0, wait: 0 };
  for (const r of releases) if (r.decision in counts) counts[r.decision]++;
  return counts;
}

/**
 * A worker's PR-open anchor, `completedAt ?? createdAt` — the same one
 * lib/pr-freshness.ts and mission-invariants.ts use. Earliest per task.
 */
function earliestPrRaise(rows: Array<{ taskId: string | null; createdAt: Date; completedAt: Date | null }>): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const row of rows) {
    if (!row.taskId) continue;
    const at = row.completedAt ?? row.createdAt;
    const prior = out.get(row.taskId);
    if (!prior || at < prior) out.set(row.taskId, at);
  }
  return out;
}

export async function fetchEarlyReleaseStats(input: {
  workspaceIds: string[]; missionId?: string; window: CoordinationWindow;
}): Promise<EarlyReleaseStats> {
  const filters = coordinationFilters(input);
  const windowStart = new Date(filters.windowStart);
  const coverage = {
    note: "PR raised is approximated by the upstream worker's completedAt ?? createdAt (the pr-freshness anchor); raised → claimed uses the release decision time, which is taken when the upstream PR is raised.",
  };
  if (input.workspaceIds.length === 0) {
    return {
      ...filters, modes: [], decisions: countDecisions([]), rework: computeRework([], []),
      chainDuration: computeChainDurations([], new Map(), new Map()), raisedToClaimed: summarizeDurations([]), coverage,
    };
  }
  const missionScope = input.missionId ? eq(tasks.missionId, input.missionId) : undefined;

  const [workspaceRows, releases, events, chainRows] = await Promise.all([
    db.query.workspaces.findMany({ where: inArray(workspaces.id, input.workspaceIds), columns: { id: true, gitConfig: true } }),
    db.select({
      id: dependencyReleases.id,
      dependentTaskId: dependencyReleases.dependentTaskId,
      upstreamTaskId: dependencyReleases.upstreamTaskId,
      decision: dependencyReleases.decision,
      decidedAt: dependencyReleases.decidedAt,
      revokedAt: dependencyReleases.revokedAt,
      dependentStatus: tasks.status,
    }).from(dependencyReleases)
      .innerJoin(tasks, eq(tasks.id, dependencyReleases.dependentTaskId))
      .where(and(inArray(tasks.workspaceId, input.workspaceIds), gte(dependencyReleases.decidedAt, windowStart), missionScope)),
    db.select({
      taskId: gateEvents.taskId,
      releaseId: sql<string | null>`${gateEvents.detail}->>'releaseId'`,
      action: sql<string | null>`${gateEvents.detail}->>'action'`,
    }).from(gateEvents).where(and(
      inArray(gateEvents.workspaceId, input.workspaceIds), eq(gateEvents.gate, GATE_SLUGS.EARLY_RELEASE),
      gte(gateEvents.occurredAt, windowStart),
      sql`${gateEvents.detail}->>'action' in ('refresh', 'escalate')`,
      input.missionId ? eq(gateEvents.missionId, input.missionId) : undefined,
    )),
    db.select({
      dependentTaskId: tasks.id,
      workspaceId: tasks.workspaceId,
      dependsOn: tasks.dependsOn,
      mergedAt: sql<string>`min(${workers.mergedAt})::text`,
    }).from(tasks)
      .innerJoin(workers, eq(workers.taskId, tasks.id))
      .where(and(
        inArray(tasks.workspaceId, input.workspaceIds),
        sql`jsonb_array_length(coalesce(${tasks.dependsOn}, '[]'::jsonb)) > 0`,
        gte(workers.mergedAt, windowStart),
        missionScope,
      ))
      .groupBy(tasks.id, tasks.workspaceId, tasks.dependsOn),
  ]);

  const releasedIds = [...new Set(releases.filter(r => RELEASED.has(r.decision)).map(r => r.dependentTaskId))];
  const cohortIds = chainRows.map(r => r.dependentTaskId);
  const upstreamIds = [...new Set(chainRows.flatMap(r => r.dependsOn ?? []))];
  const [claimRows, cohortReleaseRows, upstreamWorkerRows] = await Promise.all([
    releasedIds.length ? db.select({ taskId: workers.taskId, firstClaimAt: sql<string>`min(${workers.createdAt})::text` })
      .from(workers).where(inArray(workers.taskId, releasedIds)).groupBy(workers.taskId) : [],
    cohortIds.length ? db.selectDistinct({ dependentTaskId: dependencyReleases.dependentTaskId }).from(dependencyReleases).where(and(
      inArray(dependencyReleases.dependentTaskId, cohortIds),
      inArray(dependencyReleases.decision, [...EARLY_RELEASE_SATISFYING_DECISIONS]),
    )) : [],
    upstreamIds.length ? db.select({ taskId: workers.taskId, createdAt: workers.createdAt, completedAt: workers.completedAt })
      .from(workers).where(and(inArray(workers.taskId, upstreamIds), isNotNull(workers.prNumber))) : [],
  ]);

  const modes = new Map(workspaceRows.map(w => [w.id, resolveEarlyReleaseMode(w.gitConfig)]));
  const everReleased = new Set(cohortReleaseRows.map(r => r.dependentTaskId));
  const chains: ChainRow[] = chainRows.map(r => ({
    dependentTaskId: r.dependentTaskId,
    workspaceId: r.workspaceId,
    upstreamTaskIds: r.dependsOn ?? [],
    mergedAt: new Date(r.mergedAt),
    released: everReleased.has(r.dependentTaskId),
  }));
  const firstClaimAt = new Map(claimRows.flatMap(r => (r.taskId ? [[r.taskId, new Date(r.firstClaimAt)] as const] : [])));

  return {
    ...filters,
    modes: workspaceRows.map(w => ({ workspaceId: w.id, mode: modes.get(w.id) ?? 'off' })),
    decisions: countDecisions(releases),
    rework: computeRework(releases, events),
    chainDuration: computeChainDurations(chains, earliestPrRaise(upstreamWorkerRows), modes),
    raisedToClaimed: computeRaisedToClaimed(releases, firstClaimAt),
    coverage,
  };
}
