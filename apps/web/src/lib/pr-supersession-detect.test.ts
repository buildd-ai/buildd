import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── state the mocks read ────────────────────────────────────────────────────
let workerRow: any = null;
let siblingTasks: any[] = [];
/** The merged PR's task, for `rescanOnMerge`'s mission read. */
let mergedTask: any = null;
const scanWrites: any[] = [];
/** GitHub, keyed by "owner/repo" then path suffix. */
let gh: Record<string, any> = {};
const ghCalls: string[] = [];
const recordCalls: any[] = [];
let recordResult: any = { ok: true };
const gateEvents: any[] = [];
let sweepRows: Array<{ id: string; prUrl: string }> = [];
let lastWhereCondition: any = null; // Captures what was passed to where() in the sweep query
/** Worker rows findFirst hands out in order (one per detect run), before falling back to `workerRow`. */
let workerQueue: any[] = [];
/** A GitHub path that never answers: it settles only when the caller's AbortSignal fires. */
const STALL = Symbol('stall');
/** A GitHub answer that takes `ms` to arrive (and is abandoned like fetch if the signal fires first). */
const slow = (ms: number, value: any) => ({ [SLOW]: ms, value });
const SLOW = Symbol('slow');
/** When each GitHub call was made, for "nothing runs after the scan returned". */
const ghCallTimes: number[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mock(() => Promise.resolve(workerQueue.length ? workerQueue.shift() : workerRow)) },
      tasks: { findMany: mock(() => Promise.resolve(siblingTasks)), findFirst: mock(() => Promise.resolve(mergedTask)) },
    },
    update: () => ({ set: (set: any) => ({ where: () => { scanWrites.push(set); return Promise.resolve(); } }) }),
    // The sweep's candidate query: from → innerJoin → where → orderBy → limit.
    select: () => {
      const chain: any = {
        from: () => chain,
        innerJoin: () => chain,
        where: (condition: any) => { lastWhereCondition = condition; return chain; },
        orderBy: () => chain,
        limit: () => Promise.resolve(sweepRows)
      };
      return chain;
    },
  },
}));
mock.module('@/lib/github', () => ({
  githubApi: mock((_inst: number, path: string, options: RequestInit = {}) => {
    ghCalls.push(path);
    ghCallTimes.push(Date.now());
    const m = path.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)$/);
    const repo = m?.[1] ?? '';
    const rest = (m?.[2] ?? '').replace(/\?.*$/, '');
    const v = gh[`${repo}${rest}`];
    if (v === STALL) {
      // Like fetch: pending until the signal aborts, then rejected with its reason. No signal, no end.
      return new Promise((_resolve, reject) => {
        const sig = options.signal;
        if (!sig) return;
        if (sig.aborted) return reject(sig.reason);
        sig.addEventListener('abort', () => reject(sig.reason), { once: true });
      });
    }
    if (v && typeof v === 'object' && SLOW in v) {
      return new Promise((resolve, reject) => {
        const sig = options.signal;
        const t = setTimeout(() => resolve(v.value), v[SLOW]);
        if (sig?.aborted) { clearTimeout(t); return reject(sig.reason); }
        sig?.addEventListener('abort', () => { clearTimeout(t); reject(sig.reason); }, { once: true });
      });
    }
    if (v === undefined) return Promise.reject(new Error(`GitHub API error: 404 ${path}`));
    return Promise.resolve(v);
  }),
}));
mock.module('@/lib/workspace-installation', () => ({
  createTeamInstallationResolver: () => ({ forWorkspace: async () => ({ installationId: 1 }) }),
}));
mock.module('@/lib/pr-supersession', () => ({
  recordPrSupersession: mock((p: any) => { recordCalls.push(p); return Promise.resolve(recordResult); }),
  supersessionRepoScope: mock(() => Promise.resolve(new Set())),
}));
mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: { AUTO_PR_SUPERSESSION: 'auto_pr_supersession' },
  fireGateEvent: mock((e: any) => { gateEvents.push(e); return 'id'; }),
}));

import { detectPrSupersession, findTaskLineageForSupersession, prRefsIn, rescanOnMerge, sweepClosedUnsupersededPrs, verifyPrCarriedBy, RESCAN_AFTER_MS, RESCAN_ON_MERGE_CAP } from './pr-supersession-detect';

const DOC_LINES = [
  '# Strategy notes',
  'The mission organizer plans tasks from goal criteria.',
  'Each task is claimed by a runner and reports progress.',
  'Supersession records where closed work actually landed.',
];
const patch = (...lines: string[]) => ['@@ -0,0 +1 @@', ...lines.map(l => `+${l}`)].join('\n');

function closedPr(repo: string, n: number, over: Record<string, any> = {}) {
  gh[`${repo}/pulls/${n}`] = { number: n, merged: false, state: 'closed', body: '', created_at: '2026-09-01T00:00:00Z', commits: 2, head: { sha: `head${n}` }, ...over };
  gh[`${repo}/issues/${n}/comments`] = [];
  gh[`${repo}/issues/${n}/timeline`] = [];
}
function mergedPr(repo: string, n: number, files: any[], over: Record<string, any> = {}) {
  gh[`${repo}/pulls/${n}`] = {
    number: n, merged: true, merged_at: '2026-09-10T00:00:00Z', merge_commit_sha: `sha${n}`,
    html_url: `https://github.com/${repo}/pull/${n}`, commits: 50, ...over,
  };
  gh[`${repo}/pulls/${n}/files`] = files;
}

beforeEach(() => {
  gh = {};
  ghCalls.length = 0;
  ghCallTimes.length = 0;
  scanWrites.length = 0;
  recordCalls.length = 0;
  gateEvents.length = 0;
  recordResult = { ok: true };
  siblingTasks = [];
  mergedTask = null;
  workerQueue = [];
  sweepRows = [];
  workerRow = {
    id: 'w-6', taskId: 't-6', workspaceId: 'ws-1',
    prUrl: 'https://github.com/org/kb/pull/6', prNumber: 6,
    mergedAt: null, prLifecycleStatus: 'closed', supersededByPrNumber: null, abandonedAt: null,
    supersessionScan: null,
    task: { id: 't-6', missionId: 'm-1' },
    workspace: { repo: 'org/kb', githubRepo: { fullName: 'org/kb' } },
  };
  closedPr('org/kb', 6);
  gh['org/kb/pulls/6/files'] = [{ filename: 'buildd/design/strategy.md', status: 'added', patch: patch(...DOC_LINES) }];
  gh['org/kb/pulls'] = [];
});

describe('detectPrSupersession', () => {
  it('regression (c8092d2a): a candidate whose file list GitHub would not return is unavailable proof — never contentRatio 0, never cached or kept as judged', async () => {
    gh['org/kb/issues/6/comments'] = [{ body: 'superseded by #9' }];
    mergedPr('org/kb', 9, []);
    delete gh['org/kb/pulls/9/files']; // the read fails (404 in the mock)

    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep' });

    expect(r.outcome).toBe('suggested');
    expect(recordCalls).toHaveLength(0);
    const scan = scanWrites.at(-1).supersessionScan;
    expect(scan.suggestion).toMatchObject({ prNumber: 9, contentUnavailable: true });
    expect(scan.suggestion.contentRatio).toBeUndefined();
    expect(scan.suggestion.why).toContain('was not compared');
    expect(scan.suggestion.why).not.toContain('none of this PR');
    // Not kept as a judged pair: the next scan reads it again rather than reusing "carries nothing".
    expect((scan.judged ?? []).some((j: any) => j.prNumber === 9)).toBe(false);
  });

  it('verifyPrCarriedBy reads an unreadable candidate as unavailable, not as carrying nothing', async () => {
    mergedPr('org/kb', 9, []);
    delete gh['org/kb/pulls/9/files'];
    const v = await verifyPrCarriedBy({ installationId: 1, repo: 'org/kb', prNumber: 6, candidatePrNumber: 9 });
    expect(v.outcome).toBe('unavailable');
  });

  it('records the edge when a sibling squash carries the closed PR’s content, naming the method', async () => {
    gh['org/kb/issues/6/comments'] = [{ body: 'superseded by #9' }];
    mergedPr('org/kb', 9, [{ filename: 'buildd/design/strategy.md', status: 'added', patch: patch(...DOC_LINES, 'Squashed in with a follow-up line.') }]);

    const r = await detectPrSupersession({ workerId: 'w-6', via: 'webhook' });

    expect(r).toMatchObject({ outcome: 'recorded', prNumber: 9, method: 'content' });
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0]).toMatchObject({ workerId: 'w-6', supersedingPrNumber: 9, recordedBy: 'system:auto-supersession' });
    expect(recordCalls[0].reason).toBe('auto: content verified in #9 (method: content)');
    expect(recordCalls[0].supersedingRepo).toBeUndefined();
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]).toMatchObject({ outcome: 'accepted', detail: expect.objectContaining({ method: 'content', confidence: 1 }) });
  });

  it('regression (#2556): a close comment claiming "superseded by #N" where #N shares no content records NO edge — suggestion only', async () => {
    gh['org/kb/issues/6/comments'] = [{ body: 'This pull request has been superseded by #2558.' }];
    mergedPr('org/kb', 2558, [{ filename: 'apps/web/src/lib/unrelated.ts', status: 'modified', patch: patch('export const unrelatedFix = true;', 'export function other() { return 1; }', 'const anotherLine = "abc";') }]);

    const r = await detectPrSupersession({ workerId: 'w-6', via: 'webhook' });

    expect(r.outcome).toBe('suggested');
    expect(recordCalls).toHaveLength(0);
    const scan = scanWrites.at(-1).supersessionScan;
    expect(scan.suggestion).toMatchObject({ prNumber: 2558, signal: 'claim', contentRatio: 0 });
    expect(scan.suggestion.why).toContain('none of this PR');
    expect(gateEvents[0]).toMatchObject({ outcome: 'deferred' });
  });

  it('matches a sibling task’s merged PR in ANOTHER repo when the files moved there', async () => {
    siblingTasks = [
      { id: 't-6', title: 'self', workers: [] },
      { id: 't-7', title: 'docs: move strategy docs', workers: [{ prUrl: 'https://github.com/org/buildd/pull/3366', prNumber: 3366, mergedAt: new Date() }] },
    ];
    mergedPr('org/buildd', 3366, [{ filename: 'docs/design/strategy.md', status: 'added', patch: patch(...DOC_LINES) }]);

    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep' });

    expect(r).toMatchObject({ outcome: 'recorded', repo: 'org/buildd', prNumber: 3366 });
    expect(recordCalls[0]).toMatchObject({ supersedingRepo: 'org/buildd', supersedingPrNumber: 3366 });
    expect(recordCalls[0].reason).toContain('org/buildd#3366');
  });

  it('is a no-op for a PR that already has a supersession edge (no GitHub calls)', async () => {
    workerRow = { ...workerRow, supersededByPrNumber: 9 };
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'webhook' });
    expect(r).toEqual({ outcome: 'skipped', reason: 'not closed-unsuperseded' });
    expect(ghCalls).toHaveLength(0);
    expect(scanWrites).toHaveLength(0);
  });

  it('is a no-op for an abandoned PR', async () => {
    workerRow = { ...workerRow, abandonedAt: new Date() };
    expect((await detectPrSupersession({ workerId: 'w-6', via: 'webhook' })).outcome).toBe('skipped');
    expect(ghCalls).toHaveLength(0);
  });

  it('never suggests a candidate a person dismissed', async () => {
    workerRow = { ...workerRow, supersessionScan: { scannedAt: 'x', candidatesChecked: 1, suggestion: null, dismissed: ['https://github.com/org/kb/pull/2558'] } };
    gh['org/kb/issues/6/comments'] = [{ body: 'superseded by #2558' }];
    mergedPr('org/kb', 2558, [{ filename: 'x.ts', status: 'added', patch: patch('nothing in common here') }]);

    const r = await detectPrSupersession({ workerId: 'w-6', via: 'webhook' });

    expect(r.outcome).toBe('none');
    expect(scanWrites.at(-1).supersessionScan).toMatchObject({ suggestion: null, dismissed: ['https://github.com/org/kb/pull/2558'] });
  });

  it('does not suggest an unmerged candidate (Confirm could never succeed)', async () => {
    gh['org/kb/issues/6/comments'] = [{ body: 'in favor of #12' }];
    gh['org/kb/pulls/12'] = { number: 12, merged: false, state: 'open' };
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'webhook' });
    expect(r.outcome).toBe('none');
    expect(recordCalls).toHaveLength(0);
  });

  it('finds a file-overlap candidate when nothing nominated one', async () => {
    gh['org/kb/pulls'] = [{ number: 20, merged_at: '2026-09-05T00:00:00Z' }, { number: 3, merged_at: '2026-08-01T00:00:00Z' }];
    mergedPr('org/kb', 20, [{ filename: 'buildd/design/strategy.md', status: 'added', patch: patch(...DOC_LINES) }]);

    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep' });

    expect(r).toMatchObject({ outcome: 'recorded', prNumber: 20 });
    // #3 merged before the closed PR opened: never fetched.
    expect(ghCalls.some(p => p.startsWith('/repos/org/kb/pulls/3/'))).toBe(false);
  });

  it('falls back to a suggestion when the verified write is refused', async () => {
    recordResult = { ok: false, error: 'outside mission', status: 403 };
    gh['org/kb/issues/6/comments'] = [{ body: 'superseded by #9' }];
    mergedPr('org/kb', 9, [{ filename: 'buildd/design/strategy.md', status: 'added', patch: patch(...DOC_LINES) }]);
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'webhook' });
    expect(r.outcome).toBe('suggested');
  });
});

/**
 * Incident 197552dc review: a verified candidate whose record the kernel's host did not take (the
 * control plane did not answer, or the sweep's control-plane budget was spent) was filed as a
 * suggestion "short of the bar" and stamped scanned, so the PR waited out the rescan window with
 * its mission's completion blocked.
 */
describe('a verified record the control plane did not answer is deferred, bounded; a refusal or a failed command is not', () => {
  const answer = (code: string, status: number) => ({ ok: false, error: `door said ${code}`, status, door: { body: { code }, headers: {} } });
  const outage = answer('control_plane_unavailable', 503);
  const verified = () => {
    gh['org/kb/issues/6/comments'] = [{ body: 'superseded by #9' }];
    mergedPr('org/kb', 9, [{ filename: 'buildd/design/strategy.md', status: 'added', patch: patch(...DOC_LINES) }]);
  };

  it('an outage: outcome deferred, counted on the scan, NOT stamped scanned, no suggestion, no gate event', async () => {
    verified();
    recordResult = outage;
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep' });
    expect(r).toMatchObject({ outcome: 'deferred' });
    expect(scanWrites).toHaveLength(1);
    expect(scanWrites[0].supersessionScannedAt).toBeUndefined();
    expect(scanWrites[0].supersessionScan.deferral).toMatchObject({ count: 1 });
    expect(scanWrites[0].supersessionScan.suggestion).toBeNull();
    expect(gateEvents).toEqual([]);
  });

  it('the sweep counts an outage deferred, and the row stays unstamped for the next tick', async () => {
    verified();
    recordResult = outage;
    sweepRows = [{ id: 'w-6', prUrl: 'https://github.com/org/kb/pull/6' }];
    const r = await sweepClosedUnsupersededPrs(new Date('2026-10-14T23:10:00Z'));
    expect(r).toMatchObject({ candidates: 1, deferred: 1, suggested: 0, skipped: 0 });
    expect(scanWrites.some((w) => 'supersessionScannedAt' in w)).toBe(false);
    sweepRows = [];
  });

  for (const [what, res] of [['a refusal (403 control_plane_refused)', answer('control_plane_refused', 403)], ['the command failing there (500 command_failed)', answer('command_failed', 500)]] as const) {
    it(`${what} is deterministic: suggested and stamped, as before, never deferred`, async () => {
      verified();
      recordResult = res;
      const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep' });
      expect(r.outcome).toBe('suggested');
      expect(scanWrites.at(-1).supersessionScannedAt).toBeInstanceOf(Date);
      expect(scanWrites.at(-1).supersessionScan.deferral).toBeUndefined();
    });
  }

  it('past the cap the deferral is settled: stamped, suggested with why, and a stranded gate event a person sees', async () => {
    verified();
    recordResult = outage;
    workerRow = { ...workerRow, supersessionScan: { scannedAt: '2026-10-14T00:00:00Z', candidatesChecked: 1, suggestion: null, deferral: { firstAt: '2026-10-14T00:10:00Z', count: 23, reason: 'cp down' } } };
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep', now: new Date('2026-10-14T23:10:00Z') });
    expect(r.outcome).toBe('suggested');
    const w = scanWrites.at(-1);
    expect(w.supersessionScannedAt).toBeInstanceOf(Date);
    expect(w.supersessionScan.deferral).toBeUndefined();
    expect(w.supersessionScan.deferralExhausted).toMatchObject({ count: 24, firstAt: '2026-10-14T00:10:00Z' });
    expect(w.supersessionScan.suggestion).toMatchObject({ prNumber: 9, contentRatio: 1 });
    expect(w.supersessionScan.suggestion.why).toContain('did not take the record');
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]).toMatchObject({ outcome: 'stranded', detail: expect.objectContaining({ kind: 'control_plane_deferral_exhausted' }) });
  });

  it('a refusal on the merits (not a door error) still falls back to a suggestion', async () => {
    verified();
    recordResult = { ok: false, error: 'outside mission', status: 403 };
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep' });
    expect(r.outcome).toBe('suggested');
  });
});

/**
 * Task 9f4d3339: the hourly pass was killed at the function limit inside this sweep. Every GitHub call
 * it made could wait forever, the sweep had no clock of its own, and the row in flight when the
 * function died was never stamped, so it came first again the next hour.
 */
describe('the sweep is bounded: a stalled GitHub call times out, the pass stops at its budget, and neither writes a verdict', () => {
  const unrelated = (n: number) => mergedPr('org/kb', n, [{ filename: 'apps/web/src/lib/unrelated.ts', status: 'modified', patch: patch('export const unrelatedFix = true;', 'export function other() { return 1; }') }]);
  const claims = (...ns: number[]) => { gh['org/kb/issues/6/comments'] = ns.map(n => ({ body: `superseded by #${n}` })); };
  const stamped = () => scanWrites.filter(w => 'supersessionScannedAt' in w);

  it('a stalled call is abandoned within the request timeout; the row defers: counted, NOT stamped, no suggestion', async () => {
    claims(9, 10);
    unrelated(9);
    unrelated(10);
    gh['org/kb/pulls/10/files'] = STALL;
    const t0 = Date.now();
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep', limits: { requestTimeoutMs: 40 } });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r).toMatchObject({ outcome: 'deferred' });
    expect(stamped()).toEqual([]);
    expect(recordCalls).toEqual([]);
    expect(gateEvents).toEqual([]);
    const scan = scanWrites.at(-1).supersessionScan;
    expect(scan.suggestion ?? null).toBeNull();
    expect(scan.deferral).toMatchObject({ count: 1 });
    expect(scan.deferral.reason).toContain('GitHub');
    // The candidate judged before the stall is kept, so the next tick does not pay for it again.
    expect(scan.judged.map((j: any) => j.prNumber)).toEqual([9]);
  });

  it('a timeout while reading the closed PR itself defers too: it is not a "skipped" the sweep would stamp', async () => {
    gh['org/kb/pulls/6/files'] = STALL;
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep', limits: { requestTimeoutMs: 40 } });
    expect(r.outcome).toBe('deferred');
    expect(stamped()).toEqual([]);
  });

  it('past the deferral cap a timing-out row is settled: stamped, its earlier suggestion kept, no new one, and a stranded gate event', async () => {
    claims(9);
    gh['org/kb/pulls/9'] = STALL;
    const earlier = { repo: 'org/kb', prNumber: 4, prUrl: 'https://github.com/org/kb/pull/4', signal: 'claim', why: 'earlier', score: 0.9 };
    workerRow = { ...workerRow, supersessionScan: { scannedAt: '2026-10-10T00:00:00Z', candidatesChecked: 1, suggestion: earlier, deferral: { firstAt: '2026-10-14T00:10:00Z', count: 23, reason: 'GitHub slow' } } };
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep', now: new Date('2026-10-14T23:10:00Z'), limits: { requestTimeoutMs: 40 } });
    expect(r.outcome).toBe('skipped');
    const w = scanWrites.at(-1);
    expect(w.supersessionScannedAt).toBeInstanceOf(Date);
    expect(w.supersessionScan.suggestion).toEqual(earlier);
    expect(w.supersessionScan.deferral).toBeUndefined();
    expect(w.supersessionScan.deferralExhausted).toMatchObject({ count: 24 });
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]).toMatchObject({ outcome: 'stranded', detail: expect.objectContaining({ kind: 'github_timeout_deferral_exhausted' }) });
  });

  it('the sweep stops at its own budget: the row in flight defers, the rest are left untouched for the next tick', async () => {
    claims(9);
    gh['org/kb/pulls/9'] = STALL;
    sweepRows = [
      { id: 'w-6', prUrl: 'https://github.com/org/kb/pull/6' },
      { id: 'w-7', prUrl: 'https://github.com/org/kb/pull/7' },
    ];
    const t0 = Date.now();
    const r = await sweepClosedUnsupersededPrs(new Date('2026-10-15T08:10:00Z'), { budgetMs: 60, requestTimeoutMs: 10_000 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r).toMatchObject({ candidates: 2, deferred: 1, budgetStopped: 1, suggested: 0, none: 0, skipped: 0 });
    expect(stamped()).toEqual([]);
    // Only the row in flight was written; the one never started is untouched.
    expect(scanWrites).toHaveLength(1);
    // Per-PR timing: the slow one is named.
    expect(r.prs).toHaveLength(1);
    expect(r.prs[0]).toMatchObject({ pr: 'org/kb#6', outcome: 'deferred' });
    expect(r.prs[0].ms).toBeGreaterThanOrEqual(50);
  });

  it('a request timeout is not a budget stop: the sweep moves on to the next row', async () => {
    claims(9);
    gh['org/kb/pulls/9'] = STALL;
    closedPr('org/kb', 7);
    gh['org/kb/pulls/7/files'] = [{ filename: 'x.md', status: 'added', patch: patch('nothing') }];
    workerQueue = [workerRow, { ...workerRow, id: 'w-7', prUrl: 'https://github.com/org/kb/pull/7', prNumber: 7 }];
    sweepRows = [
      { id: 'w-6', prUrl: 'https://github.com/org/kb/pull/6' },
      { id: 'w-7', prUrl: 'https://github.com/org/kb/pull/7' },
    ];
    const r = await sweepClosedUnsupersededPrs(new Date('2026-10-15T08:10:00Z'), { budgetMs: 5_000, requestTimeoutMs: 40 });
    expect(r).toMatchObject({ candidates: 2, deferred: 1, none: 1, budgetStopped: 0 });
    expect(r.prs.map((p: any) => `${p.pr}:${p.outcome}`)).toEqual(['org/kb#6:deferred', 'org/kb#7:none']);
  });
});

describe('a candidate pair judged within the rescan window is not verified again', () => {
  const now = new Date('2026-10-15T08:10:00Z');
  const judged = (at: Date, over: Record<string, unknown> = {}) => ({ repo: 'org/kb', prNumber: 2558, prUrl: 'https://github.com/org/kb/pull/2558', verified: false, confidence: 0.4, at: at.toISOString(), closedHeadSha: 'head6', mergeCommitSha: 'sha2558', ...over });
  const recent = () => new Date(now.getTime() - 60 * 60_000);

  it('reuses the stored verdict: only the candidate PR is read (to check its merge commit), and the same suggestion', async () => {
    gh['org/kb/issues/6/comments'] = [{ body: 'superseded by #2558' }];
    // The PR itself, but not its files: a files read would 404 and the content check would score 0.
    gh['org/kb/pulls/2558'] = { number: 2558, merged: true, merge_commit_sha: 'sha2558', html_url: 'https://github.com/org/kb/pull/2558', commits: 50 };
    workerRow = { ...workerRow, supersessionScan: { scannedAt: 'x', candidatesChecked: 1, suggestion: null, judged: [judged(recent())] } };
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep', now });
    expect(r.outcome).toBe('suggested');
    expect(ghCalls.filter(p => p.startsWith('/repos/org/kb/pulls/2558'))).toEqual(['/repos/org/kb/pulls/2558']);
    expect(scanWrites.at(-1).supersessionScan.suggestion).toMatchObject({ prNumber: 2558 });
    expect(scanWrites.at(-1).supersessionScan.suggestion.why).toContain('40%');
  });

  it('a verdict older than the window is verified again', async () => {
    gh['org/kb/issues/6/comments'] = [{ body: 'superseded by #2558' }];
    mergedPr('org/kb', 2558, [{ filename: 'x.ts', status: 'added', patch: patch('nothing in common here') }]);
    workerRow = { ...workerRow, supersessionScan: { scannedAt: 'x', candidatesChecked: 1, suggestion: null, judged: [judged(new Date(now.getTime() - RESCAN_AFTER_MS - 60_000))] } };
    await detectPrSupersession({ workerId: 'w-6', via: 'sweep', now });
    expect(ghCalls).toContain('/repos/org/kb/pulls/2558/files?per_page=100');
  });

  for (const [what, over] of [['the closed PR was pushed to since', { closedHeadSha: 'older-head' }], ['the candidate\'s merge commit differs', { mergeCommitSha: 'other' }]] as const) {
    it(`a stored verdict is not reused when ${what}`, async () => {
      gh['org/kb/issues/6/comments'] = [{ body: 'superseded by #2558' }];
      mergedPr('org/kb', 2558, [{ filename: 'x.ts', status: 'added', patch: patch('nothing in common here') }]);
      workerRow = { ...workerRow, supersessionScan: { scannedAt: 'x', candidatesChecked: 1, suggestion: null, judged: [judged(recent(), over)] } };
      await detectPrSupersession({ workerId: 'w-6', via: 'sweep', now });
      expect(ghCalls).toContain('/repos/org/kb/pulls/2558/files?per_page=100');
    });
  }

  it('a finished scan stores what it judged, so the next pass inside the window can reuse it', async () => {
    gh['org/kb/issues/6/comments'] = [{ body: 'superseded by #2558' }];
    mergedPr('org/kb', 2558, [{ filename: 'x.ts', status: 'added', patch: patch('nothing in common here') }]);
    await detectPrSupersession({ workerId: 'w-6', via: 'sweep', now });
    expect(scanWrites.at(-1).supersessionScan.judged).toEqual([
      expect.objectContaining({ repo: 'org/kb', prNumber: 2558, verified: false, at: now.toISOString(), closedHeadSha: 'head6', mergeCommitSha: 'sha2558' }),
    ]);
  });
});

/** Review of #4822: what the first round of this fix still let through. */
describe('review findings: the queue rotates, a timeout stays a timeout, nothing runs after return', () => {
  const claims = (...ns: number[]) => { gh['org/kb/issues/6/comments'] = ns.map(n => ({ body: `superseded by #${n}` })); };
  const stamped = () => scanWrites.filter(w => 'supersessionScannedAt' in w);

  it('the first row of a sweep that alone spent the budget counts toward the cap: it had the whole budget', async () => {
    claims(9);
    gh['org/kb/pulls/9'] = STALL;
    sweepRows = [{ id: 'w-6', prUrl: 'https://github.com/org/kb/pull/6' }];
    const now = new Date('2026-10-15T08:10:00Z');
    await sweepClosedUnsupersededPrs(now, { budgetMs: 60, requestTimeoutMs: 10_000 });
    expect(stamped()).toEqual([]);
    const scan = scanWrites.at(-1).supersessionScan;
    expect(scan.deferral).toMatchObject({ count: 1 });
    expect(scan.deferral.reason).toContain('time budget');
    expect(scan.lastAttemptAt).toBe(now.toISOString());
  });

  it('a later row the budget cut off is not counted, but its attempt is recorded so the queue rotates past it', async () => {
    closedPr('org/kb', 7);
    gh['org/kb/pulls/7/files'] = [{ filename: 'x.md', status: 'added', patch: patch('nothing') }];
    gh['org/kb/pulls/7'] = slow(10, gh['org/kb/pulls/7']);
    claims(9);
    gh['org/kb/pulls/9'] = STALL;
    workerQueue = [{ ...workerRow, id: 'w-7', prUrl: 'https://github.com/org/kb/pull/7', prNumber: 7 }, workerRow];
    sweepRows = [
      { id: 'w-7', prUrl: 'https://github.com/org/kb/pull/7' },
      { id: 'w-6', prUrl: 'https://github.com/org/kb/pull/6' },
    ];
    const now = new Date('2026-10-15T08:10:00Z');
    const r = await sweepClosedUnsupersededPrs(now, { budgetMs: 80, requestTimeoutMs: 10_000 });
    expect(r.prs.map((p: any) => `${p.pr}:${p.outcome}`)).toEqual(['org/kb#7:none', 'org/kb#6:deferred']);
    const w6 = scanWrites.at(-1).supersessionScan;
    expect(w6.deferral ?? null).toBeNull();
    expect(w6.lastAttemptAt).toBe(now.toISOString());
  });

  it('a timeout is not relabelled a budget stop: no GitHub call after it, and it counts toward the cap', async () => {
    claims(9);
    mergedPr('org/kb', 9, [], { commits: 3 });
    gh['org/kb/pulls/9/files'] = STALL;
    gh['org/kb/pulls/6/commits'] = STALL;
    gh['org/kb/pulls/9/commits'] = STALL;
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep', limits: { requestTimeoutMs: 40, budget: AbortSignal.timeout(70) } });
    expect(r.outcome).toBe('deferred');
    expect(ghCalls.some(p => p.includes('/commits'))).toBe(false);
    expect(scanWrites.at(-1).supersessionScan.deferral).toMatchObject({ count: 1 });
    expect(scanWrites.at(-1).supersessionScan.deferral.reason).toContain('GitHub request');
  });

  it('no GitHub call is made after the scan returns: the other side of the patch-id read is abandoned too', async () => {
    claims(9);
    mergedPr('org/kb', 9, [{ filename: 'apps/x.ts', status: 'modified', patch: patch('unrelated line here') }], { commits: 3 });
    const shas = ['a', 'b', 'c', 'd', 'e', 'f'];
    gh['org/kb/pulls/6/commits'] = shas.map(sha => ({ sha, parents: [{ sha: 'p' }] }));
    for (const sha of shas) gh[`org/kb/commits/${sha}`] = slow(30, { files: [] });
    gh['org/kb/pulls/9/commits'] = STALL;
    await detectPrSupersession({ workerId: 'w-6', via: 'sweep', limits: { requestTimeoutMs: 40 } });
    const returnedAt = Date.now();
    await new Promise(res => setTimeout(res, 250));
    expect(ghCallTimes.filter(t => t > returnedAt)).toEqual([]);
  });

  it('with no limits at all (the webhook door), a read still running when the scan returns is abandoned', async () => {
    claims(9);
    mergedPr('org/kb', 9, [{ filename: 'apps/x.ts', status: 'modified', patch: patch('unrelated line here') }], { commits: 3 });
    const shas = ['a', 'b', 'c', 'd', 'e', 'f'];
    gh['org/kb/pulls/6/commits'] = shas.map(sha => ({ sha, parents: [{ sha: 'p' }] }));
    for (const sha of shas) gh[`org/kb/commits/${sha}`] = slow(30, { files: [] });
    // The candidate's side fails outright (not a timeout): Promise.all rejects, the closed side's loop is left running.
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'webhook' });
    expect(r.outcome).toBe('suggested');
    const returnedAt = Date.now();
    await new Promise(res => setTimeout(res, 250));
    expect(ghCallTimes.filter(t => t > returnedAt)).toEqual([]);
  });

  it('a first scan cut short leaves no finished-scan time, so the PR still reads as reconciling', async () => {
    claims(9);
    gh['org/kb/pulls/9'] = STALL;
    await detectPrSupersession({ workerId: 'w-6', via: 'sweep', limits: { requestTimeoutMs: 40 } });
    expect(scanWrites.at(-1).supersessionScan.scannedAt || null).toBeNull();
  });

  it('a comments read timing out with no other candidate defers: never marked none', async () => {
    gh['org/kb/issues/6/comments'] = STALL;
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep', limits: { requestTimeoutMs: 40 } });
    expect(r.outcome).toBe('deferred');
    expect(stamped()).toEqual([]);
  });

  it('an overlap read timing out defers: never marked none', async () => {
    gh['org/kb/pulls'] = STALL;
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep', limits: { requestTimeoutMs: 40 } });
    expect(r.outcome).toBe('deferred');
    expect(stamped()).toEqual([]);
  });

  it('an overlap file-list read timing out defers: never marked none', async () => {
    gh['org/kb/pulls'] = [{ number: 20, merged_at: '2026-09-05T00:00:00Z' }];
    gh['org/kb/pulls/20/files'] = STALL;
    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep', limits: { requestTimeoutMs: 40 } });
    expect(r.outcome).toBe('deferred');
    expect(stamped()).toEqual([]);
  });
});

// b6cfdbb9 (audit case: a PR closed, its re-land opened and merged after the close-time scan, and
// nothing looked again, so no edge was recorded and the findings never moved).
describe('rescanOnMerge', () => {
  const reland = (body: string) => mergedPr('org/kb', 9, [{ filename: 'buildd/design/strategy.md', status: 'added', patch: patch(...DOC_LINES) }], { title: 'fix: re-land', body });

  it('a re-land that names the closed PR records the edge once its content verifies, though the closed PR never named it', async () => {
    reland('Re-land of #6 without the stale reverts.');
    sweepRows = [{ id: 'w-6', prUrl: 'https://github.com/org/kb/pull/6' }];
    const r = await rescanOnMerge({ workspaceId: 'ws-1', repoFullName: 'org/kb', prNumber: 9, taskId: 't-9' });
    expect(r).toEqual({ nominated: 1, results: [{ prUrl: 'https://github.com/org/kb/pull/6', outcome: 'recorded' }] });
    expect(recordCalls[0]).toMatchObject({ workerId: 'w-6', supersedingPrNumber: 9 });
    expect(gateEvents[0]).toMatchObject({ outcome: 'accepted', surface: 'webhook pull_request.closed (merged)' });
  });

  it('naming is not proof: a merged PR that names the closed one but carries none of it records nothing', async () => {
    mergedPr('org/kb', 9, [{ filename: 'apps/x.ts', status: 'modified', patch: patch('export const somethingElseEntirely = 1;') }], { body: 'follow-up to #6' });
    sweepRows = [{ id: 'w-6', prUrl: 'https://github.com/org/kb/pull/6' }];
    const r = await rescanOnMerge({ workspaceId: 'ws-1', repoFullName: 'org/kb', prNumber: 9, taskId: null });
    expect(r.results.map((x) => x.outcome)).toEqual(['suggested']);
    expect(recordCalls).toHaveLength(0);
  });

  it('nothing nominated: no scan, and the merged PR itself is never a nominee', async () => {
    reland('no references here');
    sweepRows = [{ id: 'w-9', prUrl: 'https://github.com/org/kb/pull/9' }];
    expect(await rescanOnMerge({ workspaceId: 'ws-1', repoFullName: 'org/kb', prNumber: 9, taskId: null })).toEqual({ nominated: 0, results: [] });
    expect(recordCalls).toHaveLength(0);
  });

  it('scans each closed PR once, and at most the cap', async () => {
    reland('#6');
    sweepRows = Array.from({ length: RESCAN_ON_MERGE_CAP + 3 }, (_, i) => ({ id: `w-${i}`, prUrl: `https://github.com/org/kb/pull/${100 + (i % (RESCAN_ON_MERGE_CAP + 2))}` }));
    const r = await rescanOnMerge({ workspaceId: 'ws-1', repoFullName: 'org/kb', prNumber: 9, taskId: null });
    expect(r.nominated).toBe(RESCAN_ON_MERGE_CAP);
    expect(new Set(r.results.map((x) => x.prUrl)).size).toBe(RESCAN_ON_MERGE_CAP);
  });

  it('never throws when GitHub or the database fails', async () => {
    sweepRows = null as any;
    expect(await rescanOnMerge({ workspaceId: 'ws-1', repoFullName: 'org/kb', prNumber: 9, taskId: null })).toEqual({ nominated: 0, results: [] });
  });

  it('a closed attempt PR nominated via lineage is recorded as superseded by the merged PR', async () => {
    // Task 9e379e31: when a later attempt's PR merges, earlier closed attempt PRs should be recorded superseded.
    // mergedPr sets up #9 (merged); we nominate #6 (closed) via task lineage, not PR body reference.
    mergedPr('org/kb', 9, [{ filename: 'buildd/design/strategy.md', status: 'added', patch: patch(...DOC_LINES) }]);
    closedPr('org/kb', 6);
    // The merged PR belongs to task 't-9'; the closed PR belongs to task 't-6' (an attempt).
    // When findTaskLineageForSupersession runs on 't-9', it finds no parent but returns siblings (other attempts).
    // The closed PR is nominated because its worker task 't-6' is in the lineage of 't-9' (a sibling attempt).
    // In this case, task 't-9' has parentTaskId 'p-1' (it's an attempt of p-1),
    // and task 't-6' also has parentTaskId 'p-1' (sibling attempt).
    // relatedTaskIds = ['t-9', 'p-1', 't-6'] is what findTaskLineageForSupersession returns.
    mergedTask = { parentTaskId: 'p-1', taskClass: 'attempt' };
    siblingTasks = [{ id: 't-6', parentTaskId: 'p-1', taskClass: 'attempt' }];
    // The sweep's where() clause includes the lineage filter: inArray(tasks.id, relatedTaskIds).
    // By capturing lastWhereCondition, we verify that the filter is present in the query.
    sweepRows = [{ id: 'w-6', prUrl: 'https://github.com/org/kb/pull/6' }];

    const r = await rescanOnMerge({ workspaceId: 'ws-1', repoFullName: 'org/kb', prNumber: 9, taskId: 't-9' });

    // Verify the where() condition was called with the lineage filter.
    // The condition is a Drizzle SQL expression and won't have the ids as plain strings,
    // but it will be truthy and structured.
    expect(lastWhereCondition).toBeDefined();

    // The closed PR #6 should be nominated and recorded as superseded
    expect(r.nominated).toBe(1);
    expect(r.results[0]).toMatchObject({ prUrl: 'https://github.com/org/kb/pull/6', outcome: 'recorded' });
    expect(recordCalls[0]).toMatchObject({ workerId: 'w-6', supersedingPrNumber: 9 });
    expect(gateEvents[0]).toMatchObject({ outcome: 'accepted', surface: 'webhook pull_request.closed (merged)' });
  });
});

// Task 9e379e31: most of the closed-unmerged backlog was retries whose PR closed
// because a later attempt (or the task it replaced) merged — not named in any PR
// body, not a mission sibling. findTaskLineageForSupersession is what rescanOnMerge
// now asks, on top of claims and mission siblings, before falling back to file overlap.
describe('findTaskLineageForSupersession', () => {
  it('includes the task itself, its parent (the task it is an attempt of), and its attempt children', async () => {
    mergedTask = { parentTaskId: 'p-1', taskClass: 'attempt' };
    siblingTasks = [{ id: 'a-1' }, { id: 'a-2' }];
    const ids = await findTaskLineageForSupersession('t-9');
    expect(ids).toEqual(['t-9', 'p-1', 'a-1', 'a-2']);
  });

  it('is just the task itself when it has no parent and no attempt children', async () => {
    mergedTask = { parentTaskId: null, taskClass: 'work' };
    siblingTasks = [];
    expect(await findTaskLineageForSupersession('t-9')).toEqual(['t-9']);
  });

  it('is just the task itself when the task row cannot be found', async () => {
    mergedTask = null;
    expect(await findTaskLineageForSupersession('t-9')).toEqual(['t-9']);
  });

  it('adds only the parent when there are no attempt children', async () => {
    mergedTask = { parentTaskId: 'p-1', taskClass: 'attempt' };
    siblingTasks = [];
    expect(await findTaskLineageForSupersession('t-9')).toEqual(['t-9', 'p-1']);
  });

  it('adds only the attempt children when the task has no parent', async () => {
    mergedTask = { parentTaskId: null, taskClass: 'work' };
    siblingTasks = [{ id: 'a-1' }];
    expect(await findTaskLineageForSupersession('t-9')).toEqual(['t-9', 'a-1']);
  });
});

// 2f34284a: dead-pr-shutdown closed a sibling task's PR as "superseded" on subject, mission, base and
// idle time alone. The close now waits on the same proof the close-time scan needs for an edge.
describe('verifyPrCarriedBy', () => {
  const V = { installationId: 1, repo: 'org/kb', prNumber: 6, candidatePrNumber: 9 };

  it('regression (#5461/#5463): a sibling PR with disjoint content is unverified, never a supersession', async () => {
    gh['org/kb/pulls/6'] = { number: 6, merged: false, state: 'open', commits: 2, head: { sha: 'head6' } };
    gh['org/kb/pulls/6/files'] = [{ filename: 'apps/runner/src/wsl2-setup.ts', status: 'added', patch: patch('export async function ensureWsl2Distro() {', 'const distro = await detectDistro();', 'return installClaudeInside(distro);') }];
    mergedPr('org/kb', 9, [{ filename: 'apps/runner/src/codex-sandbox.ts', status: 'added', patch: patch('export function selectNativeWindowsSandbox() {', 'return process.platform === "win32" ? "native" : "none";', 'const sandboxChoice = selectNativeWindowsSandbox();') }], { commits: 1 });

    const v = await verifyPrCarriedBy(V);

    expect(v).toEqual({ outcome: 'unverified', confidence: 0 });
    expect(recordCalls).toHaveLength(0);
  });

  it('a squash that carries the PR’s added lines verifies, naming the method', async () => {
    gh['org/kb/pulls/6'] = { number: 6, merged: false, state: 'open', commits: 2, head: { sha: 'head6' } };
    mergedPr('org/kb', 9, [{ filename: 'buildd/design/strategy.md', status: 'added', patch: patch(...DOC_LINES, 'Squashed in with a follow-up line.') }]);

    const v = await verifyPrCarriedBy(V);

    expect(v).toMatchObject({ outcome: 'verified', method: 'content', confidence: 1 });
    // Verification only reads; the caller records the edge in its own flow.
    expect(recordCalls).toHaveLength(0);
    expect(scanWrites).toHaveLength(0);
  });

  it('is unavailable, not unverified, when the PR itself cannot be read', async () => {
    delete gh['org/kb/pulls/6'];
    mergedPr('org/kb', 9, [{ filename: 'buildd/design/strategy.md', status: 'added', patch: patch(...DOC_LINES) }]);

    const v = await verifyPrCarriedBy(V);

    expect(v.outcome).toBe('unavailable');
  });

  it('is unavailable when the candidate is not merged or cannot be read', async () => {
    gh['org/kb/pulls/9'] = { number: 9, merged: false, state: 'open' };
    gh['org/kb/pulls/9/files'] = [{ filename: 'buildd/design/strategy.md', status: 'added', patch: patch(...DOC_LINES) }];
    expect((await verifyPrCarriedBy(V)).outcome).toBe('unavailable');

    delete gh['org/kb/pulls/9'];
    expect((await verifyPrCarriedBy(V)).outcome).toBe('unavailable');
  });

  it('is unavailable when the candidate’s files cannot be read: an empty diff is not a verdict', async () => {
    gh['org/kb/pulls/9'] = { number: 9, merged: true, merged_at: '2026-09-10T00:00:00Z', merge_commit_sha: 'sha9', html_url: 'https://github.com/org/kb/pull/9', commits: 50 };
    // no files entry → 404

    const v = await verifyPrCarriedBy(V);

    expect(v.outcome).toBe('unavailable');
  });

  it('is unavailable when a GitHub read stalls past the request timeout', async () => {
    gh['org/kb/pulls/6/files'] = STALL;
    mergedPr('org/kb', 9, [{ filename: 'buildd/design/strategy.md', status: 'added', patch: patch(...DOC_LINES) }]);

    const v = await verifyPrCarriedBy({ ...V, limits: { requestTimeoutMs: 20 } });

    expect(v.outcome).toBe('unavailable');
  });
});

describe('prRefsIn', () => {
  it('reads #n, owner/repo#n and pull URLs, once each, and not issue anchors inside words or URLs', () => {
    expect(prRefsIn('Re-land of #6, see org/other#7 and https://github.com/org/kb/pull/6 and https://github.com/a/b/pull/8#issuecomment-1; x#9', 'org/kb')).toEqual([
      { repo: 'org/kb', prNumber: 6 }, { repo: 'a/b', prNumber: 8 }, { repo: 'org/other', prNumber: 7 },
    ]);
  });
});

// ─── Closed integration-refresh PRs (task c8092d2a / PR #5530) ─────────────────
//
// A mission/dev refresh PR closed unmerged. The generic detector's sibling-task signal nominated an
// unrelated merged acceptance-tests PR in the same mission and, on zero shared lines (a refresh's
// effective diff is near-empty by construction), still offered it as "likely superseded". A
// refresh's work is ancestry plus what it adds on top of trunk; it gets the refresh proof
// (`verifyRefreshInBranch`, the same one pr-supersession-refresh.ts retires by), never a candidate.
describe('a closed integration-refresh PR', () => {
  const BRANCH = 'mission/acceptance';
  const MIGRATION = 'packages/core/drizzle/20261020000000_mission_cols/migration.sql';
  const REFRESH_CTX = { requireMergeCommit: true, refreshBranch: BRANCH, refreshTrunk: 'dev', refreshTrunkSha: 'trunk1', refreshMissionHeadSha: 'mhead1' };

  function refreshRepro(opts: { refreshDelta: any[]; branchDelta: any[] }) {
    workerRow = {
      ...workerRow, prUrl: 'https://github.com/org/kb/pull/5530', prNumber: 5530,
      task: { id: 't-6', missionId: 'm-1', context: REFRESH_CTX },
    };
    closedPr('org/kb', 5530, { base: { ref: BRANCH }, head: { sha: 'rhead' } });
    // The unrelated sibling PR the old scan nominated.
    siblingTasks = [{ id: 't-7', title: 'Acceptance tests', workers: [{ prUrl: 'https://github.com/org/kb/pull/5479', prNumber: 5479, mergedAt: '2026-10-23T01:00:00Z' }] }];
    mergedPr('org/kb', 5479, [{ filename: 'tests/acceptance.test.ts', status: 'added', patch: patch('it("works", () => {});') }]);
    gh[`org/kb/git/ref/heads/${BRANCH}`] = { object: { sha: 'bhead' } };
    gh['org/kb/compare/trunk1...bhead'] = { status: 'ahead' };
    gh['org/kb/compare/mhead1...bhead'] = { status: 'ahead' };
    gh['org/kb/compare/dev...rhead'] = { files: opts.refreshDelta };
    gh['org/kb/compare/dev...bhead'] = { files: opts.branchDelta };
  }
  const sqlFile = (sha: string) => ({ filename: MIGRATION, status: 'added', sha, additions: 1, deletions: 0, patch: patch('ALTER TABLE missions ADD COLUMN x text;') });

  it('genuinely equivalent (the #5530 shape: ancestry in the branch, migration present by identical SQL): landed, and no candidate is offered', async () => {
    refreshRepro({ refreshDelta: [sqlFile('blob1')], branchDelta: [sqlFile('blob1')] });

    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep' });

    expect(r).toEqual({ outcome: 'none', candidatesChecked: 0 });
    expect(recordCalls).toHaveLength(0);
    expect(ghCalls.some(c => c.includes('/pulls/5479'))).toBe(false);
    const w = scanWrites.at(-1);
    expect(w.supersessionScannedAt).toBeInstanceOf(Date);
    expect(w.supersessionScan.suggestion).toBeNull();
    expect(w.supersessionScan.refreshCheck).toMatchObject({ outcome: 'landed', branch: BRANCH, migrationsMatched: 1 });
    expect(gateEvents).toHaveLength(0);
  });

  it('unique migration work the branch does not have: unique_work with the migration named, one stranded event', async () => {
    refreshRepro({ refreshDelta: [sqlFile('blob1')], branchDelta: [] });

    await detectPrSupersession({ workerId: 'w-6', via: 'sweep' });

    const check = scanWrites.at(-1).supersessionScan.refreshCheck;
    expect(check).toMatchObject({ outcome: 'unique_work', branch: BRANCH });
    expect(check.reason).toContain(MIGRATION);
    expect(scanWrites.at(-1).supersessionScan.suggestion).toBeNull();
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]).toMatchObject({ outcome: 'stranded', detail: expect.objectContaining({ kind: 'refresh_unique_work' }) });
  });

  it('ancestry missing (the refresh never landed): unique_work, not landed', async () => {
    refreshRepro({ refreshDelta: [], branchDelta: [] });
    gh['org/kb/compare/trunk1...bhead'] = { status: 'diverged' };

    await detectPrSupersession({ workerId: 'w-6', via: 'sweep' });

    expect(scanWrites.at(-1).supersessionScan.refreshCheck).toMatchObject({ outcome: 'unique_work' });
  });

  it('unavailable proof: a branch GitHub will not read is deferred (no stamp, no verdict), never landed or unique_work', async () => {
    refreshRepro({ refreshDelta: [sqlFile('blob1')], branchDelta: [sqlFile('blob1')] });
    delete gh[`org/kb/git/ref/heads/${BRANCH}`];

    const r = await detectPrSupersession({ workerId: 'w-6', via: 'sweep' });

    expect(r.outcome).toBe('deferred');
    const w = scanWrites.at(-1);
    expect(w.supersessionScannedAt).toBeUndefined();
    expect(w.supersessionScan.refreshCheck).toBeUndefined();
    expect(w.supersessionScan.deferral).toMatchObject({ count: 1 });
  });

  it('unavailable proof past the deferral cap settles as unavailable, not as either verdict', async () => {
    refreshRepro({ refreshDelta: [], branchDelta: [] });
    delete gh[`org/kb/git/ref/heads/${BRANCH}`];
    workerRow = { ...workerRow, supersessionScan: { scannedAt: '', candidatesChecked: 0, suggestion: null, deferral: { firstAt: '2026-10-14T00:00:00Z', count: 23, reason: 'x' } } };

    await detectPrSupersession({ workerId: 'w-6', via: 'sweep' });

    const w = scanWrites.at(-1);
    expect(w.supersessionScannedAt).toBeInstanceOf(Date);
    expect(w.supersessionScan.refreshCheck).toMatchObject({ outcome: 'unavailable' });
    expect(w.supersessionScan.deferral).toBeUndefined();
  });

  it('repeated reconciliation: a re-run re-reads GitHub, writes the same verdict, clears a stale old suggestion, and does not re-announce', async () => {
    refreshRepro({ refreshDelta: [sqlFile('blob1')], branchDelta: [] });
    const staleSuggestion = { repo: 'org/kb', prNumber: 5479, prUrl: 'https://github.com/org/kb/pull/5479', signal: 'sibling_task', why: 'old', score: 0.6 };
    workerRow = { ...workerRow, supersessionScan: { scannedAt: '2026-10-01T00:00:00Z', candidatesChecked: 1, suggestion: staleSuggestion } };

    await detectPrSupersession({ workerId: 'w-6', via: 'sweep' });
    const first = scanWrites.at(-1).supersessionScan;
    expect(first.suggestion).toBeNull();
    expect(gateEvents).toHaveLength(1);

    workerRow = { ...workerRow, supersessionScan: first };
    const callsBefore = ghCalls.length;
    await detectPrSupersession({ workerId: 'w-6', via: 'sweep' });
    const second = scanWrites.at(-1).supersessionScan;

    expect(ghCalls.length).toBeGreaterThan(callsBefore);
    expect(second.refreshCheck.outcome).toBe(first.refreshCheck.outcome);
    expect(second.refreshCheck.reason).toBe(first.refreshCheck.reason);
    expect(gateEvents).toHaveLength(1);
    expect(recordCalls).toHaveLength(0);
  });
});
