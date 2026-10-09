/**
 * S15 cycles, the sweep half (seam.ts `restartTreadmillCycles`): a treadmill
 * escalation past the cooldown is restarted through the reducer, pinned to the
 * version the candidate read named; a refusal leaves it with a person.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Command } from './commands';
import type { CommandResult } from './kernel';
import { restartTreadmillCycles } from './seam';

const dialect = new PgDialect();
const row = (o: Record<string, unknown> = {}) => ({ id: 'd1', version: '9', workspace_id: 'w1', repo_full_name: 'acme/widgets', pr_number: '7', ...o });
const current = { state: 'APPROVED', version: 10, head: 'H1', round: 1 };

function harness(rows: Array<Record<string, unknown>>, answer: (cmd: Command) => CommandResult, owner: (id: string) => string | null = (id) => id) {
  const queries: string[] = [];
  const applied: Array<{ cmd: Command; deliveryId: string | undefined }> = [];
  const drained: string[] = [];
  const deps = {
    exec: async (q: SQL) => { queries.push(dialect.sqlToQuery(q).sql); return { rows }; },
    owned: async (_w: string, _r: string, _n: number) => owner(String(rows[0]?.id ?? '')),
    apply: (async (cmd: Command, opts: { ref?: { deliveryId?: string } } = {}) => { applied.push({ cmd, deliveryId: opts.ref?.deliveryId }); return answer(cmd); }) as never,
    drain: async (id: string) => { drained.push(id); },
  };
  return { deps, queries, applied, drained };
}

describe('restartTreadmillCycles', () => {
  test('restarts each candidate pinned to the version it read, then drains it', async () => {
    const h = harness([row()], () => ({ result: 'applied', decision: {} as never, current } as unknown as CommandResult));
    const s = await restartTreadmillCycles({ cooldownMs: 3_600_000 }, h.deps);
    expect(s).toEqual({ checked: 1, restarted: 1, refused: 0, errors: 0 });
    expect(h.queries[0]).toContain('workflow:treadmill_cycle_candidates');
    expect(h.applied).toEqual([{ cmd: { type: 'TreadmillCycleRestarted', actor: 'sweep:treadmill-cycle', expectedVersion: 9 }, deliveryId: 'd1' }]);
    expect(h.drained).toEqual(['d1']);
  });

  test('a refusal (cycles used up, moved since the read) is counted and nothing drains', async () => {
    const h = harness([row()], () => ({ result: 'rejected', reason: 'treadmill_cycles_exhausted', current } as CommandResult));
    const s = await restartTreadmillCycles({ cooldownMs: 1 }, h.deps);
    expect(s).toEqual({ checked: 1, restarted: 0, refused: 1, errors: 0 });
    expect(h.drained).toEqual([]);
  });

  test('a delivery released to legacy is skipped', async () => {
    const h = harness([row()], () => { throw new Error('must not apply'); }, () => null);
    const s = await restartTreadmillCycles({ cooldownMs: 1 }, h.deps);
    expect(s).toEqual({ checked: 0, restarted: 0, refused: 0, errors: 0 });
    expect(h.applied).toEqual([]);
  });

  test('one failing delivery does not stop the pass', async () => {
    const h = harness([row(), row({ id: 'd2' })], () => { throw new Error('boom'); }, (id) => id);
    h.deps.owned = async () => 'd1';
    const s = await restartTreadmillCycles({ cooldownMs: 1 }, h.deps);
    expect(s.errors).toBe(1);
    expect(s.checked).toBe(1);
  });
});
