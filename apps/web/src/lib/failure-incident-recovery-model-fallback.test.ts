/**
 * Model-fallback degradation: a claim that refuses the model it resolved and
 * serves the tier fallback (`dispatch_model_rejected`). The run succeeds on
 * the substitute, so no worker fails; the Sentinel must still open one durable
 * incident, file one fix, and resolve only on fresh claims served the
 * requested model, never on a task that succeeded. Only the fact read is
 * faked.
 */
import { describe, expect, it } from 'bun:test';
import {
  detectFailurePatterns,
  modelDispatchFallbackSignature,
  parseModelDispatchFallbackSignature,
  type DispatchFallbackFact,
} from './failure-pattern-sentinel';
import { assessIncident, type RecoveryDeps, type RecoveryEffects } from './failure-incident-recovery';
import { evaluateModelFallback, MIN_SERVED_AS_REQUESTED, type ModelFallbackRecoveryFacts } from './failure-incident-recovery-model-fallback';
import { mergeIncident, type IncidentStorePort, type StoredIncident } from './failure-incident-store';

const T0 = Date.parse('2026-10-31T12:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const WS = 'ws-1';
const HAIKU_55 = 'claude-haiku-5-5';
const HAIKU_45 = 'claude-haiku-4-5-20251001';

function fallback(n: number, over: Partial<DispatchFallbackFact> = {}): DispatchFallbackFact {
  return {
    traceId: `trace-${n}`, workerId: `worker-${n}`, taskId: `task-${n}`,
    rejectedModel: HAIKU_55, source: 'tier_row', reason: 'newer_than_floor_table', servedModel: HAIKU_45,
    occurredAt: at(-n), ...over,
  };
}

const fallbacks = (count: number, over: Partial<DispatchFallbackFact> = {}) =>
  Array.from({ length: count }, (_, i) => fallback(i + 1, over));

function openFrom(facts: DispatchFallbackFact[], now = at(0)): StoredIncident {
  const [candidate] = detectFailurePatterns({ workspaceId: WS, now, dispatchFallbacks: facts });
  const merged = mergeIncident(null, candidate).next as Omit<StoredIncident, 'id' | 'version'>;
  return { ...merged, id: 'inc-1', version: 0 } as StoredIncident;
}

function memoryPort(initial: StoredIncident) {
  let row = structuredClone(initial);
  const port: IncidentStorePort = {
    async find() { return structuredClone(row); },
    async findById(id) { return id === row.id ? structuredClone(row) : null; },
    async insert() { return null; },
    async compareAndSwap(id, expected, next) {
      if (id !== row.id || row.version !== expected) return null;
      row = { ...structuredClone(next), id, version: expected + 1 };
      return structuredClone(row);
    },
  };
  return { port, get: () => row, set: (r: StoredIncident) => { row = structuredClone(r); } };
}

const fixRunning = { id: 'fix-task-0001', status: 'in_progress', finishedAt: null };
const fixDone = (min: number) => ({ id: 'fix-task-0001', status: 'completed', finishedAt: at(min) });

describe('the rule: fallback-only degradation opens one incident per requested model', () => {
  it('opens on claims that succeeded on the fallback, with no failed worker anywhere', () => {
    const out = detectFailurePatterns({ workspaceId: WS, now: at(0), dispatchFallbacks: fallbacks(4), workerFailures: [] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      rule: 'model_dispatch_fallback',
      reasonCode: 'dispatch.model_fallback',
      signature: `model_dispatch_fallback|ws=${WS}|model=${HAIKU_55}|source=tier_row|reason=newer_than_floor_table`,
      severity: 'medium',
    });
    expect(out[0].title).toContain(HAIKU_45);
    expect(out[0].impact).toEqual({ fallbackClaims: 4, distinctTasks: 4 });
  });

  it('counts a task re-claimed several times once, and stays quiet below the threshold', () => {
    const sameTask = fallbacks(5, { taskId: 'task-same' });
    expect(detectFailurePatterns({ workspaceId: WS, now: at(0), dispatchFallbacks: [...sameTask, fallback(9)] })).toEqual([]);
  });

  it('is high once ten distinct tasks ran on the fallback', () => {
    const [c] = detectFailurePatterns({ workspaceId: WS, now: at(0), dispatchFallbacks: fallbacks(10) });
    expect(c.severity).toBe('high');
  });

  it('keys on what was asked for, from where and why; never on the served model', () => {
    const mixedServed = [...fallbacks(2), fallback(3, { servedModel: 'claude-haiku-4-5' })];
    expect(detectFailurePatterns({ workspaceId: WS, now: at(0), dispatchFallbacks: mixedServed })).toHaveLength(1);
    const twoSources = [...fallbacks(3), ...fallbacks(3, { source: 'tier_pool_arm' }).map(f => ({ ...f, traceId: `${f.traceId}-p` }))];
    expect(detectFailurePatterns({ workspaceId: WS, now: at(0), dispatchFallbacks: twoSources }).map(c => c.signature)).toHaveLength(2);
  });

  it('signatures round-trip, and other rules are not parsed as one', () => {
    const sig = modelDispatchFallbackSignature(WS, { rejectedModel: HAIKU_55, source: 'tier_row', reason: 'newer_than_floor_table' });
    expect(parseModelDispatchFallbackSignature(sig)).toEqual({ rejectedModel: HAIKU_55, source: 'tier_row', reason: 'newer_than_floor_table' });
    expect(parseModelDispatchFallbackSignature(`repeated_failure|ws=${WS}|x`)).toBeNull();
  });
});

describe('the ledger: one durable incident, reopened on recurrence', () => {
  it('a re-run sweep over the same traces adds nothing; new traces update the same row', () => {
    const inc = openFrom(fallbacks(4));
    const [same] = detectFailurePatterns({ workspaceId: WS, now: at(1), dispatchFallbacks: fallbacks(4) });
    expect(mergeIncident(inc, same).outcome).toBe('unchanged');
    const [more] = detectFailurePatterns({ workspaceId: WS, now: at(30), dispatchFallbacks: [...fallbacks(4), fallback(20, { occurredAt: at(25) })] });
    const merged = mergeIncident(inc, more);
    expect(merged.outcome).toBe('updated');
    expect(merged.next.occurrenceCount).toBe(5);
    expect(merged.next.signature).toBe(inc.signature);
  });

  it('a fallback after the incident resolved reopens it, counting the recurrence', () => {
    const resolved = { ...openFrom(fallbacks(4)), status: 'resolved' as const, resolvedAt: at(60) };
    const [again] = detectFailurePatterns({ workspaceId: WS, now: at(600), dispatchFallbacks: fallbacks(3, { occurredAt: at(590) }).map(f => ({ ...f, workerId: `${f.workerId}-r`, traceId: `${f.traceId}-r` })) });
    const merged = mergeIncident(resolved, again);
    expect(merged.outcome).toBe('reopened');
    expect(merged.next.status).toBe('open');
    expect(merged.next.recurrenceCount).toBe(1);
  });
});

describe('the policy: fresh claims decide, a successful task never does', () => {
  const inc = openFrom(fallbacks(4));
  // Only the episode start matters to the policy; the rest of a recovery is the engine's.
  const watched = (firstSeenAt: string): StoredIncident => ({ ...inc, recovery: { v: 1, firstSeenAt } as StoredIncident['recovery'] });
  const facts = (over: Partial<ModelFallbackRecoveryFacts>): ModelFallbackRecoveryFacts => ({ lastFallbackAt: at(-1), servedSince: 0, fixTask: null, ...over });

  it('passes only once enough claims served the requested model after the last fallback', () => {
    expect(evaluateModelFallback(inc, facts({ servedSince: MIN_SERVED_AS_REQUESTED }), at(0)).verdict.kind).toBe('passed');
    expect(evaluateModelFallback(inc, facts({ lastFallbackAt: at(-40), servedSince: MIN_SERVED_AS_REQUESTED - 1, fixTask: fixDone(-30) }), at(0)).verdict.kind).toBe('inconclusive');
  });

  it('the first look is inconclusive: a tail of fallbacks from before Buildd watched files no fix', () => {
    expect(evaluateModelFallback(inc, facts({}), at(0)).verdict.kind).toBe('inconclusive');
  });

  it('a fallback after Buildd began watching files the one fix task', () => {
    const o = evaluateModelFallback(watched(at(0)), facts({ lastFallbackAt: at(20) }), at(30));
    expect(o.verdict).toMatchObject({ kind: 'repair', action: 'file_fix_task', once: true });
    expect(o.cause).toEqual({ reasonCode: 'dispatch.model_fallback', rule: 'model_dispatch_fallback', ownership: 'infrastructure' });
  });

  it('delegates to a running fix', () => {
    expect(evaluateModelFallback(watched(at(0)), facts({ lastFallbackAt: at(20), fixTask: fixRunning }), at(30)).verdict.kind).toBe('delegated');
  });

  it('waits for the release when fallbacks continue after the fix finished, bounded from the fix', () => {
    const o = evaluateModelFallback(watched(at(0)), facts({ lastFallbackAt: at(50), fixTask: fixDone(40) }), at(60));
    expect(o.verdict.kind).toBe('wait');
    expect(o.episodeStartedAt).toBe(at(40));
    expect(o.fallbackOperator?.capability).toBe('repair_infrastructure:model_dispatch');
  });

  it('a released fix with no fallback since but too few claims stays open as inconclusive', () => {
    const o = evaluateModelFallback(watched(at(0)), facts({ lastFallbackAt: at(30), servedSince: 5, fixTask: fixDone(40) }), at(60));
    expect(o.verdict).toMatchObject({ kind: 'inconclusive' });
    expect((o.verdict as { reason: string }).reason).toContain(`5 of ${MIN_SERVED_AS_REQUESTED}`);
  });

  it('a recurrence after the fix goes to the operator, naming the fix that did not hold', () => {
    const reopened = { ...watched(at(0)), recurrenceCount: 1 };
    const o = evaluateModelFallback(reopened, facts({ lastFallbackAt: at(900), fixTask: fixDone(40) }), at(910));
    expect(o.verdict).toMatchObject({ kind: 'operator', capability: 'repair_infrastructure:model_dispatch' });
    expect((o.verdict as { reason: string }).reason).toContain('fix-task');
    expect((o.verdict as { reason: string }).reason).toContain('did not hold');
  });

  it('an unread dispatch record is never a pass', () => {
    expect(evaluateModelFallback(inc, facts({ lastFallbackAt: null, servedSince: null }), at(0)).verdict.kind).toBe('inconclusive');
  });
});

describe('assessIncident: fallback → one fix → verified on fresh claims → reopened on recurrence', () => {
  it('runs the whole loop against the store', async () => {
    const store = memoryPort(openFrom(fallbacks(4)));
    const filed: string[] = [];
    const effects: RecoveryEffects = {
      async releaseBlocker() {}, async wakeSubject() {},
      async fileFixTask(_incident, key) { filed.push(key); return 'fix-task-0001'; },
    };
    let facts: ModelFallbackRecoveryFacts = { lastFallbackAt: at(-1), servedSince: 0, fixTask: null };
    let now = at(0);
    const deps: RecoveryDeps = {
      port: store.port, effects, now: () => now,
      families: [{ rule: 'model_dispatch_fallback', observe: async () => ({ complete: true, facts }), evaluate: evaluateModelFallback }],
    };

    // The first look only starts watching.
    expect((await assessIncident(deps, 'inc-1', 'sweep')).incident?.recovery?.state).toBe('inconclusive');
    expect(filed).toHaveLength(0);

    // Fallbacks keep coming: one fix task, and a second sweep files no other.
    now = at(30);
    facts = { ...facts, lastFallbackAt: at(25) };
    expect((await assessIncident(deps, 'inc-1', 'sweep')).outcome).toBe('repaired');
    await assessIncident(deps, 'inc-1', 'sweep');
    expect(filed).toHaveLength(1);

    // Tasks still succeed on the fallback while the fix runs: not resolved.
    now = at(60);
    facts = { ...facts, lastFallbackAt: at(55), fixTask: fixRunning };
    expect((await assessIncident(deps, 'inc-1', 'sweep')).incident?.status).not.toBe('resolved');

    // Released: fresh claims serve the requested model.
    now = at(600);
    facts = { lastFallbackAt: at(120), servedSince: MIN_SERVED_AS_REQUESTED, fixTask: fixDone(100) };
    expect((await assessIncident(deps, 'inc-1', 'sweep')).incident?.status).toBe('resolved');
    expect(store.get().recovery?.state).toBe('recovered');

    // It comes back: reopened, and the earlier fix is named to the operator.
    const [again] = detectFailurePatterns({
      workspaceId: WS, now: at(2000),
      dispatchFallbacks: fallbacks(3, { occurredAt: at(1990) }).map(f => ({ ...f, workerId: `${f.workerId}-r`, traceId: `${f.traceId}-r` })),
    });
    const merged = mergeIncident(store.get(), again);
    expect(merged.outcome).toBe('reopened');
    store.set({ ...(merged.next as StoredIncident), id: 'inc-1', version: store.get().version + 1, linkedFixTaskId: 'fix-task-0001' });
    now = at(2010);
    facts = { lastFallbackAt: at(1990), servedSince: 0, fixTask: fixDone(100) };
    const reassessed = await assessIncident(deps, 'inc-1', 'sweep');
    expect(reassessed.incident?.status).toBe('open');
    expect(store.get().recovery?.state).toBe('needs_operator');
    expect(store.get().recovery?.capabilityGap?.reason).toContain('did not hold');
    expect(filed).toHaveLength(1);
  });
});
