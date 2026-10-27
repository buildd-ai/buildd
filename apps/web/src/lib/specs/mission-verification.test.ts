import { describe, it, expect, mock } from 'bun:test';

let prior: any[] = [];
let runs: unknown[] = [];
let inserted: any[] = [];
// What the atomic insert finds already filed: a racing evaluation that won, or nothing.
let raced: any[] | null = null;
const params = (q: any) => (q.queryChunks as unknown[]).filter((c): c is string => typeof c === 'string');
mock.module('./mission-acceptance-checks', () => ({ runFinalAcceptanceChecks: async (...args: unknown[]) => { runs.push(args); } }));
mock.module('@buildd/core/db', () => ({ db: {
  query: {
    tasks: { findMany: async () => prior },
    missions: { findFirst: async () => ({ id: 'm', title: 'Mission', workspaceId: 'ws', integrationBranchEnabled: true, workingBranch: 'mission/x' }) },
    workspaces: { findFirst: async () => ({ id: 'ws' }) },
  },
  execute: (q: unknown) => q,
  batch: async ([, insert]: any[]) => {
    if (raced) { prior = raced; return [{}, { rows: [] }]; }
    const p = params(insert);
    inserted.push({ title: p.find((c) => c.startsWith('[final verification]')), description: p.find((c) => c.startsWith('## Final requirement verification')) });
    return [{}, { rows: [{ id: 'new-final' }] }];
  },
} }));
mock.module('@/lib/dispatch-authority', () => ({ announceTaskCreated: async () => {}, wakeTask: async () => {} }));
mock.module('@/lib/effective-roles', () => ({ pickEffectiveRole: async () => null }));
let claims: any[] = [];
let cleanups: unknown[][] = [];
let cleanupResult: any = { cancelled: [], repointed: [] };
mock.module('./builder-claims-store', () => ({ loadBuilderClaims: async () => claims }));
mock.module('./mission-cleanup', () => ({
  cleanUpSupersededFailures: async (...args: unknown[]) => { cleanups.push(args); return cleanupResult; },
  describeCleanup: (r: any) => r.cancelled.map((c: any) => `- Cancelled failed task ${c.taskId}: superseded by completed task ${c.replacementId}.`),
}));

const { decideFinalVerification, targetKey, MAX_ATTEMPTS_PER_TARGET, ensureFinalVerification } = await import('./mission-verification');

const A = 'a'.repeat(40);
const direct = (mergeShas: string[]) => ({ kind: 'direct' as const, mergeShas, validHeads: new Set<string>() });

describe('final verification is filed once per integrated target', () => {
  it('keys a direct mission on its merged PRs, not on a head', () => {
    expect(targetKey(direct(['c2', 'c1']))).toBe(targetKey(direct(['c1', 'c2'])));
    expect(targetKey(direct(['c1']))).not.toBe(targetKey(direct(['c1', 'c2'])));
    expect(targetKey({ kind: 'integration', headSha: A, branch: 'mission/x' })).toBe(`head:${A}`);
    expect(targetKey({ kind: 'unknown', reason: 'x' })).toBeNull();
  });

  it('reuses an open verification', () => {
    expect(decideFinalVerification([{ id: 't1', status: 'in_progress', targetKey: 'k' }], 'k')).toEqual({ kind: 'open', taskId: 't1' });
  });

  it('does not re-file after a completed run at the same target (an inconclusive verdict waits), direct missions included', () => {
    const key = targetKey(direct(['c1']));
    expect(decideFinalVerification([{ id: 't1', status: 'completed', targetKey: key }], key)).toEqual({ kind: 'open', taskId: 't1' });
  });

  it('files a new one when the target moves', () => {
    expect(decideFinalVerification([{ id: 't1', status: 'completed', targetKey: 'merges:c1' }], 'merges:c1,c2')).toEqual({ kind: 'file' });
  });

  it('retries a failed run once, then stops re-filing', () => {
    expect(decideFinalVerification([{ id: 't1', status: 'failed', targetKey: 'k' }], 'k')).toEqual({ kind: 'file' });
    const twice = Array.from({ length: MAX_ATTEMPTS_PER_TARGET }, (_, i) => ({ id: `t${i}`, status: 'failed', targetKey: 'k' }));
    expect(decideFinalVerification(twice, 'k').kind).toBe('open');
  });
});

it('launches mechanical checks for both newly filed and reused final verification tasks', async () => {
  const criterion = { type: 'living_spec', specId: 's', specRevisionId: 'r', revision: 1, contentHash: 'h' } as any;
  const standing = { target: { kind: 'integration', headSha: A, branch: 'mission/x' }, scope: [], standings: [], title: 'Spec' } as any;
  prior = []; runs = [];
  expect((await ensureFinalVerification('m', criterion, standing)).kind).toBe('dispatched');
  expect(runs).toEqual([['new-final', 'm']]);
  prior = [{ id: 'old-final', status: 'completed', context: { finalVerification: { missionId: 'm', targetKey: `head:${A}` } } }];
  runs = [];
  expect((await ensureFinalVerification('m', criterion, standing)).kind).toBe('open');
  expect(runs).toEqual([['old-final', 'm']]);
});

it('two evaluations racing on one target file one verification: the loser reuses the winner\'s task and its checks', async () => {
  const criterion = { type: 'living_spec', specId: 's', specRevisionId: 'r', revision: 1, contentHash: 'h' } as any;
  const standing = { target: { kind: 'integration', headSha: A, branch: 'mission/x' }, scope: [], standings: [], title: 'Spec' } as any;
  prior = []; runs = []; inserted = [];
  raced = [{ id: 'winner', status: 'pending', context: { finalVerification: { missionId: 'm', targetKey: `head:${A}` } } }];
  try {
    expect(await ensureFinalVerification('m', criterion, standing)).toEqual({ kind: 'open', taskId: 'winner' });
  } finally { raced = null; }
  expect(inserted).toEqual([]);
  expect(runs).toEqual([['winner', 'm']]);
});

it('a standard\'s verification says so and names its spec in the verdict call (D-43)', async () => {
  const standard = { type: 'living_spec', specId: 'voice-spec', specRevisionId: 'rv', revision: 2, contentHash: 'h', role: 'standard' } as any;
  const standing = { target: { kind: 'integration', headSha: A, branch: 'mission/x' }, scope: [], standings: [], title: 'Product voice' } as any;
  prior = []; runs = []; inserted = [];
  expect((await ensureFinalVerification('m', standard, standing)).kind).toBe('dispatched');
  expect(inserted[0].title).toBe('[final verification] standard Product voice revision 2');
  expect(inserted[0].description).toContain('specId: "voice-spec"');
  expect(inserted[0].description).toContain('standard of the workspace');
});

it('tells the verification to file a repair naming the spec and the criterion', async () => {
  const criterion = { type: 'living_spec', specId: 'nav-spec', specRevisionId: 'rv', revision: 3, contentHash: 'h' } as any;
  const standing = { target: { kind: 'integration', headSha: A, branch: 'mission/x' }, scope: [], standings: [], title: 'Navigation' } as any;
  prior = []; runs = []; inserted = [];
  await ensureFinalVerification('m', criterion, standing);
  expect(inserted[0].description).toContain('context.specRepair: { missionId: "m", specId: "nav-spec", criterionId }');
});

describe('the final verification judges the work as a whole', () => {
  const criterion = { type: 'living_spec', specId: 's', specRevisionId: 'r', revision: 1, contentHash: 'h' } as any;
  const standing = { target: { kind: 'integration', headSha: A, branch: 'mission/x' }, scope: [{ id: 'R-1', text: 'Totals add up.' }], standings: [], title: 'Spec' } as any;

  it('the prompt contains each builder\'s summary and the record\'s mismatch flags, and asks for confirmed, contradicted and unchecked claims', async () => {
    prior = []; runs = []; inserted = []; cleanups = [];
    claims = [
      { taskId: 'b1', title: 'Build totals', status: 'completed', summary: 'Pushed the totals fix; all tests pass.', summarySource: 'agent', mismatches: [{ kind: 'pushed_without_diff', detail: 'The summary says work was committed or pushed, but the recorded diff is 0 files, +0, -0.' }], pr: null, reports: [{ id: 'art-1', type: 'report', title: 'Totals report' }], decisions: [], leftUndone: ['Currency rounding'], assumptions: [] },
      { taskId: 'b2', title: 'Build cart', status: 'failed', supersededBy: 'b3', summary: null, mismatches: [{ kind: 'last_command_failed', detail: 'Reported success, but the last test command exited 1.' }], pr: { number: 12, merged: false, closedUnmerged: true }, reports: [] },
    ];
    try {
      await ensureFinalVerification('m', criterion, standing);
    } finally { claims = []; }
    const d = inserted[0].description as string;
    expect(d).toContain('Pushed the totals fix; all tests pass.');
    expect(d).toContain('[pushed_without_diff]');
    expect(d).toContain('[last_command_failed]');
    expect(d).toContain('Left undone: Currency rounding');
    expect(d).toContain('Artifact art-1 (report): Totals report');
    expect(d).toContain('task b2, failed, superseded by b3');
    expect(d).toContain('PR #12: closed without merging');
    expect(d).toMatch(/confirmed.*contradicts.*could not check/);
    expect(d).toContain('A contradicted claim is handled like a failed criterion');
    expect(d).toContain('do not file tasks to do the checking');
  });

  it('cleans up replaced failures before filing, and says what it changed', async () => {
    prior = []; runs = []; inserted = []; cleanups = [];
    cleanupResult = { cancelled: [{ taskId: 'step-1', replacementId: 'step-1b' }], repointed: [] };
    try {
      await ensureFinalVerification('m', criterion, standing);
    } finally { cleanupResult = { cancelled: [], repointed: [] }; }
    expect(cleanups).toEqual([['m', 'ws', 'system:final-verification']]);
    expect(inserted[0].description).toContain('Cancelled failed task step-1: superseded by completed task step-1b.');
  });

  it('a reused verification runs no cleanup: it already ran when that one was filed', async () => {
    prior = [{ id: 'old-final', status: 'pending', context: { finalVerification: { missionId: 'm', targetKey: `head:${A}` } } }];
    cleanups = [];
    expect((await ensureFinalVerification('m', criterion, standing)).kind).toBe('open');
    expect(cleanups).toEqual([]);
  });
});
