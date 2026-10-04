/**
 * The stores half of the shared decision readout (./decision-readout.ts).
 *
 * For one kind, one team (and optionally one workspace) and one window:
 * the kind's `decision_records` rows, the `decision_outcomes` labels and
 * `decision_challenger_runs` rows against them, the team's access state for
 * the kind's capability (`resolveDecisionAccess`: policy + key, no spend) and
 * the kind adapter's eligible-subject count.
 *
 * Read-only. Predicates are exported so tests render them with the real dialect.
 */
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { decisionChallengerRuns, decisionOutcomes, decisionRecords } from './db/schema';
import type { AnyBuilddDecisionKind } from './decision-kinds';
import {
  computeDecisionReadout,
  type CollectionConfig,
  type DecisionReadout,
  type ReadoutRows,
} from './decision-readout';

export const DECISION_READOUT_MAX_ROWS = 5_000;
const ID_CHUNK = 500;
export const DEFAULT_MIN_LABELLED = 30;

export interface DecisionReadoutWindow {
  teamId: string;
  workspaceId?: string | null;
  /** The kind id (`decision_records.capability` for kind rows). */
  kind: string;
  since: Date;
  until: Date;
}

export function decisionReadoutRecordsWhere(w: DecisionReadoutWindow) {
  const clauses = [
    eq(decisionRecords.teamId, w.teamId),
    eq(decisionRecords.capability, w.kind),
    gte(decisionRecords.createdAt, w.since),
    lt(decisionRecords.createdAt, w.until),
  ];
  if (w.workspaceId) clauses.push(eq(decisionRecords.workspaceId, w.workspaceId));
  return and(...clauses);
}

function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Load the rows for a window. Throws on a DB error (the caller decides). */
export async function loadDecisionReadoutRows(w: DecisionReadoutWindow): Promise<ReadoutRows> {
  const { db } = await import('./db/client');
  const raw = await db.select({
    id: decisionRecords.id,
    status: decisionRecords.status,
    applied: decisionRecords.applied,
    appliedAnswer: decisionRecords.appliedAnswer,
    policyVersion: decisionRecords.policyVersion,
    provider: decisionRecords.provider,
    model: decisionRecords.model,
    attemptCount: decisionRecords.attemptCount,
    escalated: decisionRecords.escalated,
    failureClass: decisionRecords.failureClass,
    subjectType: decisionRecords.subjectType,
    subjectId: decisionRecords.subjectId,
    latencyMs: decisionRecords.latencyMs,
    costUsd: decisionRecords.costUsd,
    experimentId: decisionRecords.experimentId,
    experimentArm: decisionRecords.experimentArm,
  }).from(decisionRecords)
    .where(decisionReadoutRecordsWhere(w))
    .orderBy(decisionRecords.createdAt)
    .limit(DECISION_READOUT_MAX_ROWS + 1);
  const truncated = raw.length > DECISION_READOUT_MAX_ROWS;
  const records = raw.slice(0, DECISION_READOUT_MAX_ROWS);

  const outcomes: ReadoutRows['outcomes'] = [];
  const challengers: ReadoutRows['challengers'] = [];
  for (const ids of chunks(records.map(r => r.id), ID_CHUNK)) {
    outcomes.push(...await db.select({
      decisionRecordId: decisionOutcomes.decisionRecordId,
      source: decisionOutcomes.source,
      label: decisionOutcomes.label,
      value: decisionOutcomes.value,
    }).from(decisionOutcomes)
      .where(and(eq(decisionOutcomes.teamId, w.teamId), inArray(decisionOutcomes.decisionRecordId, ids)))
      .orderBy(decisionOutcomes.recordedAt));
    challengers.push(...await db.select({
      decisionRecordId: decisionChallengerRuns.decisionRecordId,
      challengerKey: decisionChallengerRuns.challengerKey,
      status: decisionChallengerRuns.status,
      skipReason: decisionChallengerRuns.skipReason,
      provider: decisionChallengerRuns.provider,
      model: decisionChallengerRuns.model,
      outcome: decisionChallengerRuns.outcome,
      decision: decisionChallengerRuns.decision,
      agrees: decisionChallengerRuns.agrees,
      failureKind: decisionChallengerRuns.failureKind,
      latencyMs: decisionChallengerRuns.latencyMs,
      costUsd: decisionChallengerRuns.costUsd,
    }).from(decisionChallengerRuns)
      .where(and(eq(decisionChallengerRuns.teamId, w.teamId), inArray(decisionChallengerRuns.decisionRecordId, ids))));
  }
  return { records, outcomes, challengers, truncated };
}

/** The team's access state for a capability, without spending. Never throws: an error reads `unknown`. */
export async function resolveCollectionAccess(
  kind: AnyBuilddDecisionKind,
  scope: { teamId: string; workspaceId?: string | null },
): Promise<CollectionConfig['access']> {
  try {
    const { resolveDecisionAccess } = await import('./decision-client');
    const access = await resolveDecisionAccess({ capability: kind.binding.capability, teamId: scope.teamId, workspaceId: scope.workspaceId });
    if (access.ok) return 'enabled';
    return access.error.kind === 'capability_disabled' ? 'capability_disabled' : 'missing_key';
  } catch (e) {
    console.warn(`[decision-readout] access lookup failed for ${kind.kind}:`, (e as Error)?.message ?? e);
    return 'unknown';
  }
}

export interface DecisionReadoutDeps {
  loadRows?: typeof loadDecisionReadoutRows;
  resolveAccess?: typeof resolveCollectionAccess;
}

export interface KindReadout {
  kind: string;
  /** False: the kind is not defined in this process, so access and eligibility are unknown. */
  registered: boolean;
  window: { since: string; until: string };
  readout: DecisionReadout;
}

/**
 * The readout for one kind. `kind` is a registered kind, or a bare kind id
 * (rows only: access and eligibility read as unknown, nothing is scored).
 */
export async function readDecisionKindReadout(
  kind: AnyBuilddDecisionKind | string,
  window: Omit<DecisionReadoutWindow, 'kind'>,
  deps: DecisionReadoutDeps = {},
): Promise<KindReadout> {
  const def = typeof kind === 'string' ? null : kind;
  const kindId = typeof kind === 'string' ? kind : kind.kind;
  const adapter = def?.binding.readout;
  const scope = { teamId: window.teamId, workspaceId: window.workspaceId ?? null };

  const [rows, access, eligibleSubjects] = await Promise.all([
    (deps.loadRows ?? loadDecisionReadoutRows)({ ...window, kind: kindId }),
    def ? (deps.resolveAccess ?? resolveCollectionAccess)(def, scope) : Promise.resolve('unknown' as const),
    adapter?.eligibleSubjects
      ? adapter.eligibleSubjects({ ...scope, since: window.since, until: window.until }).catch(e => {
        console.warn(`[decision-readout] eligible-subject count failed for ${kindId}:`, (e as Error)?.message ?? e);
        return null;
      })
      : Promise.resolve(null),
  ]);

  return {
    kind: kindId,
    registered: !!def,
    window: { since: window.since.toISOString(), until: window.until.toISOString() },
    readout: computeDecisionReadout(
      { ...rows, challengerConfigured: !!def?.binding.challenger },
      { access, eligibleSubjects },
      { minLabelled: adapter?.minLabelled ?? DEFAULT_MIN_LABELLED, ...(adapter?.objective ? { objective: adapter.objective } : {}) },
    ),
  };
}
