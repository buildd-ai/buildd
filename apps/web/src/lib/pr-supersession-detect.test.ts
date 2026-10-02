import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── state the mocks read ────────────────────────────────────────────────────
let workerRow: any = null;
let siblingTasks: any[] = [];
const scanWrites: any[] = [];
/** GitHub, keyed by "owner/repo" then path suffix. */
let gh: Record<string, any> = {};
const ghCalls: string[] = [];
const recordCalls: any[] = [];
let recordResult: any = { ok: true };
const gateEvents: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mock(() => Promise.resolve(workerRow)) },
      tasks: { findMany: mock(() => Promise.resolve(siblingTasks)) },
    },
    update: () => ({ set: (set: any) => ({ where: () => { scanWrites.push(set); return Promise.resolve(); } }) }),
  },
}));
mock.module('@/lib/github', () => ({
  githubApi: mock((_inst: number, path: string) => {
    ghCalls.push(path);
    const m = path.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)$/);
    const repo = m?.[1] ?? '';
    const rest = (m?.[2] ?? '').replace(/\?.*$/, '');
    const v = gh[`${repo}${rest}`];
    if (v === undefined) return Promise.reject(new Error(`GitHub API error: 404 ${path}`));
    return Promise.resolve(v);
  }),
}));
mock.module('@/lib/workspace-installation', () => ({
  installationIdForRepo: mock(() => Promise.resolve(1)),
}));
mock.module('@/lib/pr-supersession', () => ({
  recordPrSupersession: mock((p: any) => { recordCalls.push(p); return Promise.resolve(recordResult); }),
  supersessionRepoScope: mock(() => Promise.resolve(new Set())),
}));
mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: { AUTO_PR_SUPERSESSION: 'auto_pr_supersession' },
  fireGateEvent: mock((e: any) => { gateEvents.push(e); return 'id'; }),
}));

import { detectPrSupersession } from './pr-supersession-detect';

const DOC_LINES = [
  '# Strategy notes',
  'The mission organizer plans tasks from goal criteria.',
  'Each task is claimed by a runner and reports progress.',
  'Supersession records where closed work actually landed.',
];
const patch = (...lines: string[]) => ['@@ -0,0 +1 @@', ...lines.map(l => `+${l}`)].join('\n');

function closedPr(repo: string, n: number, over: Record<string, any> = {}) {
  gh[`${repo}/pulls/${n}`] = { number: n, merged: false, state: 'closed', body: '', created_at: '2026-09-01T00:00:00Z', commits: 2, ...over };
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
  scanWrites.length = 0;
  recordCalls.length = 0;
  gateEvents.length = 0;
  recordResult = { ok: true };
  siblingTasks = [];
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
    expect(scan.suggestion).toMatchObject({ prNumber: 2558, signal: 'claim' });
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
