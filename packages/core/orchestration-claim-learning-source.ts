/** Global coordination-policy cells; evidence panels remain workspace scoped. */
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from './db';
import { gateEvents, orchestrationDecisions, systemCache } from './db/schema';
import { CLAIM_HOLD_DECISION } from './orchestration-claim-decision';
import { summarizeClaimHoldReadout } from './orchestration-claim-readout';
import { evaluateClaimLearningCell, type ClaimLearningPolicy } from './orchestration-claim-learning';
import { loadClaimLearningWorkspace } from './orchestration-claim-learning-input';
import { DIAL_SETTINGS, type Dial } from './tier-dial';

export const CLAIM_LEARNING_GATES = ['advisory_manifest', 'open_pr_overlap', 'soft_overlap'] as const;

export const CLAIM_LEARNING_AREAS = ['core/db', 'other', 'unknown'] as const;
const PREFIX = 'orchestration:claim-learning:v1:';
const DAY = 86400000;
interface StoredCell {
  revision: number;
  policy: ClaimLearningPolicy;
  fingerprint: string;
  lastChange: string;
  why: string;
}

function validCell(gate: string, area: string) {
  return (CLAIM_LEARNING_GATES as readonly string[]).includes(gate) && (CLAIM_LEARNING_AREAS as readonly string[]).includes(area);
}

function keyOf(gate: string, area: string) {
  return `${PREFIX}${gate}:${area}`;
}

/** The undeclared advisory-manifest gate is intentionally eligible without code paths.
 * Coordination-state uncertainty is rejected by claim eligibility before this dial.
 */
function holdsUnclassifiedCell(gate: string, area: string): boolean {
  return area === 'unknown' && gate !== 'advisory_manifest';
}

function bootstrap(gate: string, area: string, now = new Date()): ClaimLearningPolicy {
  const held = holdsUnclassifiedCell(gate, area);
  return {
    delta: .05, minSamplePerArm: 20, minConfidence: .85, fraction: held ? 0 : 1, dial: held ? 1 : 5, record: {
      state: held ? 'always' : 'shifted', since: now.toISOString(), alternateArmId: held ? null : 'jev_start'
    }
  };
}

async function readCell(gate: string, area: string, now = new Date()): Promise<StoredCell> {
  if (!validCell(gate, area)) {
    throw new Error('Unknown claim-learning cell');
  }
  const [row] = await db.select({ value: systemCache.value }).from(systemCache).where(eq(systemCache.key, keyOf(gate, area))).limit(1);
  if (!row) {
    return {
      revision: 0, policy: bootstrap(gate, area, now), fingerprint: CLAIM_HOLD_DECISION.fingerprint, lastChange: now.toISOString(), why: 'existing live bootstrap; no calibrated evidence yet'
    };
  }
  const stored = row.value as StoredCell;
  if (!stored || !Number.isInteger(stored.revision) || stored.revision < 0 || !stored.policy || !stored.policy.record || !Number.isFinite(stored.policy.fraction) || stored.policy.fraction < 0 || stored.policy.fraction > 1 || !Number.isFinite(stored.policy.minConfidence) || stored.policy.minConfidence < 0 || stored.policy.minConfidence > 1 || !Number.isFinite(stored.policy.delta) || stored.policy.delta < 0 || stored.policy.delta > 1 || ![1, 2, 3, 4, 5].includes(stored.policy.dial) || !['always', 'learning', 'shifted', 'reverted'].includes(stored.policy.record.state)) {
    throw new Error('Invalid claim-learning policy');
  }
  const record = stored.policy.record;
  const timestamps = [record.since, record.evidenceSince, record.revertedAt, record.evaluatedAt, stored.lastChange];
  if (typeof record.since !== 'string' || timestamps.some(value => value !== undefined && (typeof value !== 'string' || !Number.isFinite(Date.parse(value))))) {
    throw new Error('Invalid claim-learning policy');
  }
  // Unclassified overlap cells remain closed; undeclared manifests retain their eligible advisory path.
  const normalized = stored.fingerprint !== CLAIM_HOLD_DECISION.fingerprint ? {
    ...stored, lastChange: now.toISOString(), why: 'prompt fingerprint changed: confidence reset to 0.85; new evidence boundary', policy: {
      ...stored.policy, minConfidence: .85, record: {
        ...stored.policy.record, evidenceSince: now.toISOString()
      }
    }
  } : stored;
  return holdsUnclassifiedCell(gate, area) ? {
    ...normalized, policy: {
      ...normalized.policy, minConfidence: .85, fraction: 0, dial: 1, record: {
        ...normalized.policy.record, state: 'always', alternateArmId: null
      }
    }
  } : normalized;
}

export async function loadClaimLearningPolicy(gate: string, area: string): Promise<ClaimLearningPolicy> {
  return (await readCell(gate, area)).policy;
}
/** CAS and immutable event insertion share one SQL statement, supported by neon-http. */

async function writeCell(gate: string, area: string, expected: number, next: StoredCell, event: Record<string, unknown>, now: Date): Promise<boolean> {
  const key = keyOf(gate, area);
  const result = await db.execute(sql `WITH eligible AS (
 SELECT 1 WHERE ${expected}=0 OR EXISTS (SELECT 1 FROM system_cache WHERE key=${key} AND COALESCE((value->>'revision')::integer,0)=${expected})
 ), changed AS (
 INSERT INTO system_cache (key,value,updated_at,expires_at)
 SELECT ${key},${JSON.stringify(next)}::jsonb,${now},NULL FROM eligible WHERE true
 ON CONFLICT (key) DO UPDATE SET value=${JSON.stringify(next)}::jsonb,updated_at=${now}
 WHERE COALESCE((system_cache.value->>'revision')::integer,0)=${expected}
 RETURNING key,value
 ), event AS (
 INSERT INTO system_cache (key,value,updated_at,expires_at)
 SELECT ${`${key}:event:${next.revision}`},${JSON.stringify(event)}::jsonb,${now},NULL FROM changed RETURNING key
 ) SELECT value FROM changed`);
  return Array.isArray(result) ? result.length > 0 : ((result as {
    rows?: unknown[];
  }).rows?.length ?? 0) > 0;
}

export async function changeClaimLearningPolicy(args: {
  gate: string;
  area: string;
  expectedRevision: number;
  reason: string;
  actorAccountId: string;
  operation: 'pin' | 'revert' | 'set_delta';
  fraction?: number;
  delta?: number;
}) {
  const rejected = (error: string) => ({
    status: 'rejected' as const, revision: args.expectedRevision, policy: null, error
  });
  if (!['pin', 'revert', 'set_delta'].includes(args.operation) || !args.actorAccountId.trim() || !validCell(args.gate, args.area) || !args.reason.trim() || !Number.isInteger(args.expectedRevision) || args.expectedRevision < 0) {
    return rejected('A valid cell, revision and reason are required');
  }
  if (args.operation === 'set_delta' && (!Number.isFinite(args.delta) || args.delta! < 0 || args.delta! > 1)) {
    return rejected('Delta must be between zero and one');
  }
  if (args.operation === 'pin' && (args.fraction === undefined || ![0, .25, .5, .75, 1].includes(args.fraction))) {
    return rejected('Pin requires an existing dial share');
  }
  if (holdsUnclassifiedCell(args.gate, args.area) && args.operation === 'pin' && args.fraction !== 0) {
    return rejected('Unknown scope must remain deterministic HOLD');
  }
  const current = await readCell(args.gate, args.area);
  if (current.revision !== args.expectedRevision) {
    return {
      status: 'stale' as const, revision: current.revision, policy: current.policy
    };
  }
  const now = new Date(), at = now.toISOString();
  let policy = { ...current.policy };
  if (args.operation === 'set_delta') {
    policy = {
      ...policy, delta: args.delta!
    };
  }
  else if (args.operation === 'pin') {
    const dial = (Object.keys(DIAL_SETTINGS).map(Number).find(d => DIAL_SETTINGS[d as Dial].maxShare === args.fraction) ?? 1) as Dial;
    // A pin limits automatic changes; it cannot start a reverted cell during cooldown.
    policy = {
      ...policy, pinned: true, dial, fraction: policy.record.state === 'reverted' ? 0 : args.fraction!, record: policy.record.state === 'reverted' ? policy.record : {
        ...policy.record, state: args.fraction === 0 ? 'always' : 'shifted', alternateArmId: args.fraction === 0 ? null : 'jev_start', since: at
      }
    };
  }
  else {
    policy = {
      ...policy, fraction: 0, record: {
        state: 'reverted', since: at, revertedAt: at, evidenceSince: at, revertReason: args.reason, revertedFrom: 'Jev START', alternateArmId: null
      }
    };
  }
  const next = {
    ...current, revision: current.revision + 1, policy, lastChange: at, why: args.reason
  };
  const ok = await writeCell(args.gate, args.area, current.revision, next, {
    kind: 'owner_policy_change', operation: args.operation, actorAccountId: args.actorAccountId, reason: args.reason, before: current.policy, after: policy, at
  }, now);
  if (!ok) {
    const actual = await readCell(args.gate, args.area);
    return {
      status: 'stale' as const, revision: actual.revision, policy: actual.policy
    };
  }
  return {
    status: 'applied' as const, revision: next.revision, policy
  };
}

async function activeWorkspaceIds(since: Date) {
  const [decisions, starts] = await Promise.all([
    db.selectDistinct({ workspaceId: orchestrationDecisions.workspaceId }).from(orchestrationDecisions).where(and(gte(orchestrationDecisions.createdAt, since), sql `${orchestrationDecisions.decisionId} IN (${CLAIM_HOLD_DECISION.id},'buildd.human_force_start')`)).limit(501),
    db.selectDistinct({ workspaceId: gateEvents.workspaceId }).from(gateEvents).where(and(gte(gateEvents.occurredAt, since), eq(gateEvents.gate, 'claim_loop_deferral'), eq(gateEvents.outcome, 'accepted'), eq(gateEvents.reason, 'claim_learning_clean_start'))).limit(501),
  ]);
  return [...new Set([...decisions, ...starts].map(r => r.workspaceId).filter((id): id is string => id !== null))].map(workspaceId => ({ workspaceId }));
}
type WorkspaceEvidence = Awaited<ReturnType<typeof loadClaimLearningWorkspace>>;

function inputForCell(evidence: WorkspaceEvidence[], gate: string, area: string, stored: StoredCell, now: Date) {
  const since = stored.policy.record.evidenceSince ? Date.parse(stored.policy.record.evidenceSince) : -Infinity;
  const rows = evidence.flatMap(e => e.outcomes).filter(r => r.gate === gate && r.area === area);
  const learned = rows.filter(r => r.at.getTime() >= since);
  return {
    gate, area, fingerprint: CLAIM_HOLD_DECISION.fingerprint, now, prior: stored.policy,
    outcomes: [...learned.filter(r => r.actor !== 'human_force' && r.fingerprint === CLAIM_HOLD_DECISION.fingerprint), ...rows.filter(r => r.actor === 'human_force')],
    baseline: learned.filter(r => r.actor === 'rule_start_clean'),
    controlOutcomes: learned.filter(r => (r.actor === 'jev_hold' && r.fingerprint === CLAIM_HOLD_DECISION.fingerprint) || r.actor === 'deterministic_hold')
  };
}

export async function loadClaimLearningPanel(args: {
  workspaceIds: string[];
  platformWide: boolean;
  window: '24h' | '7d' | '30d';
  now?: Date;
}) {
  const now = args.now ?? new Date(), since = new Date(now.getTime() - (args.window === '24h' ? 1 : args.window === '7d' ? 7 : 30) * DAY);
  const discovered = args.platformWide ? await activeWorkspaceIds(since) : args.workspaceIds.map(workspaceId => ({ workspaceId }));
  const bounded = discovered.slice(0, 500);
  const evidence: WorkspaceEvidence[] = [];
  for (const { workspaceId } of bounded)
    evidence.push(await loadClaimLearningWorkspace({
      workspaceId, since, until: now
    }));
  const cells = [];
  for (const gate of CLAIM_LEARNING_GATES)
    for (const area of CLAIM_LEARNING_AREAS) {
      const stored = await readCell(gate, area, now);
      const evaluated = evaluateClaimLearningCell(inputForCell(evidence, gate, area, stored, now));
      cells.push({
        gate, area, fingerprint: CLAIM_HOLD_DECISION.fingerprint, revision: stored.revision, policy: stored.policy, lastChange: stored.lastChange, why: stored.why, safety: evaluated.safety, candidates: evaluated.candidates, ownershipHygiene: evaluated.ownershipHygiene
      });
    }
  return {
    window: args.window, generatedAt: now.toISOString(), observational: true, truncated: discovered.length > 500 || evidence.some(e => e.truncated), cells, readout: evidence.flatMap(e => summarizeClaimHoldReadout(e.input))
  };
}

export async function runClaimLearningStep(args: {
  now?: Date;
} = {}) {
  const now = args.now ?? new Date(), since = new Date(now.getTime() - 90 * DAY);
  const discovered = await activeWorkspaceIds(since);
  const evidence: WorkspaceEvidence[] = [];
  for (const { workspaceId } of discovered.slice(0, 500))
    evidence.push(await loadClaimLearningWorkspace({
      workspaceId, since, until: now
    }));
  const truncated = discovered.length > 500 || evidence.some(e => e.truncated);
  const results = [];
  for (const gate of CLAIM_LEARNING_GATES)
    for (const area of CLAIM_LEARNING_AREAS) {
      const current = await readCell(gate, area, now);
      const evaluated = evaluateClaimLearningCell(inputForCell(evidence, gate, area, current, now));
      // Partial evidence must never authorize an increase; safety reverts still apply.
      const blocked = truncated && (evaluated.policy.fraction > current.policy.fraction || evaluated.policy.minConfidence < current.policy.minConfidence);
      const policy = holdsUnclassifiedCell(gate, area) ? current.policy : blocked ? current.policy : evaluated.policy;
      const fingerprintChanged = current.fingerprint !== CLAIM_HOLD_DECISION.fingerprint;
      const changed = fingerprintChanged || JSON.stringify(policy) !== JSON.stringify(current.policy);
      const why = blocked ? 'truncated evidence: promotion withheld' : evaluated.decision.event?.reason ?? (fingerprintChanged ? current.why : 'evaluated: no policy change');
      const next: StoredCell = {
        revision: current.revision + 1, policy, fingerprint: CLAIM_HOLD_DECISION.fingerprint, lastChange: changed ? now.toISOString() : current.lastChange, why: changed ? why : current.why
      };
      const applied = await writeCell(gate, area, current.revision, next, {
        kind: 'learning_evaluation', at: now.toISOString(), changed, reason: why, safety: evaluated.safety, candidates: evaluated.candidates, ownershipHygiene: evaluated.ownershipHygiene, truncated, before: current.policy, after: policy
      }, now);
      results.push({
        gate, area, applied, changed: applied && changed, reason: why
      });
    }
  return {
    evaluatedAt: now.toISOString(), truncated, cells: results
  };
}
