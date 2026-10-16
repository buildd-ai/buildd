import { describe, expect, it } from 'bun:test';
import { setDecisionModelForKind, type DecisionModelStoreDeps } from '../decision-model-store';

const CLEF = { endpoint: 'systemone', model: 'clef', via: 'cloudflare' } as const;
const QWEN = { endpoint: 'chat', model: 'qwen/qwen3-8b', via: 'openrouter' } as const;

/** One team row behind a compare-and-set, like `UPDATE … WHERE decision_model = <what was read>`. */
function fakeTeam(initial: unknown, opts: { raceOnce?: unknown } = {}) {
  let stored: unknown = initial;
  let race = opts.raceOnce;
  const audits: any[] = [];
  let reads = 0;
  const deps: DecisionModelStoreDeps = {
    read: async () => { reads += 1; return { found: true, value: stored }; },
    compareAndSet: async (_teamId, expected, next) => {
      if (race !== undefined) { stored = race; race = undefined; }
      if (JSON.stringify(stored) !== JSON.stringify(expected)) return false;
      stored = next;
      return true;
    },
    audit: async e => { audits.push(e); },
  };
  return { deps, audits, get stored() { return stored; }, get reads() { return reads; } };
}

describe('setDecisionModelForKind', () => {
  it('sets an override, keeping the team default', async () => {
    const t = fakeTeam(QWEN);
    const r = await setDecisionModelForKind('team-1', 'buildd.orchestration_claim_hold', { model: 'clef' }, { by: 'acct-1', reason: 'bakeoff' }, t.deps);
    expect(r).toMatchObject({ ok: true, after: CLEF, before: null });
    expect(t.stored).toEqual({ ...QWEN, byKind: { 'buildd.orchestration_claim_hold': CLEF } });
  });

  it('null clears the override; the decision goes back to the team default', async () => {
    const t = fakeTeam({ ...QWEN, byKind: { task_role: CLEF, task_category: QWEN } });
    const r = await setDecisionModelForKind('team-1', 'task_role', null, { by: null, reason: 'optimizer' }, t.deps);
    expect(r).toMatchObject({ ok: true, before: CLEF, after: null });
    expect(t.stored).toEqual({ ...QWEN, byKind: { task_category: QWEN } });
  });

  it('clearing the only override on a Jev team leaves nothing stored', async () => {
    const t = fakeTeam({ byKind: { task_role: CLEF } });
    await setDecisionModelForKind('team-1', 'task_role', null, { by: 'acct-1', reason: null }, t.deps);
    expect(t.stored).toBeNull();
  });

  it('rejects an unknown decision or an invalid model before reading anything', async () => {
    const t = fakeTeam(null);
    const unknown = await setDecisionModelForKind('team-1', 'buildd.nope' as any, { model: 'clef' }, { by: null, reason: null }, t.deps);
    expect(unknown.ok).toBe(false);
    const bad = await setDecisionModelForKind('team-1', 'task_category', { model: 'clef', via: 'openrouter' }, { by: null, reason: null }, t.deps);
    expect(bad.ok).toBe(false);
    expect(t.reads).toBe(0);
    expect(t.stored).toBeNull();
    expect(t.audits).toHaveLength(0);
  });

  it('a concurrent write is not lost: it re-reads and applies on top', async () => {
    const t = fakeTeam(QWEN, { raceOnce: { ...QWEN, byKind: { task_category: QWEN } } });
    const r = await setDecisionModelForKind('team-1', 'task_role', CLEF, { by: 'acct-1', reason: null }, t.deps);
    expect(r.ok).toBe(true);
    expect(t.stored).toEqual({ ...QWEN, byKind: { task_category: QWEN, task_role: CLEF } });
    expect(t.reads).toBe(2);
  });

  it('records who changed it, why, and from what to what', async () => {
    const t = fakeTeam(null);
    await setDecisionModelForKind('team-1', 'task_category', CLEF, { by: 'acct-1', reason: 'measured on 200 decisions' }, t.deps);
    expect(t.audits).toEqual([{
      actorAccountId: 'acct-1',
      action: 'team.decision_model.kind.update',
      targetType: 'team',
      targetId: 'team-1',
      teamId: 'team-1',
      before: { kind: 'task_category', model: null },
      after: { kind: 'task_category', model: CLEF, reason: 'measured on 200 decisions' },
    }]);
  });

  it('a missing team is an error, with nothing written', async () => {
    const t = fakeTeam(null);
    t.deps.read = async () => ({ found: false, value: null });
    const r = await setDecisionModelForKind('team-x', 'task_category', CLEF, { by: null, reason: null }, t.deps);
    expect(r).toEqual({ ok: false, error: 'team not found' });
    expect(t.audits).toHaveLength(0);
  });
});
