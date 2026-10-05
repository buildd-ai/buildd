import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { HOLD_RESURFACE_MS } from '@buildd/core/question-gate';
import { resolveHold, resurfaceHeldQuestions, type ParkedQuestion } from './question-hold';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOLD = {
  type: 'question',
  prompt: 'Should the export use CSV or JSON?',
  options: [{ label: 'CSV' }, { label: 'JSON' }],
  disposition: 'hold',
  holdReason: 'Held.',
  resurfaceAt: new Date(NOW + 10 * 60_000).toISOString(),
};
const base = { stored: null, sensitive: false, gitConfig: null, pathManifest: ['apps/web/src/lib/export.ts'], nowMs: NOW };

describe('resolveHold', () => {
  it('an ask is not held', () => {
    const { disposition: _d, holdReason: _r, resurfaceAt: _a, ...ask } = HOLD;
    expect(resolveHold({ ...base, waitingFor: ask }).held).toBe(false);
  });

  it('honours a hold and keeps a deadline inside the bound', () => {
    const r = resolveHold({ ...base, waitingFor: HOLD });
    expect(r.held).toBe(true);
    if (r.held !== true) return;
    expect(r.resurfaceAtMs).toBe(NOW + 10 * 60_000);
    expect(r.waitingFor.disposition).toBe('hold');
  });

  it('clamps a deadline past the bound, and defaults a missing one to it', () => {
    const far = resolveHold({ ...base, waitingFor: { ...HOLD, resurfaceAt: new Date(NOW + 86_400_000).toISOString() } });
    expect(far.held === true && far.resurfaceAtMs).toBe(NOW + HOLD_RESURFACE_MS);
    const { resurfaceAt: _a, ...noDeadline } = HOLD;
    const none = resolveHold({ ...base, waitingFor: noDeadline });
    expect(none.held === true && none.resurfaceAtMs).toBe(NOW + HOLD_RESURFACE_MS);
    expect(none.waitingFor.resurfaceAt).toBe(new Date(NOW + HOLD_RESURFACE_MS).toISOString());
  });

  it.each([
    ['a migration path', { pathManifest: ['packages/core/drizzle/0001_x.sql'] }],
    ['a CI path', { pathManifest: ['.github/workflows/build.yml'] }],
    ['a workspace-protected path', { gitConfig: { autoMergeDenyPaths: ['apps/web/src/lib/export.ts'] } as any }],
  ])('a hard rail (%s) always asks, whatever the runner sent', (_name, over) => {
    const r = resolveHold({ ...base, ...over, waitingFor: HOLD });
    expect(r.held).toBe(false);
    expect(r.waitingFor.disposition).toBeUndefined();
    expect(r.waitingFor.resurfaceAt).toBeUndefined();
  });

  it('a spending question always asks', () => {
    const r = resolveHold({ ...base, waitingFor: { ...HOLD, prompt: 'Should I upgrade the plan to raise the budget?' } });
    expect(r.held).toBe(false);
  });

  it('a sensitive workspace or the kill switch always asks', () => {
    expect(resolveHold({ ...base, sensitive: true, waitingFor: HOLD }).held).toBe(false);
    expect(resolveHold({ ...base, gitConfig: { jevQuestionGate: false } as any, waitingFor: HOLD }).held).toBe(false);
  });

  it('a re-sent copy keeps the first deadline instead of pushing it out', () => {
    const stored = { ...HOLD, resurfaceAt: new Date(NOW - 60_000).toISOString() };
    const r = resolveHold({ ...base, stored, waitingFor: { ...HOLD, resurfaceAt: new Date(NOW + 14 * 60_000).toISOString() } });
    expect(r.held === true && r.resurfaceAtMs).toBe(NOW - 60_000);
  });

  it('a re-sent copy of a hold that already surfaced stays settled', () => {
    const stored = { ...HOLD, holdSettledAt: new Date(NOW).toISOString(), holdOutcome: 'resurfaced' };
    const r = resolveHold({ ...base, stored, waitingFor: HOLD });
    expect(r.held).toBe('settled');
    expect(r.waitingFor.holdSettledAt).toBe(stored.holdSettledAt);
  });
});

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q).sql;

function fakeDb(rows: any[], settleWins: (id: string) => boolean) {
  const statements: string[] = [];
  const exec = async (q: SQL) => {
    const text = render(q);
    statements.push(text);
    if (text.trim().startsWith('UPDATE')) {
      const id = dialect.sqlToQuery(q).params.find(p => rows.some(r => r.id === p)) as string;
      return { rows: settleWins(id) ? [{ id }] : [] };
    }
    return { rows };
  };
  return { exec, statements };
}

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'worker-1', workspaceId: 'ws-1', taskId: 'task-1', waitingFor: HOLD,
  resurfaceAt: new Date(NOW - 1000).toISOString(), taskStatus: 'in_progress', dataClass: 'standard', ...over,
});

function queue() {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    q: { clearThrough: async (n: number) => { calls.push(['clear', n]); }, reseed: async (e: any) => { calls.push(['reseed', e]); } },
  };
}

describe('resurfaceHeldQuestions', () => {
  it('notifies a due, unanswered hold once, and a second tick that loses the claim does not', async () => {
    const notified: ParkedQuestion[] = [];
    let settled = false;
    const { exec, statements } = fakeDb([row()], () => { if (settled) return false; settled = true; return true; });
    const { q } = queue();
    const deps = { exec, now: () => new Date(NOW), notify: (p: ParkedQuestion) => notified.push(p), queue: q };

    const first = await resurfaceHeldQuestions({ floor: false, notify: deps.notify }, deps);
    const second = await resurfaceHeldQuestions({ floor: false, notify: deps.notify }, deps);

    expect(first.resurfaced).toBe(1);
    expect(second).toMatchObject({ resurfaced: 0, lost: 1 });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ workspaceId: 'ws-1', taskId: 'task-1', workerId: 'worker-1', sensitive: false });
    // The claim is conditional on nobody having settled it and on the same parked question.
    const update = statements.find(s => s.trim().startsWith('UPDATE'))!;
    expect(update).toContain("waiting_for->>'holdSettledAt' IS NULL");
    expect(update).toContain("status = 'waiting_input'");
  });

  it('only reads questions still parked on a waiting worker — a worker that moved on is never selected', async () => {
    const { exec, statements } = fakeDb([], () => true);
    const { q } = queue();
    await resurfaceHeldQuestions({ floor: false, notify: () => {} }, { exec, now: () => new Date(NOW), queue: q });
    const select = statements[0];
    expect(select).toContain("w.status = 'waiting_input'");
    expect(select).toContain("w.waiting_for->>'disposition' = 'hold'");
    expect(select).toContain("w.waiting_for->>'holdSettledAt' IS NULL");
  });

  it('drops a hold whose task already closed, without a ping', async () => {
    const notified: ParkedQuestion[] = [];
    const { exec } = fakeDb([row({ taskStatus: 'cancelled' })], () => true);
    const { q } = queue();
    const s = await resurfaceHeldQuestions({ floor: false, notify: p => notified.push(p) }, { exec, now: () => new Date(NOW), queue: q });
    expect(s.dropped).toBe(1);
    expect(notified).toHaveLength(0);
  });

  it('the floor tick re-seeds holds still ahead and does not notify them', async () => {
    const notified: ParkedQuestion[] = [];
    const aheadAt = NOW + 5 * 60_000;
    const { exec } = fakeDb([row({ id: 'worker-2', resurfaceAt: new Date(aheadAt).toISOString() })], () => true);
    const { q, calls } = queue();
    const s = await resurfaceHeldQuestions({ floor: true, notify: p => notified.push(p) }, { exec, now: () => new Date(NOW), queue: q });
    expect(s).toMatchObject({ ahead: 1, resurfaced: 0 });
    expect(notified).toHaveLength(0);
    expect(calls).toEqual([['reseed', [{ member: 'worker-2', dueAtMs: aheadAt }]]]);
  });

  it('the gated tick clears what it answered for', async () => {
    const { exec } = fakeDb([row()], () => true);
    const { q, calls } = queue();
    await resurfaceHeldQuestions({ floor: false, notify: () => {} }, { exec, now: () => new Date(NOW), queue: q });
    expect(calls).toEqual([['clear', NOW]]);
  });
});
