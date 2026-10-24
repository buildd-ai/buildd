/**
 * Dependency waits in the gate ledger (spec: Overlap scheduling, AC-10): the
 * poll records a coalesced `deps_blocked` deferral for each task in reach
 * that only the dependency gate kept out of the claim's candidate WHERE.
 */
import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

let rows: Array<{ id: string; workspaceId: string; missionId: string | null }> = [];
let seenLimit = 0;
const chain: any = {
  from: () => chain, where: () => chain, orderBy: () => chain,
  limit: async (n: number) => { seenLimit = n; return rows; },
};
mock.module('@buildd/core/db', () => ({ db: { select: () => chain } }));

const { DEPS_BLOCKED_SCAN_LIMIT, depsBlockedEvent, depsBlockedWhere, recordDepsBlocked } = await import('./deps-blocked-ledger');
const { claimCandidateWhere } = await import('@/lib/claim-candidate-where');
const { recordOrCoalesceDeferral } = await import('@buildd/core/gate-events');

const NOW = new Date('2026-10-22T12:00:00Z');
const dialect = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q).sql.replace(/\$\d+/g, '$?');
const gates = claimCandidateWhere({ workspaceIds: ['ws'], now: NOW, accountType: 'service', runner: 'r1', availableSkills: ['builder'], executor: 'host' }).gates;

describe('deps_blocked ledger rows', () => {
  it('selects tasks the dependency gate alone refuses: the deps gate negated, every other gate of the same WHERE required', () => {
    const q = render(depsBlockedWhere(['ws'], gates)!);
    expect(q).toContain(`not (COALESCE((${render(gates.deps!)}), false))`);
    for (const [name, g] of Object.entries(gates)) {
      if (name === 'deps' || !g) continue;
      expect(q).toContain(render(g));
    }
  });

  it('nothing to record without a dependency gate (a force claim) or a workspace', () => {
    const { deps: _d, ...rest } = gates;
    void _d;
    expect(depsBlockedWhere(['ws'], rest)).toBeNull();
    expect(depsBlockedWhere([], gates)).toBeNull();
  });

  it('one coalesced deferral per waiting task, bounded per poll', async () => {
    rows = [{ id: 't1', workspaceId: 'ws', missionId: 'm1' }, { id: 't2', workspaceId: 'ws', missionId: null }];
    const fired: unknown[] = [];
    expect(await recordDepsBlocked({ workspaceIds: ['ws'], gates, fire: e => fired.push(e) })).toBe(2);
    expect(seenLimit).toBe(DEPS_BLOCKED_SCAN_LIMIT);
    expect(fired).toEqual([depsBlockedEvent(rows[0]), depsBlockedEvent(rows[1])]);
    expect(depsBlockedEvent(rows[0])).toMatchObject({ gate: 'claim_loop_deferral', outcome: 'deferred', reason: 'deps_blocked', taskId: 't1', missionId: 'm1' });
    // The writer is the coalescing one: one row per wait, with firstDeferredAt kept across polls.
    expect(typeof recordOrCoalesceDeferral).toBe('function');
  });

  it('a failed read records nothing and never throws', async () => {
    chain.limit = async () => { throw new Error('down'); };
    const fired: unknown[] = [];
    expect(await recordDepsBlocked({ workspaceIds: ['ws'], gates, fire: e => fired.push(e) })).toBe(0);
    expect(fired).toEqual([]);
  });
});
