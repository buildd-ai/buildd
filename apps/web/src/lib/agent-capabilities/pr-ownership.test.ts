import { describe, it, expect, mock } from 'bun:test';
import { branchCarriesTaskId, ownershipApplies, prNumbersNamedAtFiling, taskLinksPr, verifyPrOwnership, type PrOwnershipInput } from './pr-ownership';

// ── fixtures (illustrative) ───────────────────────────────────────────────────

const TASK_ID = 'aaaa1111-0000-4000-8000-000000000001';
const PARENT_ID = 'bbbb2222-0000-4000-8000-000000000002';
const DEP_ID = 'cccc3333-0000-4000-8000-000000000003';
const PROTECTED = ['dev', 'main'];

const noLineage = mock(async (_: string) => [] as string[]);
const lineageWithParent = mock(async (_: string) => [PARENT_ID]);

function input(o: Partial<PrOwnershipInput> & { task?: Partial<NonNullable<PrOwnershipInput['task']>> | null } = {}): PrOwnershipInput {
  return {
    head: 'buildd/aaaa1111-fix-thing',
    prNumber: 42,
    workerBranch: 'buildd/aaaa1111-fix-thing',
    protectedBranches: PROTECTED,
    ...o,
    task: o.task === null ? null : { id: TASK_ID, title: 'fix: thing', description: '', context: {}, dependsOn: [], ...o.task },
  };
}

const verify = (i: PrOwnershipInput, lineage = noLineage) => verifyPrOwnership(i, lineage);

// ── allowed shapes ────────────────────────────────────────────────────────────

describe('verifyPrOwnership — shapes a task owns', () => {
  it('own branch', async () => {
    expect(await verify(input())).toEqual({ owned: true, basis: 'own_branch' });
  });

  it('own branch even when it is a protected name (placeholder workers carry the PR’s head)', async () => {
    expect(await verify(input({ head: 'dev', workerBranch: 'dev' }))).toEqual({ owned: true, basis: 'own_branch' });
  });

  it('retry attempt bound to the PR it is fixing', async () => {
    const v = await verify(input({ head: 'buildd/bbbb2222-original', task: { ciRetryPrNumber: 42 } }));
    expect(v).toEqual({ owned: true, basis: 'retry_subject' });
  });

  it.each([
    ['a person', 'human:user-1'],
    ['the task that filed it', 'task:task-0'],
  ])('a PR the task was linked to when %s filed it (context.prReach)', async (_label, grantedBy) => {
    const v = await verify(input({ head: 'docs/human-branch', task: { context: { prReach: { prNumbers: [42], grantedBy, grantedAt: '2026-01-01T00:00:00.000Z' } } } }));
    expect(v).toEqual({ owned: true, basis: 'linked_pr' });
  });

  it('a PR a person granted a landing override on', async () => {
    const v = await verify(input({ head: 'docs/human-branch', task: { context: { landingOverride: { prNumbers: [42], overrides: ['freshness'], grantedBy: 'human:user-1', grantedAt: 'x' } } } }));
    expect(v).toEqual({ owned: true, basis: 'linked_pr' });
  });

  it.each([
    ['title', { title: 'Fix review comments on #42' }],
    ['description', { description: 'Follow up on https://github.com/acme/widget/pull/42 please' }],
    ['context', { context: { prNumber: 42 } }],
    ['an unstamped context.prReach', { context: { prReach: { prNumbers: [42] } } }],
    ['a context.prReach stamped by neither a person nor a task', { context: { prReach: { prNumbers: [42], grantedBy: 'agent:x' } } }],
    ['an unstamped landing override', { context: { landingOverride: { prNumbers: [42], overrides: ['freshness'] } } }],
  ])('does not own a PR merely named in its %s', async (_label, task) => {
    const v = await verify(input({ head: 'docs/human-branch', task }));
    expect(v.owned).toBe(false);
  });

  it('stacked base branch from context', async () => {
    const v = await verify(input({ head: 'buildd/cccc3333-phase-one', task: { context: { baseBranch: 'buildd/cccc3333-phase-one' } } }));
    expect(v).toEqual({ owned: true, basis: 'stacked_base' });
  });

  it('mission shared working branch from context.headBranch', async () => {
    const v = await verify(input({ head: 'mission/shared-abc', task: { context: { headBranch: 'mission/shared-abc' } } }));
    expect(v).toEqual({ owned: true, basis: 'stacked_base' });
  });

  it('a branch of a task this one depends on', async () => {
    const v = await verify(input({ head: 'buildd/cccc3333-predecessor', task: { dependsOn: [DEP_ID] } }));
    expect(v).toEqual({ owned: true, basis: 'depends_on' });
  });

  it('an earlier branch of the same task (a refire cut a new branch name)', async () => {
    const v = await verify(input({ head: 'buildd/aaaa1111-older-title-slug', workerBranch: 'buildd/aaaa1111-new-slug' }));
    expect(v).toEqual({ owned: true, basis: 'task_lineage' });
  });

  it('the branch of a retry ancestor', async () => {
    const v = await verify(input({ head: 'buildd/bbbb2222-original', prNumber: 7 }), lineageWithParent);
    expect(v).toEqual({ owned: true, basis: 'task_lineage' });
  });

  it('walks lineage only when nothing cheaper matched', async () => {
    const lineage = mock(async () => [] as string[]);
    await verify(input(), lineage);
    expect(lineage).not.toHaveBeenCalled();
  });
});

// ── refused shapes ────────────────────────────────────────────────────────────

// A mission task's worker branch is its own generated head; the integration
// branch is only its base. Having the right base proves nothing about a head,
// so a worker that somehow sits on the integration branch itself (provisioned
// before claim stopped handing it out) gets no blanket exception: it owns the
// heads every other worker owns, and nothing else.
describe('verifyPrOwnership — mission task on an integration base', () => {
  const missionTask = { context: { baseBranch: 'mission/integration' } };

  it('owns its generated task head', async () => {
    const v = await verify(input({ head: 'buildd/aaaa1111-fix-thing', task: missionTask }));
    expect(v).toEqual({ owned: true, basis: 'own_branch' });
  });

  it('refuses an unrelated head with no task id, even when no other worker holds it', async () => {
    const v = await verify(input({ head: 'task/no-id-in-name', task: missionTask, otherHeadHolders: [] }));
    expect(v).toMatchObject({ owned: false, reasonCode: 'head_not_owned' });
  });

  it('a worker sitting on the integration branch itself gains no ownership of other heads', async () => {
    const onBase = (head: string) => input({ head, workerBranch: 'mission/integration', task: missionTask, otherHeadHolders: [] });
    expect(await verify(onBase('task/no-id-in-name'))).toMatchObject({ owned: false, reasonCode: 'head_not_owned' });
    expect(await verify(onBase('buildd/dddd4444-someone-else'))).toMatchObject({ owned: false, reasonCode: 'head_not_owned' });
  });

  it('a worker sitting on the integration branch still owns a head carrying its own task id', async () => {
    const v = await verify(input({ head: 'buildd/aaaa1111-cut', workerBranch: 'mission/integration', task: missionTask }));
    expect(v).toEqual({ owned: true, basis: 'task_lineage' });
  });
});

describe('verifyPrOwnership — refused', () => {
  it('another, unrelated task’s branch', async () => {
    const v = await verify(input({ head: 'buildd/dddd4444-someone-else', prNumber: 9 }));
    expect(!v.owned && v.reasonCode).toBe('head_not_owned');
  });

  it('a protected head that is not the worker’s own branch', async () => {
    const v = await verify(input({ head: 'dev' }));
    expect(!v.owned && v.reasonCode).toBe('protected_head');
  });

  it('a protected head even when the task names the PR (naming a release PR does not make it the deliverable)', async () => {
    const v = await verify(input({ head: 'main', task: { title: 'unblock release #42' } }));
    expect(!v.owned && v.reasonCode).toBe('protected_head');
  });

  it('a protected head even for a retry bound to that PR', async () => {
    const v = await verify(input({ head: 'dev', task: { ciRetryPrNumber: 42 } }));
    expect(!v.owned && v.reasonCode).toBe('protected_head');
  });

  it('a human branch the task does not name', async () => {
    const v = await verify(input({ head: 'feat/someone-else', prNumber: 5 }));
    expect(!v.owned && v.reasonCode).toBe('head_not_owned');
  });

  it('a different head with no task to check against', async () => {
    const v = await verify(input({ head: 'buildd/dddd4444-x', task: null }));
    expect(v.owned).toBe(false);
  });

  it('carries a reason a worker can act on', async () => {
    const v = await verify(input({ head: 'buildd/dddd4444-someone-else' }));
    expect(!v.owned && v.error).toContain("Open the PR from the task's own branch");
  });
});

describe('verifyPrOwnership — interactive session, custom head', () => {
  it('a head nobody else holds', async () => {
    const v = await verify(input({ head: 'ci/private-prompt-evals', interactiveWorker: true, otherHeadHolders: [] }));
    expect(v).toEqual({ owned: true, basis: 'interactive_head' });
  });

  it('refused when a live worker on another task already sits on that branch', async () => {
    const v = await verify(input({
      head: 'ci/private-prompt-evals',
      interactiveWorker: true,
      otherHeadHolders: [{ workerId: 'w-1', taskId: 'other-task-id', status: 'running', hasPr: false }],
    }));
    expect(v.owned).toBe(false);
    expect(!v.owned && v.reasonCode).toBe('head_claimed');
    expect(!v.owned && v.error).toContain('other-task-id'.slice(0, 8));
  });

  it('refused when a dead worker on another task already has its own PR on that branch', async () => {
    const v = await verify(input({
      head: 'ci/private-prompt-evals',
      interactiveWorker: true,
      otherHeadHolders: [{ workerId: 'w-1', taskId: 'other-task-id', status: 'completed', hasPr: true }],
    }));
    expect(!v.owned && v.reasonCode).toBe('head_claimed');
  });

  it('allowed when the only other holder is a dead worker on the SAME task with no PR of its own', async () => {
    const v = await verify(input({
      head: 'ci/private-prompt-evals',
      interactiveWorker: true,
      otherHeadHolders: [{ workerId: 'w-1', taskId: TASK_ID, status: 'completed', hasPr: false }],
    }));
    expect(v).toEqual({ owned: true, basis: 'interactive_head' });
  });

  it('allowed when the only other holder is dead, on a different task, and never shipped a PR', async () => {
    const v = await verify(input({
      head: 'ci/private-prompt-evals',
      interactiveWorker: true,
      otherHeadHolders: [{ workerId: 'w-1', taskId: 'other-task-id', status: 'failed', hasPr: false }],
    }));
    expect(v).toEqual({ owned: true, basis: 'interactive_head' });
  });

  it('a non-interactive worker still refuses the same unmatched head as head_not_owned', async () => {
    const v = await verify(input({ head: 'ci/private-prompt-evals', otherHeadHolders: [] }));
    expect(!v.owned && v.reasonCode).toBe('head_not_owned');
  });

  it('a protected head is refused even for an interactive worker with a free name', async () => {
    const v = await verify(input({ head: 'dev', interactiveWorker: true, otherHeadHolders: [] }));
    expect(!v.owned && v.reasonCode).toBe('protected_head');
  });
});

describe('branchCarriesTaskId', () => {
  it.each([
    ['buildd/aaaa1111-slug', true],
    ['task-aaaa1111', true],
    ['feat/aaaa1111-slug', true],
    ['buildd/xaaaa1111-slug', false],
    ['buildd/aaaa11112-slug', false],
  ])('%s → %s', (branch, want) => {
    expect(branchCarriesTaskId(branch, TASK_ID)).toBe(want);
  });

  it('never matches on a non-hex id', () => {
    expect(branchCarriesTaskId('buildd/external-x', 'external-x-y')).toBe(false);
  });
});

describe('ownershipApplies', () => {
  const run = { kind: 'agent_run' as const, principal: {} as any };
  it('binds an agent run', () => expect(ownershipApplies(run, {})).toBe(true));
  it('exempts a person’s session on the shared account', () => expect(ownershipApplies(run, { sessionUserId: 'user-1' })).toBe(false));
  it('exempts a teammate', () => expect(ownershipApplies({ kind: 'team_member', accountId: 'a' }, {})).toBe(false));
});


describe('taskLinksPr — a task reaches the PRs its own records link it to', () => {
  const task = (o: Record<string, unknown> = {}) => ({ id: TASK_ID, title: '', description: '', context: {}, ...o });
  const reach = (grantedBy: string, prNumbers = [42]) => ({ prReach: { prNumbers, grantedBy, grantedAt: 'x' } });

  it.each([
    ['ciRetryPrNumber', { ciRetryPrNumber: 42 }],
    ['conflictRetryPrNumber', { conflictRetryPrNumber: 42 }],
    ['reviewerRetryPrNumber', { reviewerRetryPrNumber: 42 }],
    ['a person-stamped prReach', { context: reach('human:user-1') }],
    ['a task-stamped prReach', { context: reach('task:task-0') }],
    ['a person-stamped landing override', { context: { landingOverride: { prNumbers: [42], overrides: ['size'], grantedBy: 'human:user-1', grantedAt: 'x' } } }],
  ])('links through %s', (_l, o) => {
    expect(taskLinksPr(task(o), 42)).toBe(true);
  });

  it.each([
    ['title', { title: 'land PR #42' }],
    ['description', { description: 'resolve conflicts on https://github.com/acme/widget/pull/42' }],
    ['a context scalar', { context: { prNumber: 42 } }],
    ['a prReach with no stamp', { context: { prReach: { prNumbers: [42] } } }],
    ['a prReach with a foreign stamp', { context: reach('agent:x') }],
    ['a prReach for another PR', { context: reach('human:user-1', [7]) }],
  ])('does not link through %s', (_l, o) => {
    expect(taskLinksPr(task(o), 42)).toBe(false);
  });

  it('no task links nothing', () => {
    expect(taskLinksPr(null, 42)).toBe(false);
  });
});

describe('prNumbersNamedAtFiling', () => {
  it('collects #N and /pull/N from title and description, and context.prNumber / prNumbers', () => {
    expect(prNumbersNamedAtFiling({
      title: 'land #42 and #7',
      description: 'see https://github.com/acme/widget/pull/9; not #420x',
      context: { prNumber: 11, prNumbers: [12, 'x', 13], priority: 5 },
    })).toEqual([7, 9, 11, 12, 13, 42, 420]);
  });
  it('ignores other context scalars', () => {
    expect(prNumbersNamedAtFiling({ title: '', description: null, context: { priority: 5, iteration: 2 } })).toEqual([]);
  });
});
