import { describe, it, expect, mock } from 'bun:test';

let prior: any[] = [];
let runs: unknown[] = [];
mock.module('./mission-acceptance-checks', () => ({ runFinalAcceptanceChecks: async (...args: unknown[]) => { runs.push(args); } }));
mock.module('@buildd/core/db', () => ({ db: {
  query: {
    tasks: { findMany: async () => prior },
    missions: { findFirst: async () => ({ id: 'm', title: 'Mission', workspaceId: 'ws', integrationBranchEnabled: true, workingBranch: 'mission/x' }) },
    workspaces: { findFirst: async () => ({ id: 'ws' }) },
  },
  insert: () => ({ values: () => ({ returning: async () => [{ id: 'new-final' }] }) }),
} }));
mock.module('@/lib/dispatch-authority', () => ({ announceTaskCreated: async () => {}, wakeTask: async () => {} }));
mock.module('@/lib/effective-roles', () => ({ pickEffectiveRole: async () => null }));

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
