import { beforeEach, expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { CLAIM_HOLD_DECISION } from '../orchestration-claim-decision';
let cached: unknown = null;
let failRead = false;
let writes = 0;
let statements: SQL[] = [];
let staleWrite = false;
const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => {
          if (failRead) {
            throw new Error('fixture read failure');
          }
          return cached ? [{ value: cached }] : [];
        } }) }) }), execute: async (query: SQL) => {
    writes++;
    statements.push(query);
    if (staleWrite) {
      cached = policyRow(3);
      return [];
    }
    return [{ revision: 1 }];
  }
};
mock.module('../db', () => ({ db }));
mock.module('../orchestration-claim-learning-input', () => ({ loadClaimLearningWorkspace: async () => ({
    input: {
      decisions: [], labels: [], tasks: [], starts: [], windowEnd: new Date()
    }, outcomes: [], truncated: false
  }) }));
const { loadClaimLearningPolicy, changeClaimLearningPolicy } = await import('../orchestration-claim-learning-source');
beforeEach(() => {
  cached = null;
  failRead = false;
  writes = 0;
  statements = [];
  staleWrite = false;
});

test('missing global policy preserves the live bootstrap', async () => {
  const p = await loadClaimLearningPolicy('soft_overlap', 'other');
  expect(p.fraction).toBe(1);
  expect(p.minConfidence).toBe(.85);
});

test('unclassified overlap areas fail closed', async () => expect((await loadClaimLearningPolicy('soft_overlap', 'unknown')).fraction).toBe(0));

test('policy read errors propagate so serving fails closed', async () => {
  failRead = true;
  await expect(loadClaimLearningPolicy('soft_overlap', 'other')).rejects.toThrow('fixture read failure');
});

test('owner changes reject invalid delta before storage', async () => {
  const r = await changeClaimLearningPolicy({
    gate: 'soft_overlap', area: 'other', expectedRevision: 0, reason: 'fixture', actorAccountId: 'fixture', operation: 'set_delta', delta: NaN
  });
  expect(r.status).toBe('rejected');
  expect(writes).toBe(0);
});

test('owner changes compare revision', async () => {
  const r = await changeClaimLearningPolicy({
    gate: 'soft_overlap', area: 'other', expectedRevision: 2, reason: 'fixture', actorAccountId: 'fixture', operation: 'revert'
  });
  expect(r.status).toBe('stale');
  expect(writes).toBe(0);
});

test('owner cannot relax unclassified overlap scope', async () => {
  const r = await changeClaimLearningPolicy({
    gate: 'soft_overlap', area: 'unknown', expectedRevision: 0, reason: 'fixture', actorAccountId: 'fixture', operation: 'pin', fraction: 1
  });
  expect(r.status).toBe('rejected');
  expect(writes).toBe(0);
});

test('owner delta change is atomically persisted at the next revision', async () => {
  const r = await changeClaimLearningPolicy({
    gate: 'soft_overlap', area: 'other', expectedRevision: 0, reason: 'fixture', actorAccountId: 'fixture', operation: 'set_delta', delta: .03
  });
  expect(r.status).toBe('applied');
  expect(r.revision).toBe(1);
  expect(r.policy?.delta).toBe(.03);
  expect(writes).toBe(1);
});

test('corrupt policy fails closed', async () => {
  cached = {
    revision: 1, policy: {
      fraction: 1, minConfidence: NaN, record: { state: 'shifted' }
    }
  };
  await expect(loadClaimLearningPolicy('soft_overlap', 'other')).rejects.toThrow('Invalid claim-learning policy');
});

test('prompt changes reset calibration without releasing a rollback', async () => {
  cached = {
    revision: 2, fingerprint: 'old-prompt', lastChange: '2026-01-01', why: 'fixture', policy: {
      delta: .05, minConfidence: .65, minSamplePerArm: 20, fraction: 0, dial: 3, record: {
        state: 'reverted', since: '2026-01-01', revertedAt: '2026-01-01', evidenceSince: '2026-01-01'
      }
    }
  };
  const p = await loadClaimLearningPolicy('soft_overlap', 'other');
  expect(p.minConfidence).toBe(.85);
  expect(p.fraction).toBe(0);
  expect(p.record.state).toBe('reverted');
});

test('unknown scope keeps its persisted timestamp', async () => {
  cached = {
    revision: 2, fingerprint: 'fixture', lastChange: '2026-01-01', why: 'fixture', policy: {
      delta: .05, minConfidence: .85, fraction: 0, dial: 1, record: {
        state: 'always', since: '2026-01-01'
      }
    }
  };
  expect((await loadClaimLearningPolicy('soft_overlap', 'unknown')).record.since).toBe('2026-01-01');
});

function policyRow(revision: number) {
  return {
    revision,
    fingerprint: CLAIM_HOLD_DECISION.fingerprint,
    lastChange: '2026-01-01',
    why: 'fixture',
    policy: {
      delta: .05,
      minSamplePerArm: 20,
      minConfidence: .85,
      fraction: 1,
      dial: 5,
      record: { state: 'shifted', since: '2026-01-01', alternateArmId: 'jev_start' }
    }
  };
}

test('policy CAS and history append render as one revision-guarded PostgreSQL statement', async () => {
  cached = policyRow(2);
  const result = await changeClaimLearningPolicy({
    gate: 'soft_overlap',
    area: 'other',
    expectedRevision: 2,
    reason: 'fixture',
    actorAccountId: 'fixture',
    operation: 'set_delta',
    delta: .03
  });
  expect(result.status).toBe('applied');
  expect(statements).toHaveLength(1);
  const rendered = new PgDialect().sqlToQuery(statements[0]!);
  const statement = rendered.sql.replace(/\s+/g, ' ').trim();
  expect(statement).toMatch(/^WITH eligible AS \(/);
  expect(statement).toContain('FROM eligible WHERE true ON CONFLICT');
  expect(statement).toMatch(/ON CONFLICT \(key\) DO UPDATE SET/);
  expect(statement).toMatch(/WHERE COALESCE\(\(system_cache.value->>'revision'\)::integer,0\)=\$\d+/);
  expect(statement).toMatch(/event AS \( INSERT INTO system_cache .* FROM changed RETURNING key \) SELECT value FROM changed$/);
  expect(statement.match(/INSERT INTO system_cache/g)).toHaveLength(2);
  expect(statement).not.toContain(';');
  expect(rendered.params.filter(value => value === 2)).toHaveLength(3);
  expect(rendered.params).toContain('orchestration:claim-learning:v1:soft_overlap:other:event:3');
  const history = rendered.params.find(value => typeof value === 'string' && value.includes('owner_policy_change'));
  expect(JSON.parse(history as string)).toMatchObject({
    kind: 'owner_policy_change',
    operation: 'set_delta',
    reason: 'fixture',
    before: { delta: .05 },
    after: { delta: .03 }
  });
});

test('a concurrent CAS miss returns the current revision and never claims applied', async () => {
  cached = policyRow(2);
  staleWrite = true;
  const result = await changeClaimLearningPolicy({
    gate: 'soft_overlap',
    area: 'other',
    expectedRevision: 2,
    reason: 'fixture',
    actorAccountId: 'fixture',
    operation: 'revert'
  });
  expect(result.status).toBe('stale');
  expect(result.revision).toBe(3);
  expect(result.policy?.fraction).toBe(1);
  expect(statements).toHaveLength(1);
});

test('invalid persisted evidence boundary fails closed instead of silently suppressing evidence', async () => {
  cached = {
    ...policyRow(2),
    policy: {
      ...policyRow(2).policy,
      record: { ...policyRow(2).policy.record, evidenceSince: 'invalid-fixture-time' }
    }
  };
  await expect(loadClaimLearningPolicy('soft_overlap', 'other')).rejects.toThrow('Invalid claim-learning policy');
});

test('eligible undeclared advisory manifests retain the authorized live bootstrap', async () => {
  const policy = await loadClaimLearningPolicy('advisory_manifest', 'unknown');
  expect(policy.fraction).toBe(1);
  expect(policy.minConfidence).toBe(.85);
});

test('owner can pin the eligible undeclared advisory cell without bypassing coordination rails', async () => {
  const result = await changeClaimLearningPolicy({
    gate: 'advisory_manifest',
    area: 'unknown',
    expectedRevision: 0,
    reason: 'fixture',
    actorAccountId: 'fixture',
    operation: 'pin',
    fraction: .25
  });
  expect(result.status).toBe('applied');
  expect(result.policy?.fraction).toBe(.25);
});
