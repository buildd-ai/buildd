process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { PrFact, PrFactTarget } from '@buildd/core/pr-facts';

let workspaceRows: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: () => Promise.resolve({ id: 'm1' }) },
      workspaces: { findMany: () => Promise.resolve(workspaceRows) },
    },
    select: () => ({ from: () => ({ innerJoin: () => ({ where: () => Promise.resolve([]) }), where: () => Promise.resolve([]) }) }),
  },
}));

const { importWorkerPrFacts, parsePrUrl } = await import('./pr-fact-import');

let recorded: Array<{ target: PrFactTarget; fact: PrFact }>;
let kernelImports: Array<{ repoFullName: string; prNumber: number }>;
let applies = true;
const record = (async (target: PrFactTarget, fact: PrFact) => {
  recorded.push({ target, fact });
  return applies ? [{ id: 'w1', taskId: 't1', workspaceId: 'ws1', previousStatus: null }] : [];
}) as never;
const importToKernel = async (p: { repoFullName: string; prNumber: number }) => { kernelImports.push(p); };

const worker = (over: Record<string, unknown> = {}) => ({
  id: 'w1', prUrl: 'https://github.com/acme/app/pull/146', prNumber: 146, mergedAt: null, prLifecycleStatus: null, workspaceId: 'ws1', ...over,
}) as any;
const githubApi = (res: Record<string, unknown> | Error) =>
  (() => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res))) as any;

beforeEach(() => {
  recorded = []; kernelImports = []; applies = true;
  workspaceRows = [{ id: 'ws1', githubRepo: { installation: { installationId: 42 } }, githubInstallation: { installationId: 42 } }];
});

describe('parsePrUrl', () => {
  it('extracts repo and number, and rejects anything else', () => {
    expect(parsePrUrl('https://github.com/acme/app/pull/146')).toEqual({ repo: 'acme/app', number: 146 });
    expect(parsePrUrl('https://github.com/acme/app')).toBeNull();
  });
});

describe('importWorkerPrFacts', () => {
  it('a merged PR is a merge fact with GitHub\'s merged_at, and the kernel imports the close', async () => {
    const res = await importWorkerPrFacts([worker()], { githubApi: githubApi({ merged_at: '2026-04-29T10:00:00Z', state: 'closed' }), record, importToKernel });
    expect(recorded).toEqual([{ target: { workerId: 'w1' }, fact: { kind: 'merged', mergedAt: '2026-04-29T10:00:00Z' } }]);
    expect(kernelImports).toEqual([expect.objectContaining({ repoFullName: 'acme/app', prNumber: 146 })]);
    expect(res.fixes).toHaveLength(1);
    expect(res.fixes[0].after).toEqual({ mergedAt: '2026-04-29T10:00:00.000Z', prLifecycleStatus: 'merged' });
  });

  it('a closed-unmerged PR is a close fact', async () => {
    await importWorkerPrFacts([worker()], { githubApi: githubApi({ merged_at: null, state: 'closed' }), record, importToKernel });
    expect(recorded.map((r) => r.fact)).toEqual([{ kind: 'closed' }]);
  });

  it('an open PR writes nothing: never regresses ci_green / conflict back to pr_open (the deleted reconciler\'s bug)', async () => {
    const res = await importWorkerPrFacts([worker({ prLifecycleStatus: 'ci_green' }), worker({ id: 'w2', prLifecycleStatus: 'conflict' })],
      { githubApi: githubApi({ merged_at: null, state: 'open' }), record, importToKernel });
    expect(recorded).toEqual([]);
    expect(kernelImports).toEqual([]);
    expect(res.fixes).toEqual([]);
  });

  it('a fact the cache already holds (terminal wins) is not reported as a fix', async () => {
    applies = false;
    const res = await importWorkerPrFacts([worker({ mergedAt: '2026-04-29T10:00:00Z', prLifecycleStatus: 'merged' })],
      { githubApi: githubApi({ merged_at: '2026-04-29T10:00:00Z', state: 'closed' }), record, importToKernel });
    expect(res.fixes).toEqual([]);
  });

  it('dry run computes fixes from the pure guard and writes nothing', async () => {
    const res = await importWorkerPrFacts([worker(), worker({ id: 'w2', prLifecycleStatus: 'merged', mergedAt: '2026-04-01T00:00:00Z' })],
      { dryRun: true, githubApi: githubApi({ merged_at: '2026-04-29T10:00:00Z', state: 'closed' }), record, importToKernel });
    expect(recorded).toEqual([]);
    expect(res.fixes.map((f) => f.workerId)).toEqual(['w1']);
  });

  it('records unverified when GitHub errors or the workspace has no installation', async () => {
    const res = await importWorkerPrFacts([worker()], { githubApi: githubApi(new Error('Not Found')), record, importToKernel });
    expect(res.unverified).toEqual([{ prUrl: worker().prUrl, reason: 'Not Found' }]);
    workspaceRows = [{ id: 'ws1' }];
    const res2 = await importWorkerPrFacts([worker()], { githubApi: githubApi({ state: 'closed' }), record, importToKernel });
    expect(res2.unverified[0].reason).toContain('no GitHub installation');
    expect(recorded).toEqual([]);
  });
});
