/**
 * §13.13 rule 3 for the kernel's CI fix (`ciFixWork`): an executable builder,
 * pinned to the PR head GitHub reports, never a copy of a coordination owner's
 * brief or its missing role.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let owner: Record<string, unknown> = {};
let inherited: Record<string, unknown> = {};
let pull: unknown = null;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: async () => owner },
      missions: { findFirst: async () => null },
      workspaces: { findFirst: async () => ({ id: 'w1', teamId: 't1' }) },
      workers: { findFirst: async () => ({ id: 'wk1', branch: 'buildd/owner-branch', prUrl: 'https://github.com/acme/w/pull/7', prNumber: 7 }) },
    },
  },
}));
const activity: unknown[] = [];
mock.module('./github-facts', () => ({ workspaceRepo: async () => ({ installationId: 1, repoFullName: 'acme/w', gitConfig: null }) }));
mock.module('@/lib/github', () => ({ githubApi: async (_i: number, path: string) => (path === '/repos/acme/w/pulls/7' ? pull : null) }));
mock.module('@/lib/ci-failure-inspect', () => ({ fetchCIFailureLogs: async () => ({ summary: 'build failed', failedJobNames: ['build'], runId: 1, failedJobId: 2, runUrl: 'u' }) }));
mock.module('@/lib/attempt-identity', () => ({ inheritAttemptIdentity: async () => inherited }));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: async (a: unknown) => { activity.push(a); }, taskActivityUrl: (id: string) => `u/${id}` }));
mock.module('@/lib/ci-job-log-evidence', () => ({ captureCiJobLogEvidence: async () => ({ status: 'skipped' }) }));
mock.module('@/lib/ci-failure-retry', () => ({ escalateCiRedHead: async () => undefined }));

const { ciFixWork } = await import('./ci-retry-effects');

const req = () => ({
  role: 'ci_fix', workspaceId: 'w1', taskId: 'ci-task-1',
  target: { repoFullName: 'acme/w', prNumber: 7, headSha: 'H1', baseRef: 'dev' },
  lineage: { deliveryId: 'd1', attemptId: 'a1', parentTaskId: 'owner-1' },
  dedupeKey: 'ci:a1', detail: { attemptNo: 1, maxAttempts: 3, firstAtHead: true },
});

beforeEach(() => {
  owner = { id: 'owner-1', title: 'Ship it', description: 'Build the widget.', workspaceId: 'w1', missionId: null, context: {}, kind: 'engineering', category: 'feature' };
  inherited = { roleSlug: 'builder-plus', kind: 'engineering', complexity: null, missionPhaseIndex: null, missionPhaseLabel: null };
  pull = { head: { ref: 'mission/m-1' }, base: { ref: 'dev' } };
});

describe('ciFixWork (rule 3)', () => {
  test('pinned to the PR head GitHub reports: repairTarget and the resume branch name it', async () => {
    const b = await ciFixWork(req() as never) as { values: Record<string, any> };
    expect(b.values.context).toMatchObject({ resumeBranch: 'mission/m-1', repairTarget: { prNumber: 7, headRef: 'mission/m-1', baseRef: 'dev' } });
    expect(b.values.roleSlug).toBe('builder-plus');
    expect(b.values.description).toContain('Build the widget.');
  });
  test('a coordination owner: a builder role, engineering, and never its "no work" brief', async () => {
    owner = { ...owner, description: 'It performs no work of its own.', kind: 'coordination' };
    inherited = { ...inherited, roleSlug: null, kind: 'coordination' };
    const b = await ciFixWork(req() as never) as { values: Record<string, any> };
    expect(b.values).toMatchObject({ roleSlug: 'builder', kind: 'engineering' });
    expect(b.values.description).not.toContain('performs no work');
  });
  test('an owner with no role still gets a builder', async () => {
    inherited = { ...inherited, roleSlug: null };
    const b = await ciFixWork(req() as never) as { values: Record<string, any> };
    expect(b.values.roleSlug).toBe('builder');
  });
  // e2ea3764: filed on the worker row's branch, the fix found it missing on the remote and started from dev.
  test('an unreadable PR files nothing (the effect retries), never a fix resuming the worker row\'s branch', async () => {
    pull = null;
    await expect(ciFixWork(req() as never)).rejects.toThrow(/head branch is unreadable/);
    pull = { base: { ref: 'dev' } };
    await expect(ciFixWork(req() as never)).rejects.toThrow(/head branch is unreadable/);
  });
  test('the activity entry numbers the fix by the dispatched count the kernel hands it (a skipped row in front), never past the budget', async () => {
    activity.length = 0;
    const r = { ...req(), detail: { attemptNo: 3, maxAttempts: 3, firstAtHead: false } };
    const b = await ciFixWork(r as never) as { afterFile: (row: { id: string }) => Promise<void> };
    await b.afterFile({ id: 'ci-task-1' });
    expect(activity[0]).toMatchObject({ entry: { kind: 'ci_fixing', iteration: 3, maxIterations: 3 } });
  });
});
