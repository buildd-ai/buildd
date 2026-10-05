import { describe, it, expect, mock } from 'bun:test';

// Orphan reconcile decision logic against a fake Worker. The SQL each action
// runs is real-Postgres tested in apps/web/tests/db/dispatch-reconcile.test.ts.

const { reconcileOrphans, planReconcile } = await import('./dispatch-reconcile');
type Deps = NonNullable<Parameters<typeof reconcileOrphans>[0]>;
type Candidate = Awaited<ReturnType<Deps['selectCandidates']>>[number];

const WS1 = '11111111-1111-4111-8111-111111111111';
const WS2 = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const AT = '2026-10-04T11:30:00.000Z';
let n = 0;
const uuid = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, '0')}`;
const cand = (over: Partial<Candidate> = {}): Candidate =>
  ({ id: uuid(), workspaceId: WS1, notBefore: new Date(NOW - 20 * 60_000), pastCeiling: false, ...over });

type Known = { id: string; state: string; attempt: number; via?: string; why?: string; mergedInto?: string; closedAt?: string };

/** A fake Worker: per-scope answers, recorded calls. */
function fakeWorker(answer: (scope: string, ids: string[]) => { known: Known[]; unknown: string[] } | Error) {
  const calls: Array<{ scope: string; ids: string[] }> = [];
  const lookup = mock(async (scope: string, ids: string[]) => {
    calls.push({ scope, ids });
    const a = answer(scope, ids);
    if (a instanceof Error) throw a;
    return a as never;
  });
  return { lookup, calls };
}

function deps(candidates: Candidate[], worker: ReturnType<typeof fakeWorker>, over: Partial<Deps> = {}) {
  const applied: unknown[][] = [];
  const fellBack: string[][] = [];
  const republished: string[][] = [];
  const d: Deps = {
    configured: () => true,
    selectCandidates: async () => candidates,
    lookup: worker.lookup,
    republish: async ids => { republished.push([...ids]); return { republished: [...ids], merged: [], rejected: [] }; },
    applyReceipts: async r => { applied.push([...r]); return r.length; },
    fallBackToInApp: async ids => { fellBack.push([...ids]); return ids.length; },
    now: () => NOW,
    log: () => {},
    ...over,
  };
  return { d, applied, fellBack, republished };
}

describe('planReconcile', () => {
  it('unknown → re-publish, or fall back past the ceiling', () => {
    const a = cand();
    const b = cand({ pastCeiling: true });
    const p = planReconcile([a, b], { known: [], unknown: [a.id, b.id] }, new Date(NOW).toISOString());
    expect(p).toEqual({ republish: [a.id], receipts: [], fallBack: [b.id], left: [] });
  });

  it('known terminal → project the receipt it stands for, whatever the age', () => {
    const a = cand();
    const b = cand({ pastCeiling: true });
    const p = planReconcile([a, b], {
      known: [
        { id: a.id, state: 'delivered', attempt: 1, via: 'relay:pusher', closedAt: AT },
        { id: b.id, state: 'failed', attempt: 8, why: 'relay_http_502', closedAt: AT },
      ],
      unknown: [],
    } as never, new Date(NOW).toISOString());
    expect(p.receipts).toEqual([
      { id: a.id, attempt: 1, event: 'delivered', via: 'relay:pusher', at: AT },
      { id: b.id, attempt: 8, event: 'failed', why: 'relay_http_502', at: AT },
    ]);
    expect(p.fallBack).toEqual([]);
  });

  it('known and still queued/attempting → left, until the ceiling; then taken back', () => {
    const a = cand();
    const b = cand({ pastCeiling: true });
    const p = planReconcile([a, b], { known: [{ id: a.id, state: 'attempting', attempt: 2 }, { id: b.id, state: 'queued', attempt: 5 }], unknown: [] } as never, new Date(NOW).toISOString());
    expect(p).toEqual({ republish: [], receipts: [], fallBack: [b.id], left: [a.id] });
  });

  it('a merged intent without a target id, and an id the Worker did not answer, are not guessed at', () => {
    const a = cand();
    const b = cand();
    const c = cand({ pastCeiling: true });
    const p = planReconcile([a, b, c], { known: [{ id: a.id, state: 'merged', attempt: 0 }], unknown: [] } as never, new Date(NOW).toISOString());
    expect(p).toEqual({ republish: [], receipts: [], fallBack: [a.id, c.id], left: [b.id] });
  });
});

describe('reconcileOrphans', () => {
  it('batches by workspace scope, at most 100 ids per call', async () => {
    const cands = [...Array.from({ length: 150 }, () => cand()), cand({ workspaceId: WS2 })];
    const w = fakeWorker((_s, ids) => ({ known: ids.map(id => ({ id, state: 'queued', attempt: 0 })), unknown: [] }));
    const { d } = deps(cands, w);
    const r = await reconcileOrphans(d);
    expect(w.calls.map(c => [c.scope, c.ids.length])).toEqual([
      [`buildd:workspace:${WS1}`, 100],
      [`buildd:workspace:${WS1}`, 50],
      [`buildd:workspace:${WS2}`, 1],
    ]);
    expect(r).toMatchObject({ checked: 151, republished: 0, projected: 0, fellBack: 0, left: 151, workerErrors: 0 });
  });

  it('re-publishes the unknown, projects the terminal, leaves the open, and counts each', async () => {
    const lost = cand();
    const done = cand();
    const busy = cand();
    const stuck = cand({ pastCeiling: true });
    const w = fakeWorker(() => ({
      known: [
        { id: done.id, state: 'skipped', attempt: 1, via: 'skipped:held', closedAt: AT },
        { id: busy.id, state: 'attempting', attempt: 2 },
        { id: stuck.id, state: 'queued', attempt: 6 },
      ],
      unknown: [lost.id],
    }));
    const { d, applied, fellBack, republished } = deps([lost, done, busy, stuck], w);
    const lines: Record<string, unknown>[] = [];
    d.log = l => lines.push(l);
    const r = await reconcileOrphans(d);
    expect(republished).toEqual([[lost.id]]);
    expect(applied).toEqual([[{ id: done.id, attempt: 1, event: 'delivered', via: 'skipped:held', at: AT }]]);
    expect(fellBack).toEqual([[stuck.id]]);
    expect(r).toEqual({ checked: 4, republished: 1, projected: 1, fellBack: 1, left: 1, workerErrors: 0 });
    expect(lines).toEqual([{ event: 'dispatch_reconcile', checked: 4, republished: 1, projected: 1, fellBack: 1, left: 1, workerErrors: 0 }]);
  });

  it('the Worker unreachable or 5xx: that batch and every later one fall back, with no further calls', async () => {
    const a = cand();
    const b = cand({ workspaceId: WS2 });
    const w = fakeWorker(() => new Error('lookup_http_503'));
    const { d, fellBack } = deps([a, b], w);
    const r = await reconcileOrphans(d);
    expect(w.calls).toHaveLength(1);
    expect(fellBack.flat().sort()).toEqual([a.id, b.id].sort());
    expect(r).toMatchObject({ checked: 2, fellBack: 2, workerErrors: 1, republished: 0 });
  });

  it('a failed re-publish falls the rows back; rejected ones too; a merge is projected', async () => {
    const lost = cand();
    const lost2 = cand();
    const lost3 = cand();
    const w = fakeWorker((_s, ids) => ({ known: [], unknown: ids }));
    const failing = deps([lost], w, { republish: async () => { throw new Error('publish_http_500'); } });
    const r1 = await reconcileOrphans(failing.d);
    expect(failing.fellBack).toEqual([[lost.id]]);
    expect(r1).toMatchObject({ republished: 0, fellBack: 1, workerErrors: 1 });

    const into = uuid();
    const mixed = deps([lost2, lost3], w, {
      republish: async () => ({ republished: [], rejected: [lost2.id], merged: [{ id: lost3.id, into }] }),
    });
    const r2 = await reconcileOrphans(mixed.d);
    expect(mixed.fellBack).toEqual([[lost2.id]]);
    expect(mixed.applied).toEqual([[{ id: lost3.id, attempt: 0, event: 'merged', into, at: new Date(NOW).toISOString() }]]);
    expect(r2).toMatchObject({ republished: 0, projected: 1, fellBack: 1, workerErrors: 0 });
  });

  it('a row whose workspace was rolled back to in_app is taken back, not re-published', async () => {
    const lost = cand();
    const w = fakeWorker((_s, ids) => ({ known: [], unknown: ids }));
    const { d, fellBack } = deps([lost], w, {
      republish: async () => ({ republished: [], rejected: [], merged: [], notDispatch: [lost.id] }),
    });
    const r = await reconcileOrphans(d);
    expect(fellBack).toEqual([[lost.id]]);
    expect(r).toMatchObject({ fellBack: 1, workerErrors: 0 });
  });

  it('with no Worker configured, every candidate is taken back for the in-app drain', async () => {
    const a = cand();
    const w = fakeWorker(() => ({ known: [], unknown: [] }));
    const { d, fellBack } = deps([a], w, { configured: () => false });
    const r = await reconcileOrphans(d);
    expect(w.calls).toHaveLength(0);
    expect(fellBack).toEqual([[a.id]]);
    expect(r).toMatchObject({ checked: 1, fellBack: 1, workerErrors: 0 });
  });

  it('no candidates: no Worker call, no log line, zero counts', async () => {
    const w = fakeWorker(() => ({ known: [], unknown: [] }));
    const lines: unknown[] = [];
    const { d } = deps([], w, { log: l => lines.push(l) });
    expect(await reconcileOrphans(d)).toEqual({ checked: 0, republished: 0, projected: 0, fellBack: 0, left: 0, workerErrors: 0 });
    expect(w.calls).toHaveLength(0);
    expect(lines).toEqual([]);
  });

  it('stops asking once the time budget is spent; the rest wait for the next floor (not fallen back)', async () => {
    const cands = [cand(), cand({ workspaceId: WS2 })];
    let t = NOW;
    const w = fakeWorker((_s, ids) => { t += 30_000; return { known: ids.map(id => ({ id, state: 'queued', attempt: 0 })), unknown: [] }; });
    const { d, fellBack } = deps(cands, w, { now: () => t, budgetMs: 10_000 });
    const r = await reconcileOrphans(d);
    expect(w.calls).toHaveLength(1);
    expect(fellBack).toEqual([]);
    expect(r).toMatchObject({ checked: 1, left: 1 });
  });
});
