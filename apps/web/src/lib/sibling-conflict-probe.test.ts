/**
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/sibling-conflict-probe.test.ts
 */
import { describe, it, expect } from 'bun:test';
import {
  SIBLING_NOTICE_DEBOUNCE_MS,
  SIBLING_PROBE_DISPATCH_TIMEOUT_MS,
  SIBLING_PROBE_INTERVAL_MS,
  applySiblingProbeResult,
  buildSiblingConflictInstruction,
  findSiblingPairs,
  pickRebaser,
  readSiblingProbeResults,
  requestSiblingProbes,
  shouldRequestProbe,
  siblingPairKey,
  takeSiblingProbeRequests,
  type ProbeRowFull,
  type ProbeWorker,
  type SiblingProbeDeps,
  type SiblingProbeEvent,
} from './sibling-conflict-probe';

const NOW = new Date('2026-10-08T12:00:00.000Z');

const w = (id: string, over: Partial<ProbeWorker> = {}): ProbeWorker => ({
  workerId: id,
  taskId: `task-${id}`,
  workspaceId: 'ws',
  missionId: null,
  branch: `buildd/${id}`,
  title: `Task ${id}`,
  startedAt: '2026-10-08T11:00:00.000Z',
  prNumber: null,
  observedTouches: ['apps/web/src/lib/x.ts'],
  mergiraf: false,
  sensitive: false,
  ...over,
});

describe('findSiblingPairs', () => {
  it('pairs live workers in one workspace that share a file', () => {
    const pairs = findSiblingPairs([
      w('a', { observedTouches: ['apps/web/src/lib/x.ts', 'a.ts'] }),
      w('b', { observedTouches: ['apps/web/src/lib/x.ts', 'b.ts'] }),
      w('c', { observedTouches: ['c.ts'] }),
      w('d', { workspaceId: 'other', observedTouches: ['apps/web/src/lib/x.ts'] }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ pairKey: 'a:b', sharedFiles: ['apps/web/src/lib/x.ts'] });
  });

  it('ignores generated files, the repo-wide sentinel, and a directory sharing no file', () => {
    expect(findSiblingPairs([
      w('a', { observedTouches: ['bun.lock', 'docs/specs/INDEX.md', '**', 'apps/web/src/lib/'], generatedGlobs: ['/bun.lock'] }),
      w('b', { observedTouches: ['bun.lock', 'docs/specs/INDEX.md', '**', 'apps/web/src/lib/x.ts'], generatedGlobs: ['/bun.lock'] }),
    ])).toEqual([]);
  });

  it('never pairs a worker with itself, the same branch or the same task', () => {
    expect(findSiblingPairs([w('a'), w('b', { branch: 'buildd/a' })])).toEqual([]);
    expect(findSiblingPairs([w('a'), w('b', { taskId: 'task-a' })])).toEqual([]);
  });
});

describe('pickRebaser', () => {
  it('the one not yet in review rebases', () => {
    expect(pickRebaser(w('a', { prNumber: 7 }), w('b')).workerId).toBe('b');
    expect(pickRebaser(w('a'), w('b', { prNumber: 7 })).workerId).toBe('a');
  });

  it('otherwise the later starter rebases', () => {
    expect(pickRebaser(w('a', { startedAt: '2026-10-08T11:30:00.000Z' }), w('b')).workerId).toBe('a');
    expect(pickRebaser(w('a', { prNumber: 1 }), w('b', { prNumber: 2, startedAt: '2026-10-08T11:30:00.000Z' })).workerId).toBe('b');
  });
});

describe('shouldRequestProbe: per-pair debounce', () => {
  const row = (over: any) => ({ id: 'p', status: 'done', requestedAt: NOW, dispatchedAt: null, probedAt: null, ...over });
  it('a new pair is asked; an outstanding request is not re-asked', () => {
    expect(shouldRequestProbe(null, NOW)).toBe(true);
    expect(shouldRequestProbe(row({ status: 'requested' }), NOW)).toBe(false);
    expect(shouldRequestProbe(row({ status: 'dispatched', dispatchedAt: new Date(NOW.getTime() - 60_000) }), NOW)).toBe(false);
    expect(shouldRequestProbe(row({ status: 'dispatched', dispatchedAt: new Date(NOW.getTime() - SIBLING_PROBE_DISPATCH_TIMEOUT_MS) }), NOW)).toBe(true);
  });
  it('a probed pair waits out the interval', () => {
    expect(shouldRequestProbe(row({ probedAt: new Date(NOW.getTime() - 60_000) }), NOW)).toBe(false);
    expect(shouldRequestProbe(row({ probedAt: new Date(NOW.getTime() - SIBLING_PROBE_INTERVAL_MS) }), NOW)).toBe(true);
  });
});

function fakeDeps(opts: { workers?: ProbeWorker[]; row?: Partial<ProbeRowFull> | null } = {}) {
  const workers = new Map((opts.workers ?? [w('a'), w('b', { prNumber: 9 })]).map(x => [x.workerId, x]));
  const row: ProbeRowFull | null = opts.row === null ? null : {
    id: 'probe-1', pairKey: siblingPairKey('a', 'b'), workspaceId: 'ws', workerAId: 'a', workerBId: 'b', proberWorkerId: 'a',
    sharedFiles: ['apps/web/src/lib/x.ts'], status: 'dispatched', requestedAt: NOW, dispatchedAt: NOW, probedAt: null, notifiedAt: null,
    ...opts.row,
  };
  const queued: Array<{ workerId: string; text: string; marker: string }> = [];
  const events: SiblingProbeEvent[] = [];
  const saved: any[] = [];
  const upserts: any[] = [];
  const deps: SiblingProbeDeps = {
    loadLiveWorkers: async () => [...workers.values()],
    loadProbes: async () => new Map(),
    upsertRequest: async (pair) => { upserts.push(pair); },
    takeRequests: async () => [],
    loadProbe: async (probeId, workerId) => (row && row.id === probeId && row.proberWorkerId === workerId ? row : null),
    loadWorkers: async (ids) => new Map(ids.filter(id => workers.has(id)).map(id => [id, workers.get(id)!])),
    saveResult: async (_id, fields) => {
      saved.push(fields);
      if (row && fields.notifiedAt) row.notifiedAt = fields.notifiedAt;
    },
    queueInstruction: async (worker, text, marker) => {
      // The real queue skips a marker that is already waiting; model that too.
      if (queued.some(q => q.workerId === worker.workerId && q.marker === marker)) return false;
      queued.push({ workerId: worker.workerId, text, marker });
      return true;
    },
    recordProbe: async (e) => { events.push(e); },
    now: () => NOW,
  };
  return { deps, queued, events, saved, upserts, row };
}

const conflict = {
  probeId: 'probe-1',
  outcome: 'conflict' as const,
  conflicts: [{ path: 'apps/web/src/lib/x.ts', hunks: [{ startLine: 10, endLine: 18 }] }],
  headSha: 'aaa',
  otherSha: 'bbb',
};

describe('applySiblingProbeResult', () => {
  it('a real conflict notifies both workers once, naming the files, hunks and who rebases', async () => {
    const f = fakeDeps();
    const r = await applySiblingProbeResult('a', conflict, f.deps);
    expect(r.notified.sort()).toEqual(['a', 'b']);
    expect(f.queued).toHaveLength(2);
    const toA = f.queued.find(q => q.workerId === 'a')!.text;
    const toB = f.queued.find(q => q.workerId === 'b')!.text;
    expect(toA).toContain('apps/web/src/lib/x.ts (lines 10-18)');
    expect(toA).toContain('You rebase'); // b already has a PR in review
    expect(toB).toContain('They rebase onto your work');
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ outcome: 'conflict', conflictFiles: ['apps/web/src/lib/x.ts'], rebaserWorkerId: 'a', debounced: false });

    // The same conflict found again inside the debounce: recorded, not re-sent.
    const again = await applySiblingProbeResult('a', conflict, f.deps);
    expect(again.notified).toEqual([]);
    expect(f.queued).toHaveLength(2);
    expect(f.events[1]).toMatchObject({ outcome: 'conflict', debounced: true, notified: [] });
  });

  it('after the debounce a still-conflicting pair is told again', async () => {
    const f = fakeDeps({ row: { notifiedAt: new Date(NOW.getTime() - SIBLING_NOTICE_DEBOUNCE_MS - 1) } });
    const r = await applySiblingProbeResult('a', conflict, f.deps);
    expect(r.notified).toHaveLength(2);
  });

  it('a clean merge-tree sends no notice, and is recorded as clean', async () => {
    const f = fakeDeps();
    const r = await applySiblingProbeResult('a', { probeId: 'probe-1', outcome: 'clean' }, f.deps);
    expect(r).toEqual({ recorded: true, notified: [] });
    expect(f.queued).toHaveLength(0);
    expect(f.events[0]).toMatchObject({ outcome: 'clean', notified: [] });
    expect(f.saved[0]).toMatchObject({ outcome: 'clean', conflictFiles: null });
  });

  it('a mergiraf-resolvable conflict sends no notice', async () => {
    const f = fakeDeps();
    const r = await applySiblingProbeResult('a', { probeId: 'probe-1', outcome: 'mergiraf_resolved', resolvedByMergiraf: ['apps/web/src/lib/x.ts'] }, f.deps);
    expect(r.notified).toEqual([]);
    expect(f.queued).toHaveLength(0);
    expect(f.events[0]).toMatchObject({ outcome: 'mergiraf_resolved', resolvedByMergiraf: ['apps/web/src/lib/x.ts'] });
  });

  it('a conflict only on generated files is not real: no notice', async () => {
    const f = fakeDeps();
    await applySiblingProbeResult('a', { probeId: 'probe-1', outcome: 'conflict', conflicts: [{ path: 'docs/specs/INDEX.md', hunks: [] }] }, f.deps);
    expect(f.queued).toHaveLength(0);
    expect(f.events[0].outcome).toBe('clean');
  });

  it('a result from a worker that is not the prober is ignored', async () => {
    const f = fakeDeps();
    const r = await applySiblingProbeResult('b', conflict, f.deps);
    expect(r.recorded).toBe(false);
    expect(f.queued).toHaveLength(0);
    expect(f.events).toHaveLength(0);
  });

  it('a probe error is recorded and notifies nobody', async () => {
    const f = fakeDeps();
    await applySiblingProbeResult('a', { probeId: 'probe-1', outcome: 'error', error: 'fetch failed' }, f.deps);
    expect(f.queued).toHaveLength(0);
    expect(f.events[0]).toMatchObject({ outcome: 'error', error: 'fetch failed' });
  });

  it('never throws', async () => {
    const f = fakeDeps();
    f.deps.loadProbe = async () => { throw new Error('db down'); };
    expect(await applySiblingProbeResult('a', conflict, f.deps)).toEqual({ recorded: false, notified: [] });
  });
});

describe('requestSiblingProbes (cron) and takeSiblingProbeRequests (heartbeat)', () => {
  it('asks each new pair once', async () => {
    const f = fakeDeps();
    expect(await requestSiblingProbes(f.deps)).toEqual({ pairs: 1, requested: 1 });
    expect(f.upserts[0]).toMatchObject({ pairKey: 'a:b', rebaser: { workerId: 'a' } });
  });

  it('skips a pair with an outstanding request', async () => {
    const f = fakeDeps();
    f.deps.loadProbes = async () => new Map([['a:b', { status: 'requested' } as any]]);
    expect(await requestSiblingProbes(f.deps)).toEqual({ pairs: 1, requested: 0 });
  });

  it('hands the runner its requests in the wire shape', async () => {
    const f = fakeDeps();
    f.deps.takeRequests = async () => [{ ...f.row!, otherBranch: 'buildd/b', mergiraf: true }];
    expect(await takeSiblingProbeRequests('a', f.deps)).toEqual([
      { probeId: 'probe-1', otherBranch: 'buildd/b', sharedFiles: ['apps/web/src/lib/x.ts'], mergiraf: true },
    ]);
  });
});

describe('readSiblingProbeResults', () => {
  it('keeps well-formed results and drops the rest', () => {
    expect(readSiblingProbeResults([
      conflict,
      { probeId: 'x', outcome: 'bogus' },
      { outcome: 'clean' },
      'nope',
    ])).toEqual([conflict]);
    expect(readSiblingProbeResults(undefined)).toEqual([]);
  });
});

describe('buildSiblingConflictInstruction', () => {
  it('carries the marker the queue dedupes on', () => {
    const t = buildSiblingConflictInstruction({ pairKey: 'a:b', self: 'holder', other: { title: null, branch: 'buildd/a', inReview: false }, conflicts: [] });
    expect(t).toContain('[sibling-conflict: a:b]');
    expect(t).toContain('git diff HEAD...FETCH_HEAD');
  });
});
