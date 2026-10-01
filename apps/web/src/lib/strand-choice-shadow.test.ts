import { describe, expect, it, mock } from 'bun:test';

mock.module('next/server', () => ({ after: (fn: () => unknown) => { void fn(); } }));

const { applyStrandChoice } = await import('./strand-choice-shadow');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const strandedRow = () => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000000', title: 'x', status: 'active', executor: 'local', teamId: 'team-1', workspaceId: 'ws',
  tasks: [{ id: 't', title: 't', status: 'pending', createdAt: new Date(NOW - 3 * 3600_000), workers: [] }],
});
const cta = () => ({ missionId: 'm', quietMs: 0, taskId: 't', claimable: 1, blockedReason: null, order: 'runner-first' as const });
const deps = (choice: string, confidence: number, calls: { n: number }) => ({
  resolveAccess: (async () => ({ ok: true, apiKey: 'k', model: 'jev' })) as any,
  decide: (async () => { calls.n++; return { ok: true, answers: { pick: { choice, confidence } }, model: 'jev', latencyMs: 1 }; }) as any,
  cache: new Map(), log: () => {},
});

describe('applyStrandChoice', () => {
  it('shadow: asks after the response and never changes the order', async () => {
    const calls = { n: 0 };
    const scheduled: Array<() => Promise<unknown>> = [];
    const card = { row: strandedRow() as any, strand: cta() };
    await applyStrandChoice([card], { now: NOW, mode: 'shadow', schedule: fn => { scheduled.push(fn); }, deps: deps('wait-for-local', 0.99, calls) });
    expect(calls.n).toBe(0);
    await scheduled[0]();
    expect(calls.n).toBe(1);
    expect(card.strand.order).toBe('runner-first');
  });

  it('gated: a confident wait-for-local orders Keep local first; never flips anything', async () => {
    const calls = { n: 0 };
    const card = { row: strandedRow() as any, strand: cta() };
    await applyStrandChoice([card], { now: NOW, mode: 'gated', deps: deps('wait-for-local', 0.99, calls) });
    expect(card.strand.order).toBe('local-first');
    expect(card.row.executor).toBe('local');
  });

  it('gated, decision fails: today’s order (fail open)', async () => {
    const card = { row: strandedRow() as any, strand: cta() };
    await applyStrandChoice([card], {
      now: NOW, mode: 'gated',
      deps: { resolveAccess: (async () => ({ ok: false, error: { kind: 'missing_key' } })) as any, cache: new Map(), log: () => {} },
    });
    expect(card.strand.order).toBe('runner-first');
  });

  it('a card that is not stranded is never asked about', async () => {
    const calls = { n: 0 };
    const row = { ...strandedRow(), executor: 'runner' };
    await applyStrandChoice([{ row: row as any, strand: cta() }], { now: NOW, mode: 'gated', deps: deps('wait-for-local', 0.99, calls) });
    expect(calls.n).toBe(0);
  });
});
