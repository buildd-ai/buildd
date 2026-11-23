/**
 * A PR opened in a linked repo by someone outside buildd (a person, or an agent
 * running `gh pr create`) asks for buildd's own review when the workspace opts in
 * (`gitConfig.mergePolicy.autoReviewUnowned`), so it does not sit on
 * "Review not requested" forever. Everything here is injected; no DB, no GitHub.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isBuilddBranch, isForeignPr, knownWorkerWhere, maybeAutoReviewUnownedPr, type AutoReviewDeps, type AutoReviewWorkspace } from './auto-review-unowned';

const ws = (over: Partial<AutoReviewWorkspace> = {}): AutoReviewWorkspace => ({
  id: 'ws-a', teamId: 'team-a', name: 'repo', repo: 'org/repo',
  githubRepoId: 'gr-1', githubInstallationId: 'gi-1',
  gitConfig: { defaultBranch: 'dev', mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } },
  webhookConfig: null, releaseConfig: null,
  ...over,
});

const pr = (over: Record<string, unknown> = {}) => ({
  number: 42, draft: false, state: 'open', title: 'Fix a thing', body: 'why', html_url: 'https://github.com/org/repo/pull/42',
  user: { login: 'someone', type: 'User' },
  head: { sha: 'abc1234def', ref: 'fix/thing', repo: { full_name: 'org/repo' } },
  base: { ref: 'dev', repo: { full_name: 'org/repo' } },
  ...over,
});

let request: ReturnType<typeof mock>;
let deps: AutoReviewDeps;
let reviewed: Set<number>;

beforeEach(() => {
  reviewed = new Set();
  request = mock(async (p: { prNumber: number }) => {
    // The real request path adopts the PR and files its reviewer: a second look finds it.
    reviewed.add(p.prNumber);
    return { kind: 'json' as const, status: 201, body: { ok: true, reviewTaskId: 'rt-1' } };
  });
  deps = {
    linkedWorkspaces: async () => [ws()],
    reviews: async () => ({
      isCandidate: () => false,
      mayBeCandidate: (_c, refs) => refs.headRef?.startsWith('release/') ?? false,
    }),
    kernelOwned: async () => false,
    knownWorker: async (_ids, n) => (reviewed.has(n) ? { id: 'w-adopted' } : null),
    reviewTask: async (_w, n) => (reviewed.has(n) ? { id: 'rt-1', status: 'pending' } : null),
    integrationBase: async (_w, base) => base === 'mission/thing-1234abcd',
    request: request as unknown as AutoReviewDeps['request'],
  };
});

const run = (over: { action?: string; pr?: Record<string, unknown>; defaultBranch?: string | null } = {}) =>
  maybeAutoReviewUnownedPr({
    action: over.action ?? 'opened', installationId: 7, repoFullName: 'org/repo',
    defaultBranch: over.defaultBranch === undefined ? 'dev' : over.defaultBranch,
    pr: (over.pr ?? pr()) as never,
  }, deps);

describe('maybeAutoReviewUnownedPr: opted in', () => {
  it('requests a buildd review once for an ordinary PR', async () => {
    expect(await run()).toBe('requested');
    expect(request).toHaveBeenCalledTimes(1);
    const p = (request.mock.calls[0] as any[])[0];
    expect(p.prNumber).toBe(42);
    expect(p.workspace.id).toBe('ws-a');
    expect(p.repo).toEqual({ fullName: 'org/repo', installationId: 7 });
    // buildd's own sweep, never a person: it may not force a re-review.
    expect(p.force).toBe(false);
    expect(p.requester.actor).toMatch(/^system:/);
    expect(p.requester.principal).toEqual({ kind: 'system', id: expect.stringMatching(/^system:/) });
    expect(p.requester.creationSource).toBe('webhook');
    expect(p.requester.accountId).toBeNull();
    expect(p.requester.teamId).toBe('team-a');
  });

  for (const action of ['opened', 'reopened', 'ready_for_review', 'synchronize']) {
    it(`runs on ${action}`, async () => {
      expect(await run({ action })).toBe('requested');
    });
  }

  it('ignores every other action', async () => {
    for (const action of ['closed', 'edited', 'converted_to_draft', 'labeled']) {
      expect(await run({ action })).toBe('skipped_action');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('a duplicate webhook (re-delivery) requests nothing new', async () => {
    expect(await run()).toBe('requested');
    expect(await run()).toBe('skipped_known');
    expect(await run({ action: 'synchronize' })).toBe('skipped_known');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('a mission integration branch is a base the normal flow targets', async () => {
    expect(await run({ pr: pr({ base: { ref: 'mission/thing-1234abcd' } }) })).toBe('requested');
  });

  it('falls back to the repo default branch when the workspace names none', async () => {
    deps.linkedWorkspaces = async () => [ws({ gitConfig: { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } } })];
    expect(await run({ defaultBranch: 'dev' })).toBe('requested');
  });

  it('a request the review path answers as already requested is reported as such', async () => {
    deps.request = (async () => ({ kind: 'json' as const, status: 200, body: { ok: true, alreadyRequested: true } })) as never;
    expect(await run()).toBe('already_requested');
  });

  it('a request the review path refuses is reported, not thrown', async () => {
    deps.request = (async () => ({ kind: 'json' as const, status: 400, body: { error: 'No reviewer role available' } })) as never;
    expect(await run()).toBe('refused');
  });
});

describe('maybeAutoReviewUnownedPr: never requested', () => {
  it('a draft PR', async () => {
    expect(await run({ pr: pr({ draft: true }) })).toBe('skipped_draft');
    expect(request).not.toHaveBeenCalled();
  });

  it('a bot\'s PR, by login or by account type', async () => {
    expect(await run({ pr: pr({ user: { login: 'renovate[bot]', type: 'Bot' } }) })).toBe('skipped_bot');
    expect(await run({ pr: pr({ user: { login: 'some-app', type: 'Bot' } }) })).toBe('skipped_bot');
    expect(request).not.toHaveBeenCalled();
  });

  it('a release candidate', async () => {
    deps.reviews = async () => ({ isCandidate: () => true, mayBeCandidate: () => true });
    expect(await run()).toBe('skipped_candidate');
    expect(request).not.toHaveBeenCalled();
  });

  it('a possible release candidate (candidate-shaped branches)', async () => {
    expect(await run({ pr: pr({ head: { sha: 'abc1234def', ref: 'release/v1.2.3' } }) })).toBe('skipped_candidate');
    expect(request).not.toHaveBeenCalled();
  });

  it('a PR a kernel delivery owns', async () => {
    deps.kernelOwned = async () => true;
    expect(await run()).toBe('skipped_known');
    expect(request).not.toHaveBeenCalled();
  });

  it('a known-but-unreviewed PR: a buildd worker owns it (its own PR, or one adopted earlier)', async () => {
    deps.knownWorker = async () => ({ id: 'w-1' });
    expect(await run()).toBe('skipped_known');
    expect(request).not.toHaveBeenCalled();
  });

  it('a PR that already has a buildd review, in flight or finished', async () => {
    deps.reviewTask = async () => ({ id: 'rt-0', status: 'completed' });
    expect(await run()).toBe('skipped_known');
    expect(request).not.toHaveBeenCalled();
  });

  it('a known-but-unreviewed PR: a worker row maps its head branch (no PR number recorded yet)', async () => {
    deps.knownWorker = async (_ids, _n, headRef) => (headRef === 'fix/thing' ? { id: 'w-branch' } : null);
    expect(await run()).toBe('skipped_known');
    expect(request).not.toHaveBeenCalled();
  });

  it('a known-but-unreviewed PR: a buildd task branch or a mission branch, with no row found', async () => {
    for (const ref of ['buildd/1234abcd-fix-thing', 'task-1234abcd', 'mission/ship-it-1234abcd']) {
      expect(await run({ pr: pr({ head: { sha: 'abc1234def', ref } }) })).toBe('skipped_known');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('a PR onto a base the normal flow does not target', async () => {
    expect(await run({ pr: pr({ base: { ref: 'some-feature' } }) })).toBe('skipped_base');
    expect(request).not.toHaveBeenCalled();
  });

  it('a repo no workspace links', async () => {
    deps.linkedWorkspaces = async () => [];
    expect(await run()).toBe('skipped_unlinked');
  });
});

describe('maybeAutoReviewUnownedPr: opt-in off', () => {
  it('explicitly off under agent-review: unchanged behaviour, nothing requested', async () => {
    deps.linkedWorkspaces = async () => [ws({ gitConfig: { defaultBranch: 'dev', mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' }, autoReviewUnowned: false } } })];
    expect(await run()).toBe('skipped_off');
    expect(request).not.toHaveBeenCalled();
  });

  it('defaults off for any tier other than agent-review', async () => {
    deps.linkedWorkspaces = async () => [ws({ gitConfig: { defaultBranch: 'dev', mergePolicy: { tier: 'human' } } })];
    expect(await run()).toBe('skipped_off');
    deps.linkedWorkspaces = async () => [ws({ gitConfig: { defaultBranch: 'dev' } })];
    expect(await run()).toBe('skipped_off');
    expect(request).not.toHaveBeenCalled();
  });

  it('explicitly on under a human tier requests a review', async () => {
    deps.linkedWorkspaces = async () => [ws({ gitConfig: { defaultBranch: 'dev', mergePolicy: { tier: 'human', autoReviewUnowned: true } } })];
    expect(await run()).toBe('requested');
  });

  it('only the repo\'s primary workspace (the one the status reads) decides', async () => {
    deps.linkedWorkspaces = async () => [
      ws({ id: 'ws-a', gitConfig: { defaultBranch: 'dev', mergePolicy: { tier: 'human' } } }),
      ws({ id: 'ws-b' }),
    ];
    expect(await run()).toBe('skipped_off');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('isBuilddBranch', () => {
  it("knows buildd's task and mission branch shapes, and the workspace branchPrefix", () => {
    expect(isBuilddBranch('buildd/1234abcd-a-title')).toBe(true);
    expect(isBuilddBranch('task-1234abcd')).toBe(true);
    expect(isBuilddBranch('mission/thing-1234abcd')).toBe(true);
    expect(isBuilddBranch('bot/1234abcd-a-title', [{ branchPrefix: 'bot/' }])).toBe(true);
    expect(isBuilddBranch('fix/thing')).toBe(false);
    expect(isBuilddBranch('buildd/not-an-id')).toBe(false);
    expect(isBuilddBranch(null)).toBe(false);
  });
});

describe('knownWorkerWhere: which worker rows make a PR known', () => {
  const render = (headRef: string | null) => {
    const q = new PgDialect().sqlToQuery(knownWorkerWhere(['ws-a'], 5999, headRef));
    return { sql: q.sql.replace(/[()]/g, '').replace(/\s+/g, ' '), params: q.params };
  };

  it('a worker with this PR number', () => {
    const { sql, params } = render(null);
    expect(sql).toContain('"pr_number" = $');
    expect(sql).not.toContain('"branch"');
    expect(params).toContain(5999);
  });

  // Regression: Renovate reuses one head branch per package for every update
  // (renovate/openai-codex-sdk-0.x has carried many PRs). A worker left from an
  // earlier, adopted PR on that branch made each later PR "known", so it got a
  // pending "Review not requested" status nobody would ever clear, and
  // Renovate's automerge waited on it forever.
  it('a head-branch match counts only for a worker with no PR number yet, never one that recorded another PR', () => {
    const { sql, params } = render('renovate/openai-codex-sdk-0.x');
    expect(sql).toMatch(/"branch" = \$\d+ and "workers"\."pr_number" is null/);
    expect(params).toContain('renovate/openai-codex-sdk-0.x');
  });
});

describe('knownWorkerWhere: repo scope', () => {
  it('a PR-number match is confined to the PR\'s own repo through the worker\'s PR url', () => {
    const q = new PgDialect().sqlToQuery(knownWorkerWhere(['ws-a'], 5999, null, 'Acme/Widgets'));
    expect(q.sql.replace(/\s+/g, ' ')).toContain('lower("workers"."pr_url") LIKE');
    expect(q.params).toContain('%/acme/widgets/pull/%');
  });
});

describe('isForeignPr: a dependency bot reusing a branch', () => {
  const base = { workspaces: [{ id: 'ws-a' }], repoFullName: 'acme/widgets', prNumber: 6000, headRef: 'renovate/thing-1.x' };
  // Mirrors knownWorkerWhere: only a worker on the branch with no PR number yet counts.
  const rows = [{ branch: 'renovate/thing-1.x', prNumber: 5999 }];
  const knownWorker = async (_i: string[], n: number, ref: string | null) =>
    rows.find((r) => r.prNumber === n || (r.branch === ref && r.prNumber == null)) ?? null;

  it('a prior worker on the same branch with a different PR number leaves the new PR foreign', async () => {
    expect(await isForeignPr(base, { knownWorker, kernelOwned: async () => false, reviewTask: async () => null })).toBe(true);
  });

  it('the same worker with this PR number makes it known', async () => {
    expect(await isForeignPr({ ...base, prNumber: 5999 }, { knownWorker, kernelOwned: async () => false, reviewTask: async () => null })).toBe(false);
  });
});
