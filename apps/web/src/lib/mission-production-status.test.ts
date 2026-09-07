import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// ── db mock ──────────────────────────────────────────────────────────────────
// Same discipline as mission-ship-state.test.ts: capture the built query and
// render it with PgDialect rather than trusting that "a query ran".

let capturedWhere: unknown = null;
let selectRows: Array<Record<string, unknown>> = [];
let selectCallCount = 0;

const mockSelect = mock(() => {
  selectCallCount++;
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.innerJoin = () => chain;
  chain.where = (pred: unknown) => {
    capturedWhere = pred;
    return Promise.resolve(selectRows);
  };
  return chain;
});

mock.module('@buildd/core/db', () => ({ db: { select: mockSelect } }));

// findMissionPrOwner has its own test file (mission-pr.test.ts) — stub it here
// rather than re-deriving worker rows, since this module only needs to trust
// its return shape, not re-verify how it is computed.
let ownerResult: { taskId: string; workerId: string; prNumber: number | null; prUrl: string; mergedAt: Date | null; state: 'open' | 'merged' | 'closed' } | null = null;
const mockFindMissionPrOwner = mock(async () => ownerResult);
mock.module('@/lib/mission-pr', () => ({ findMissionPrOwner: mockFindMissionPrOwner }));

import {
  classifyMissionProductionStatus,
  loadMissionProductionStatus,
  type MissionProductionEvidence,
} from './mission-production-status';
import { RELEASE_INVARIANT_CUTOFF } from './mission-invariants';

const dialect = new PgDialect();
function render(frag: unknown): string {
  return dialect.sqlToQuery(frag as never).sql.replace(/\s+/g, ' ').trim();
}
function renderParams(frag: unknown): unknown[] {
  return dialect.sqlToQuery(frag as never).params;
}

// ── classifyMissionProductionStatus — pure ──────────────────────────────────

describe('classifyMissionProductionStatus', () => {
  it('is unavailable — never not_yet_in_production — when there is no single mission-PR sha to check', () => {
    // The design doc is explicit: a mission that predates the branch strategy
    // (or never opted in) must render as unknown, not as a false "not shipped".
    const out = classifyMissionProductionStatus(null);
    expect(out.kind).toBe('unavailable');
  });

  it('reads not_yet_in_production while the mission PR is still open', () => {
    const evidence: MissionProductionEvidence = { prState: 'open', containedInHealthyRelease: false };
    expect(classifyMissionProductionStatus(evidence)).toEqual({ kind: 'value', value: 'not_yet_in_production' });
  });

  it('reads not_yet_in_production when the mission PR closed unmerged', () => {
    const evidence: MissionProductionEvidence = { prState: 'closed', containedInHealthyRelease: false };
    expect(classifyMissionProductionStatus(evidence)).toEqual({ kind: 'value', value: 'not_yet_in_production' });
  });

  it('reads not_yet_in_production when the mission PR merged but no healthy release contains it', () => {
    const evidence: MissionProductionEvidence = { prState: 'merged', containedInHealthyRelease: false };
    expect(classifyMissionProductionStatus(evidence)).toEqual({ kind: 'value', value: 'not_yet_in_production' });
  });

  it('reads in_production when the mission PR merge commit is contained in a healthy release', () => {
    const evidence: MissionProductionEvidence = { prState: 'merged', containedInHealthyRelease: true };
    expect(classifyMissionProductionStatus(evidence)).toEqual({ kind: 'value', value: 'in_production' });
  });
});

// ── loadMissionProductionStatus — loader ────────────────────────────────────

describe('loadMissionProductionStatus', () => {
  beforeEach(() => {
    mockSelect.mockClear();
    mockFindMissionPrOwner.mockClear();
    selectCallCount = 0;
    capturedWhere = null;
    selectRows = [];
    ownerResult = null;
  });

  it('is unavailable and issues NO release query for a mission with no mission-PR owner', async () => {
    ownerResult = null;
    const out = await loadMissionProductionStatus('m-1');
    expect(out.kind).toBe('unavailable');
    expect(selectCallCount).toBe(0);
  });

  it('is not_yet_in_production and issues NO release query while the mission PR is open', async () => {
    ownerResult = { taskId: 't-1', workerId: 'w-1', prNumber: 5, prUrl: 'https://x/5', mergedAt: null, state: 'open' };
    const out = await loadMissionProductionStatus('m-1');
    expect(out).toEqual({ kind: 'value', value: 'not_yet_in_production' });
    expect(selectCallCount).toBe(0);
  });

  it('is not_yet_in_production and issues NO release query when the mission PR closed unmerged', async () => {
    ownerResult = { taskId: 't-1', workerId: 'w-1', prNumber: 5, prUrl: 'https://x/5', mergedAt: null, state: 'closed' };
    const out = await loadMissionProductionStatus('m-1');
    expect(out).toEqual({ kind: 'value', value: 'not_yet_in_production' });
    expect(selectCallCount).toBe(0);
  });

  it('queries containment scoped to the mission-PR-owning task only, once merged', async () => {
    ownerResult = { taskId: 't-owner', workerId: 'w-1', prNumber: 9, prUrl: 'https://x/9', mergedAt: new Date(), state: 'merged' };
    selectRows = [{ count: 1 }];

    const out = await loadMissionProductionStatus('m-1');

    expect(out).toEqual({ kind: 'value', value: 'in_production' });
    expect(selectCallCount).toBe(1);
    const where = render(capturedWhere);
    expect(where).toContain('"release_tasks"."task_id" = ');
    expect(renderParams(capturedWhere)).toContain('t-owner');
    expect(where).toContain('"releases"."state" = ');
    expect(renderParams(capturedWhere)).toContain('healthy');
    // A release row with a null head sha must never count as evidence.
    expect(where).toContain('"releases"."head_sha" is not null');
    // Nor may a release dispatched before the head-sha repair — the two known
    // NULL-head rows are excluded by cutoff, not by treating them as evidence.
    expect(where).toContain('"releases"."dispatched_at" is not null');
    expect(where).toMatch(/"releases"\."dispatched_at" >= /);
    expect(renderParams(capturedWhere)).toContain(RELEASE_INVARIANT_CUTOFF.toISOString());
  });

  it('is not_yet_in_production when the mission PR merged but nothing healthy contains it', async () => {
    ownerResult = { taskId: 't-owner', workerId: 'w-1', prNumber: 9, prUrl: 'https://x/9', mergedAt: new Date(), state: 'merged' };
    selectRows = [{ count: 0 }];

    const out = await loadMissionProductionStatus('m-1');
    expect(out).toEqual({ kind: 'value', value: 'not_yet_in_production' });
  });

  it('is not_yet_in_production, not unavailable, when the row set comes back empty', async () => {
    ownerResult = { taskId: 't-owner', workerId: 'w-1', prNumber: 9, prUrl: 'https://x/9', mergedAt: new Date(), state: 'merged' };
    selectRows = [];

    const out = await loadMissionProductionStatus('m-1');
    expect(out).toEqual({ kind: 'value', value: 'not_yet_in_production' });
  });
});
